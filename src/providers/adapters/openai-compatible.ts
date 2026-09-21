/**
 * OpenAI-compatible Chat Completions adapter (specification section 15).
 *
 * Targets any endpoint implementing `POST /v1/chat/completions` with the
 * OpenAI request/response shape: OpenAI itself, Azure-style gateways, vLLM,
 * Ollama's compatibility layer, OpenRouter, LM Studio and similar.
 *
 * Deliberate constraints:
 *  - Authentication is API key only, supplied by the user. The adapter never
 *    reads cookies, scrapes a web session, or infers entitlement from a
 *    consumer subscription (specification sections 3.3 and 15).
 *  - The endpoint is *not* labelled "OpenAI" unless the user pointed it at
 *    OpenAI. It is reported by its base URL.
 *  - Capabilities are advertised conservatively; the capability doctor is the
 *    authority on what the endpoint can actually do.
 */
import { getLogger } from '@/logging/logger';
import { createError } from '@/types/result';
import { providerFailure, type ProviderFailure } from '@/providers/core/provider-error';
import {
  categoryForStatus,
  parseJsonBody,
  readErrorBody,
  readServerSentEvents,
  requireEgress,
  retryAfterMs,
  toNetworkError,
  toThrowable,
} from '@/providers/core/provider-http';
import { checkCapabilities } from '@/providers/core/capability-guard';
import {
  managementContext,
  refusingTransport,
  type ProviderTransport,
} from '@/security/egress/provider-transport';
import { generateTaintSalt } from '@/tasks/task-model';
import type {
  AIProviderAdapter,
  AuthResult,
  CanonicalContent,
  CanonicalEvent,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalToolCall,
  HealthResult,
  ModelCapabilities,
  ModelInfo,
  ProviderConfig,
  ProviderFactory,
} from '@/providers/core/types';

const log = getLogger('provider');

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Wire types for the subset of the Chat Completions API this adapter uses. */
interface WireToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | null;
  tool_calls?: WireToolCall[];
}

interface WireChoice {
  message?: WireMessage;
  delta?: WireMessage;
  finish_reason?: string | null;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface WireCompletion {
  choices?: WireChoice[];
  usage?: WireUsage;
  model?: string;
  id?: string;
}

interface WireModelList {
  data?: { id?: string }[];
}

/** Models known to accept image parts. Used only as an advertised default. */
const VISION_MODEL_HINTS = ['gpt-4o', 'gpt-4.1', 'gpt-5', 'o3', 'o4', 'vision', 'llava', 'qwen-vl'];

export class OpenAICompatibleAdapter implements AIProviderAdapter {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  readonly displayName = 'OpenAI-compatible endpoint';
  readonly kind = 'api' as const;
  readonly authKind = 'api_key' as const;

  private config: ProviderConfig | null = null;

  /**
   * A transport, not a `fetch`.
   *
   * The registry supplies a guarded one; the default refuses. There is no
   * constructor path that yields direct network access, which is what makes
   * "every provider request passes the gate" a property of construction
   * rather than of remembering.
   */
  private readonly managementSalt = generateTaintSalt();

  constructor(private readonly transport: ProviderTransport = refusingTransport()) {}

