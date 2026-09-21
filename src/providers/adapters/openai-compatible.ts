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
import { createError, type AgentError } from '@/types/result';
import { delayFromRetryAfter } from '@/agent/recovery/retry-policy';
import { ProviderRequestError } from '@/providers/core/provider-error';
import {
  managementContext,
  refusingTransport,
  type EgressContext,
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

/**
 * Pulls the security context off a request, refusing when it is absent.
 *
 * A request with no context cannot be authorised, and guessing one — or
 * treating "no context" as "nothing sensitive" — is the fail-open this whole
 * mechanism exists to remove.
 */
function requireEgress(request: CanonicalRequest): EgressContext {
  if (!request.egress) {
    throw new Error('This provider request carries no egress context, so it cannot be authorised.');
  }
  return request.egress;
}

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
    return Promise.resolve({
      text: true,
      streaming: true,
      toolCalling: true,
      parallelToolCalling: true,
      vision: looksVisionCapable(model),
      structuredOutput: true,
      fileInput: false,
      audioInput: false,
      contextWindow: null,
      maxOutputTokens: null,
    });
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
        return { reachable: false, error: await toHttpError(response) };
      }
      return { reachable: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { reachable: false, error: toNetworkError(error) };
    }
  }

  async generate(request: CanonicalRequest): Promise<CanonicalResponse> {
    const config = this.require();
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
      throw toThrowable(toNetworkError(error));
    }

    if (!response.ok) {
      throw toThrowable(await toHttpError(response));
    }

    const completion = (await response.json()) as WireCompletion;
    return parseCompletion(completion);
  }

  async *stream(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const config = this.require();
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
      yield { type: 'error', error: toNetworkError(error) };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', error: await toHttpError(response) };
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

/** Yields the `data:` payload of each SSE frame. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line; \r\n is tolerated.
      let separator = findFrameEnd(buffer);
      while (separator !== -1) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const payload = extractData(frame);
        if (payload !== null) yield payload;
        separator = findFrameEnd(buffer);
      }
    }
    const trailing = extractData(buffer);
    if (trailing !== null) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

function findFrameEnd(buffer: string): { index: number; length: number } | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function extractData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return data.length > 0 ? data : null;
}

async function toHttpError(response: Response): Promise<AgentError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    detail = '';
  }

  if (response.status === 401 || response.status === 403) {
    return createError('AUTH_EXPIRED', `Provider rejected the credentials (${response.status}).`, {
      userMessage: 'The API key was rejected. Check the key and its permissions.',
      technicalDetails: detail,
    });
  }
  if (response.status === 404) {
    return createError('MODEL_UNSUPPORTED', 'The endpoint or model was not found (404).', {
      userMessage: 'The endpoint or model name was not found. Check the base URL and model id.',
      technicalDetails: detail,
    });
  }
  if (response.status === 429) {
    const retryAfter = delayFromRetryAfter(response.headers.get('retry-after'));
    return createError('RATE_LIMITED', 'The provider rate limited this request.', {
      userMessage:
        retryAfter === null
          ? 'The provider is rate limiting requests. Try again shortly.'
          : `The provider is rate limiting requests. Retry in about ${Math.ceil(retryAfter / 1000)}s.`,
      technicalDetails: detail,
    });
  }
  if (response.status >= 500) {
    return createError('MODEL_ERROR', `The provider returned ${response.status}.`, {
      userMessage: 'The provider reported a server error. This is usually temporary.',
      retryable: true,
      technicalDetails: detail,
    });
  }
  return createError('MODEL_ERROR', `The provider returned ${response.status}.`, {
    userMessage: 'The provider rejected the request.',
    technicalDetails: detail,
  });
}

function toNetworkError(error: unknown): AgentError {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return createError('USER_CANCELLED', 'The request was cancelled.', {
      userMessage: 'The request was cancelled.',
    });
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return createError('NETWORK_ERROR', 'The request to the provider timed out.', {
      userMessage: 'The provider did not respond in time.',
    });
  }
  return createError('NETWORK_ERROR', 'Could not reach the provider.', {
    userMessage: 'Could not reach the provider. Check the base URL and your network connection.',
    technicalDetails: error instanceof Error ? error.message : String(error),
  });
}

function toThrowable(error: AgentError): ProviderRequestError {
  return new ProviderRequestError(error);
}

export { ProviderRequestError } from '@/providers/core/provider-error';

export const openAICompatibleFactory: ProviderFactory = {
  id: OPENAI_COMPATIBLE_PROVIDER_ID,
  displayName: 'OpenAI-compatible endpoint',
  kind: 'api',
  authKind: 'api_key',
  description:
    'Any endpoint implementing the OpenAI Chat Completions API: OpenAI, a self-hosted model ' +
    'server, or a compatible gateway. Supply the base URL, API key and model id.',
  create: (transport) => new OpenAICompatibleAdapter(transport),
};