  connect(config: ProviderConfig): Promise<AuthResult> {
    if (!config.baseUrl || config.baseUrl.trim().length === 0) {
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'A base URL is required.', {
          userMessage: 'Enter the endpoint base URL, for example https://api.openai.com/v1.',
        }),
      });
    }
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      return Promise.resolve({
        authenticated: false,
        error: createError('AUTH_REQUIRED', 'An API key is required.', {
          userMessage: 'Enter an API key issued by this provider.',
        }),
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(config.baseUrl);
    } catch {
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'The base URL is not a valid URL.'),
      });
    }
    if (
      parsed.protocol !== 'https:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'The base URL must use https.', {
          userMessage:
            'API keys are only sent over https. Use an https endpoint, or localhost for a local model server.',
        }),
      });
    }

    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/+$/, '') };
    // Credentials are never logged; the masked suffix is for UI identification.
    return Promise.resolve({
      authenticated: true,
      accountLabel: `${parsed.host} (key …${config.apiKey.slice(-4)})`,
    });
  }

  disconnect(): Promise<void> {
    this.config = null;
    return Promise.resolve();
  }

  private require(): ProviderConfig {
    if (!this.config) {
      throw new Error('This provider is not connected. Call connect() first.');
    }
    return this.config;
  }

  private headers(): Record<string, string> {
    const config = this.require();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey ?? ''}`,
    };
    if (config.organization) headers['OpenAI-Organization'] = config.organization;
    if (config.project) headers['OpenAI-Project'] = config.project;
    return { ...headers, ...(config.extraHeaders ?? {}) };
  }

  async listModels(): Promise<ModelInfo[]> {
    const config = this.require();
    try {
      const response = await this.transport.request(
        `${config.baseUrl ?? ''}/models`,
        {
          method: 'GET',
          headers: this.headers(),
          signal: AbortSignal.timeout(20_000),
        },
        managementContext(OPENAI_COMPATIBLE_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        // Many compatible servers do not implement /models. That is not fatal.
        log.debug('Endpoint did not return a model list.', { status: response.status });
        return [];
      }
      const body = (await response.json()) as WireModelList;
      return (body.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({
          id,
          displayName: id,
          advertisedCapabilities: { vision: looksVisionCapable(id) },
        }));
    } catch (error) {
      log.debug('Model list request failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Advertised capabilities.
   *
   * Streaming and tool calling are part of the Chat Completions contract, so
   * they are advertised as available; the capability doctor verifies whether
   * this particular endpoint honours them.
   */
  getCapabilities(model: string): Promise<ModelCapabilities> {
    return Promise.resolve(capabilitiesFor(model));
  }

  async validateConnection(): Promise<HealthResult> {
    const config = this.require();
    const started = Date.now();
    try {
      // A minimal completion is the only universally supported probe: some
      // gateways implement /chat/completions but not /models.
      const response = await this.transport.request(
        `${config.baseUrl ?? ''}/chat/completions`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(30_000),
        },
        managementContext(OPENAI_COMPATIBLE_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        return { reachable: false, error: (await toHttpFailure(response)).error };
      }
      return { reachable: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        reachable: false,
        error: toNetworkError(OPENAI_COMPATIBLE_PROVIDER_ID, error, '/chat/completions').error,
      };
    }
  }

  async generate(request: CanonicalRequest): Promise<CanonicalResponse> {
    const config = this.require();
    const unsupported = this.unsupported(request, false);
    if (unsupported) throw toThrowable(unsupported);
    const body = this.buildBody(request, false);

    let response: Response;
    try {
      response = await this.transport.request(
        `${config.baseUrl ?? ''}/chat/completions`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: request.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
        requireEgress(request),
      );
    } catch (error) {
      throw toThrowable(toNetworkError(OPENAI_COMPATIBLE_PROVIDER_ID, error, '/chat/completions'));
    }

    if (!response.ok) {
      throw toThrowable(await toHttpFailure(response));
    }

    const completion = await parseJsonBody<WireCompletion>(OPENAI_COMPATIBLE_PROVIDER_ID, response);
    return parseCompletion(completion);
  }

  async *stream(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const config = this.require();
    const unsupported = this.unsupported(request, true);
    if (unsupported) {
      yield { type: 'error', error: unsupported.error };
      return;
    }
    const body = this.buildBody(request, true);

    let response: Response;
    try {
      response = await this.transport.request(
        `${config.baseUrl ?? ''}/chat/completions`,
        {
          method: 'POST',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          signal: request.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
        requireEgress(request),
      );
    } catch (error) {
      yield {
        type: 'error',
        error: toNetworkError(OPENAI_COMPATIBLE_PROVIDER_ID, error, '/chat/completions').error,
      };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', error: (await toHttpFailure(response)).error };
      return;
    }
    if (!response.body) {
      yield { type: 'error', error: createError('MODEL_ERROR', 'The stream had no body.') };
      return;
    }

    const accumulator = new StreamAccumulator();

    for await (const data of readServerSentEvents(response.body)) {
      if (data === '[DONE]') break;
      let chunk: WireCompletion;
      try {
        chunk = JSON.parse(data) as WireCompletion;
      } catch {
        // A malformed frame is skipped rather than killing the stream.
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        accumulator.appendText(delta.content);
        yield { type: 'text_delta', delta: delta.content };
      }
      if (delta?.tool_calls) accumulator.appendToolCalls(delta.tool_calls);

      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) accumulator.setFinishReason(finish);
      if (chunk.usage) {
        accumulator.setUsage(chunk.usage);
        yield {
          type: 'usage',
          usage: {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          },
        };
      }
    }

    const final = accumulator.finish();
    for (const toolCall of final.toolCalls) {
      yield { type: 'tool_call', toolCall };
    }
    yield { type: 'done', response: final };
  }

  /**
   * Refuses a capability this model does not have, rather than dropping it.
   *
   * Checked before the body is built, so an unsupported feature can never be
   * lost between the canonical request and the wire request.
   */
  private unsupported(request: CanonicalRequest, streaming: boolean): ProviderFailure | null {
    const model = this.require().model ?? '';
    return checkCapabilities(
      OPENAI_COMPATIBLE_PROVIDER_ID,
      model,
      request,
      capabilitiesFor(model),
      streaming,
    );
  }

  private buildBody(request: CanonicalRequest, stream: boolean): Record<string, unknown> {
    const config = this.require();
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: request.systemInstruction },
      ...request.messages.flatMap(toWireMessages),
    ];

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    return body;
  }
}

/**
 * Advertised capabilities for a model on this endpoint.
 *
 * Streaming, tool calling and a system message are part of the Chat
 * Completions contract, so they are advertised as available; the capability
 * doctor verifies whether this particular endpoint honours them. Model
 * listing is advertised because `/models` is part of the same contract, even
 * though many compatible servers omit it.
 */
function capabilitiesFor(model: string): ModelCapabilities {
  return {
    text: true,
    streaming: true,
    toolCalling: true,
    parallelToolCalling: true,
    vision: looksVisionCapable(model),
    structuredOutput: true,
    fileInput: false,
    audioInput: false,
    systemInstruction: true,
    modelListing: true,
    contextWindow: null,
    maxOutputTokens: null,
  };
}

function looksVisionCapable(model: string): boolean {
  const lower = model.toLowerCase();
  return VISION_MODEL_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Converts one canonical message into wire messages.
 *
 * Tool results become separate `role: "tool"` entries, which is what the Chat
 * Completions schema requires; a single canonical message can therefore expand
 * into several wire messages.
 */
function toWireMessages(message: CanonicalMessage): Record<string, unknown>[] {
  const toolResults = message.content.filter(
    (part): part is Extract<CanonicalContent, { type: 'tool_result' }> =>
      part.type === 'tool_result',
  );
  if (toolResults.length > 0) {
    return toolResults.map((part) => ({
      role: 'tool',
      tool_call_id: part.toolCallId,
      content: part.content,
    }));
  }

  const toolCalls = message.content.filter(
    (part): part is Extract<CanonicalContent, { type: 'tool_call' }> => part.type === 'tool_call',
  );
  const textParts = message.content.filter(
    (part): part is Extract<CanonicalContent, { type: 'text' }> => part.type === 'text',
  );
  const imageParts = message.content.filter(
    (part): part is Extract<CanonicalContent, { type: 'image' }> => part.type === 'image',
  );

  if (toolCalls.length > 0) {
    return [
      {
        role: 'assistant',
        content: textParts.map((p) => p.text).join('\n') || null,
        tool_calls: toolCalls.map((call) => ({
          id: call.toolCallId,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
    ];
  }

  if (imageParts.length > 0) {
    return [
      {
        role: message.role,
        content: [
          ...textParts.map((part) => ({ type: 'text', text: part.text })),
          ...imageParts.map((part) => ({
            type: 'image_url',
            image_url: { url: `data:${part.mimeType};base64,${part.data}` },
          })),
        ],
      },
    ];
  }

  return [{ role: message.role, content: textParts.map((p) => p.text).join('\n') }];
}

function parseToolCall(raw: WireToolCall, index: number): CanonicalToolCall {
  const name = raw.function?.name ?? '';
  const rawArgs = raw.function?.arguments ?? '';
  const id = raw.id ?? `call_${index}`;

  if (rawArgs.trim().length === 0) {
    return { toolCallId: id, name, arguments: {} };
  }
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        toolCallId: id,
        name,
        arguments: {},
        parseError: 'Tool arguments must be a JSON object.',
      };
    }
    return { toolCallId: id, name, arguments: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      toolCallId: id,
      name,
      arguments: {},
      parseError: error instanceof Error ? error.message : 'Arguments were not valid JSON.',
    };
  }
}

function mapFinishReason(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): CanonicalResponse['finishReason'] {
  if (hasToolCalls) return 'tool_call';
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

function parseCompletion(completion: WireCompletion): CanonicalResponse {
  const choice = completion.choices?.[0];
  const rawToolCalls = choice?.message?.tool_calls ?? [];
  const toolCalls = rawToolCalls.map(parseToolCall);

  return {
    text: choice?.message?.content ?? '',
    toolCalls,
    finishReason: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    },
    ...(completion.model === undefined && completion.id === undefined
      ? {}
      : { providerMetadata: { model: completion.model, id: completion.id } }),
  };
}

/**
 * Reassembles a streamed completion.
 *
 * Tool call fragments arrive keyed by `index`, with the name in the first
 * fragment and the arguments split arbitrarily across later ones.
 */
class StreamAccumulator {
  private text = '';
  private finishReason: string | null = null;
  private usage: WireUsage = {};
  private readonly toolFragments = new Map<number, { id?: string; name: string; args: string }>();

  appendText(delta: string): void {
    this.text += delta;
  }

  appendToolCalls(deltas: readonly WireToolCall[]): void {
    for (const delta of deltas) {
      const index = delta.index ?? 0;
      const existing = this.toolFragments.get(index) ?? { name: '', args: '' };
      const id = delta.id ?? existing.id;
      this.toolFragments.set(index, {
        ...(id === undefined ? {} : { id }),
        name: delta.function?.name ?? existing.name,
        args: existing.args + (delta.function?.arguments ?? ''),
      });
    }
  }

  setFinishReason(reason: string): void {
    this.finishReason = reason;
  }

  setUsage(usage: WireUsage): void {
    this.usage = usage;
  }

  finish(): CanonicalResponse {
    const toolCalls = [...this.toolFragments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, fragment]) =>
        parseToolCall(
          {
            ...(fragment.id === undefined ? {} : { id: fragment.id }),
            function: { name: fragment.name, arguments: fragment.args },
          },
          index,
        ),
      );

    return {
      text: this.text,
      toolCalls,
      finishReason: mapFinishReason(this.finishReason, toolCalls.length > 0),
      usage: {
        promptTokens: this.usage.prompt_tokens ?? 0,
        completionTokens: this.usage.completion_tokens ?? 0,
      },
    };
  }
}

/**
 * Normalises an HTTP failure from a Chat Completions endpoint.
 *
 * 401 and 403 are separated: a rejected key and a key that is valid but not
 * entitled are different problems with different fixes, and reporting both as
 * "the key was rejected" sends the user to change something that was correct.
 */
async function toHttpFailure(response: Response): Promise<ProviderFailure> {
  const detail = await readErrorBody(response);
  const category = categoryForStatus(response.status);
  const retry = retryAfterMs(response);

  const userMessage =
    category === 'authentication_failed'
      ? 'The API key was rejected. Check the key and that it is still active.'
      : category === 'access_denied'
        ? 'The key was accepted but is not permitted to use this endpoint or model.'
        : category === 'unsupported_capability'
          ? 'The endpoint or model name was not found. Check the base URL and model id.'
          : category === 'rate_limited'
            ? retry === undefined
              ? 'The provider is rate limiting requests. Try again shortly.'
              : `The provider is rate limiting requests. Retry in about ${Math.ceil(retry / 1000)}s.`
            : category === 'transient_provider_failure'
              ? 'The provider reported a server error. This is usually temporary.'
              : 'The provider rejected the request.';

  return providerFailure(
    OPENAI_COMPATIBLE_PROVIDER_ID,
    category,
    `The provider returned ${response.status}.`,
    {
      httpStatus: response.status,
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
      userMessage,
      technicalDetails: detail,
    },
  );
}

export { ProviderRequestError } from '@/providers/core/provider-error';
export { readServerSentEvents } from '@/providers/core/provider-http';

export const openAICompatibleFactory: ProviderFactory = {
  id: OPENAI_COMPATIBLE_PROVIDER_ID,
  displayName: 'OpenAI-compatible endpoint',
  kind: 'api',
  authKind: 'api_key',
  description:
    'Any endpoint implementing the OpenAI Chat Completions API: OpenAI, a self-hosted model ' +
    'server, or a compatible gateway. Supply the base URL, API key and model id.',
  // The only provider with no default: pointing it somewhere is the point.
  baseUrl: { required: true },
  operations: ['generate', 'stream', 'listModels', 'validateConnection', 'toolCalling', 'vision'],
  baselineCapabilities: capabilitiesFor(''),
  requiresGuardedTransport: true,
  create: (transport) => new OpenAICompatibleAdapter(transport),
};
