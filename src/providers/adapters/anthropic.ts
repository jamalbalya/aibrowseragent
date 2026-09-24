/**
 * Anthropic Messages API adapter (specification section 15).
 *
 * Not a variant of the OpenAI adapter. The two APIs differ in the places that
 * matter most to an agent loop, and flattening those differences is how an
 * adapter silently loses a tool result or a system prompt:
 *
 *  - the system prompt is a top-level `system` field, not a message with a
 *    `system` role;
 *  - content is always a list of typed blocks, and a tool call is a
 *    `tool_use` block inside an assistant message rather than a sibling
 *    `tool_calls` array;
 *  - a tool result is a `tool_result` block inside a **user** message, not a
 *    message with its own role;
 *  - images are `{ source: { type: "base64", media_type, data } }`, not a
 *    `data:` URL;
 *  - authentication is `x-api-key`, not a bearer token, and the API version
 *    is a required header rather than a path segment;
 *  - the stream is a typed event sequence — `content_block_delta` with
 *    `input_json_delta` fragments — not OpenAI's indexed tool-call deltas.
 *
 * Deliberate constraints:
 *  - Authentication is an API key the user supplies. The adapter never reads
 *    cookies, scrapes a web session, or infers API entitlement from a
 *    consumer subscription (specification sections 3.3 and 15). A subscription
 *    to the vendor's consumer product is not API access, and this adapter
 *    makes no attempt to treat it as one.
 *  - The network is reached only through the injected transport, so every
 *    request — generation, streaming, tool calling, vision, probes and every
 *    retry — passes the egress gate.
 */
import { getLogger } from '@/logging/logger';
import { createError } from '@/types/result';
import { providerFailure, type ProviderFailure } from '@/providers/core/provider-error';
import {
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

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * The API version this adapter is written against.
 *
 * Pinned rather than omitted: the header is required, and sending a version
 * the translation below was not written for would make a future wire change
 * arrive as a parse failure in production instead of a decision made here.
 */
export const ANTHROPIC_API_VERSION = '2023-06-01';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * `max_tokens` is required by the API and has no server-side default.
 *
 * A caller that does not state a budget still needs one, and picking it here
 * — visibly — is better than letting the request fail validation at the edge.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * Model families that predate image input.
 *
 * A deny list rather than an allow list, because a new model is far more
 * likely to accept images than not; the capability doctor verifies the claim
 * either way.
 */
const NO_VISION_HINTS = ['claude-2', 'claude-instant', 'claude-1'];

// --- wire types -------------------------------------------------------------

interface WireTextBlock {
  type: 'text';
  text?: string;
}

interface WireToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

type WireContentBlock = WireTextBlock | WireToolUseBlock | { type: string; [key: string]: unknown };

interface WireMessageResponse {
  id?: string;
  model?: string;
  role?: string;
  content?: WireContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface WireErrorBody {
  error?: { type?: string; message?: string };
}

interface WireModelList {
  data?: { id?: string; display_name?: string }[];
}

/** Streaming event payloads, discriminated by their own `type` field. */
interface WireStreamEvent {
  type?: string;
  index?: number;
  message?: WireMessageResponse;
  content_block?: WireContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicAdapter implements AIProviderAdapter {
  readonly id = ANTHROPIC_PROVIDER_ID;
  readonly displayName = 'Anthropic API';
  readonly kind = 'api' as const;
  readonly authKind = 'api_key' as const;

  private config: ProviderConfig | null = null;

  /** Salt for probe evidence, so probe digests stay unlinkable from task ones. */
  private readonly managementSalt = generateTaintSalt();

  /**
   * A transport, not a `fetch`.
   *
   * The registry supplies a guarded one; the default refuses. There is no
   * constructor path that yields direct network access.
   */
  constructor(private readonly transport: ProviderTransport = refusingTransport()) {}

  connect(config: ProviderConfig): Promise<AuthResult> {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      return Promise.resolve({
        authenticated: false,
        error: createError('AUTH_REQUIRED', 'An API key is required.', {
          userMessage:
            'Enter an Anthropic API key. A subscription to the consumer product is not API ' +
            'access — the key comes from the API console.',
        }),
      });
    }
    if (!config.model || config.model.trim().length === 0) {
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'A model id is required.', {
          userMessage: 'Choose a model, for example one of the ids the model list reports.',
        }),
      });
    }

    const baseUrl = (config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'The base URL is not a valid URL.'),
      });
    }
    if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) {
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'The base URL must use https.', {
          userMessage:
            'API keys are only sent over https. Use an https endpoint, or a loopback address ' +
            'for a local gateway.',
        }),
      });
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      // A query string on a base URL is how a credential ends up in a
      // destination identity. Authentication here is a header, and nothing
      // else belongs in the URL.
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'The base URL must not carry a query string.', {
          userMessage: 'Enter only the endpoint, without a query string or fragment.',
        }),
      });
    }

    this.config = { ...config, baseUrl };
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

  /**
   * Request headers.
   *
   * The key goes in `x-api-key` and nowhere else: not in the URL, not in a
   * query string, not in a log line. `extraHeaders` is applied first so a
   * user-supplied header cannot displace the version or the credential.
   */
  private headers(): Record<string, string> {
    const config = this.require();
    return {
      ...(config.extraHeaders ?? {}),
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
  }

  private url(path: string): string {
    return `${this.require().baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}${path}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    const config = this.require();
    try {
      const response = await this.transport.request(
        this.url('/v1/models?limit=100'),
        {
          method: 'GET',
          headers: this.headers(),
          signal: AbortSignal.timeout(20_000),
        },
        managementContext(ANTHROPIC_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        log.debug('Model list request was refused.', { status: response.status });
        return [];
      }
      const body = await parseJsonBody<WireModelList>(ANTHROPIC_PROVIDER_ID, response);
      return (body.data ?? [])
        .filter(
          (entry): entry is { id: string; display_name?: string } => typeof entry.id === 'string',
        )
        .map((entry) => ({
          id: entry.id,
          displayName: entry.display_name ?? entry.id,
          advertisedCapabilities: { vision: supportsVision(entry.id) },
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
   * `structuredOutput` is reported as **false** on purpose. The Messages API
   * has no response-format or schema-enforcement field, so a JSON reply can
   * only be asked for in the prompt and cannot be guaranteed. Claiming the
   * capability because a caller could phrase a prompt that way is exactly the
   * silent over-claim the capability model exists to prevent.
   */
  getCapabilities(model: string): Promise<ModelCapabilities> {
    return Promise.resolve(capabilitiesFor(model));
  }

  async validateConnection(): Promise<HealthResult> {
    const config = this.require();
    const started = Date.now();
    try {
      // A one-token completion is the probe: it exercises credentials, the
      // model id and the version header together, which a model list does not.
      const response = await this.transport.request(
        this.url('/v1/messages'),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            model: config.model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }),
          signal: AbortSignal.timeout(30_000),
        },
        managementContext(ANTHROPIC_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        return {
          reachable: false,
          error: (await toHttpFailure(response, this.config?.apiKey)).error,
        };
      }
      return { reachable: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        reachable: false,
        error: toNetworkError(ANTHROPIC_PROVIDER_ID, error, '/v1/messages').error,
      };
    }
  }

  async generate(request: CanonicalRequest): Promise<CanonicalResponse> {
    const unsupported = this.unsupported(request, false);
    if (unsupported) throw toThrowable(unsupported);

    let response: Response;
    try {
      response = await this.transport.request(
        this.url('/v1/messages'),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.buildBody(request, false)),
          signal: request.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
        requireEgress(request),
      );
    } catch (error) {
      throw toThrowable(toNetworkError(ANTHROPIC_PROVIDER_ID, error, '/v1/messages'));
    }

    if (!response.ok) throw toThrowable(await toHttpFailure(response, this.config?.apiKey));

    const message = await parseJsonBody<WireMessageResponse>(ANTHROPIC_PROVIDER_ID, response);
    return parseMessage(message);
  }

  async *stream(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const unsupported = this.unsupported(request, true);
    if (unsupported) {
      yield { type: 'error', error: unsupported.error };
      return;
    }

    let response: Response;
    try {
      response = await this.transport.request(
        this.url('/v1/messages'),
        {
          method: 'POST',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          body: JSON.stringify(this.buildBody(request, true)),
          signal: request.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
        requireEgress(request),
      );
    } catch (error) {
      yield {
        type: 'error',
        error: toNetworkError(ANTHROPIC_PROVIDER_ID, error, '/v1/messages').error,
      };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', error: (await toHttpFailure(response, this.config?.apiKey)).error };
      return;
    }
    if (!response.body) {
      yield {
        type: 'error',
        error: providerFailure(
          ANTHROPIC_PROVIDER_ID,
          'malformed_response',
          'The stream had no body.',
        ).error,
      };
      return;
    }

    const accumulator = new AnthropicStreamAccumulator();

    for await (const data of readServerSentEvents(response.body)) {
      let event: WireStreamEvent;
      try {
        event = JSON.parse(data) as WireStreamEvent;
      } catch {
        // A malformed frame is skipped rather than killing the stream. It
        // cannot become output, so the worst case is a shorter reply.
        continue;
      }

      switch (event.type) {
        case 'message_start':
          if (event.message?.usage) accumulator.setInputTokens(event.message.usage.input_tokens);
          break;
        case 'content_block_start':
          accumulator.startBlock(event.index ?? 0, event.content_block);
          break;
        case 'content_block_delta': {
          if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
            accumulator.appendText(event.delta.text);
            yield { type: 'text_delta', delta: event.delta.text };
          } else if (
            event.delta?.type === 'input_json_delta' &&
            typeof event.delta.partial_json === 'string'
          ) {
            accumulator.appendToolJson(event.index ?? 0, event.delta.partial_json);
          }
          break;
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) accumulator.setStopReason(event.delta.stop_reason);
          if (event.usage) {
            accumulator.setOutputTokens(event.usage.output_tokens);
            yield { type: 'usage', usage: accumulator.usage() };
          }
          break;
        }
        case 'error': {
          // A mid-stream error is reported and ends the stream: partial output
          // must never be treated as a completed turn.
          yield {
            type: 'error',
            error: failureFromErrorBody(
              { error: event.error ?? {} },
              undefined,
              'The provider reported an error mid-stream.',
            ).error,
          };
          return;
        }
        default:
          break;
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
      ANTHROPIC_PROVIDER_ID,
      model,
      request,
      capabilitiesFor(model),
      streaming,
    );
  }

  private buildBody(request: CanonicalRequest, stream: boolean): Record<string, unknown> {
    const config = this.require();
    const body: Record<string, unknown> = {
      model: config.model,
      // Required by the API; there is no server-side default to fall back on.
      max_tokens: request.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      messages: toWireMessages(request.messages),
      stream,
    };

    // The system prompt is a top-level field, not a message. Sending it as a
    // message with role "system" is rejected by the API.
    if (request.systemInstruction.trim().length > 0) {
      body.system = request.systemInstruction;
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // Named `input_schema`, and it is the same JSON Schema the canonical
        // declaration carries — only the field name differs.
        input_schema: tool.parameters,
      }));
      body.tool_choice = toWireToolChoice(request.toolChoice);
    }
    return body;
  }
}

/**
 * Canonical messages to Anthropic messages.
 *
 * Two structural differences are handled here. A tool result is a block in a
 * **user** message rather than a message with a role of its own, and
 * consecutive messages of the same role are merged, because the API rejects a
 * conversation that alternates incorrectly. Merging is why this operates on
 * the whole list rather than one message at a time.
 */
function toWireMessages(messages: readonly CanonicalMessage[]): Record<string, unknown>[] {
  const wire: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];

  for (const message of messages) {
    const blocks = message.content
      .map(toWireBlock)
      .filter((b): b is Record<string, unknown> => b !== null);
    if (blocks.length === 0) continue;

    // A `tool` message carries results, and results belong to the user turn.
    // A canonical `system` message is folded into the user turn too: the
    // top-level `system` field holds the instruction, and a stray system
    // message later in the conversation has nowhere else to go.
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';

    const last = wire[wire.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      wire.push({ role, content: blocks });
    }
  }

  return wire;
}

function toWireBlock(part: CanonicalContent): Record<string, unknown> | null {
  switch (part.type) {
    case 'text':
      // An empty text block is rejected by the API, so it is dropped rather
      // than sent; it carries nothing, so nothing is lost.
      return part.text.length === 0 ? null : { type: 'text', text: part.text };
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType, data: part.data },
      };
    case 'tool_call':
      return {
        type: 'tool_use',
        id: part.toolCallId,
        name: part.name,
        input: part.arguments,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: part.content,
        is_error: part.isError,
      };
  }
}

function toWireToolChoice(choice: CanonicalRequest['toolChoice']): Record<string, unknown> {
  switch (choice) {
    case 'required':
      // "Some tool" rather than "this tool": canonical `required` does not
      // name one, and `any` is the API's way of saying the same thing.
      return { type: 'any' };
    case 'none':
      return { type: 'none' };
    default:
      return { type: 'auto' };
  }
}

function parseMessage(message: WireMessageResponse): CanonicalResponse {
  const blocks = message.content ?? [];
  const text = blocks
    .filter((b): b is WireTextBlock => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join('');

  const toolCalls = blocks
    .filter((b): b is WireToolUseBlock => b.type === 'tool_use')
    .map((block, index) => toCanonicalToolCall(block, index));

  return {
    text,
    toolCalls,
    finishReason: mapStopReason(message.stop_reason, toolCalls.length > 0),
    usage: {
      promptTokens: message.usage?.input_tokens ?? 0,
      completionTokens: message.usage?.output_tokens ?? 0,
    },
    ...(message.model === undefined && message.id === undefined
      ? {}
      : { providerMetadata: { model: message.model, id: message.id } }),
  };
}

/**
 * A `tool_use` block to a canonical tool call.
 *
 * `input` arrives as a parsed object rather than a JSON string, so the failure
 * mode is a wrong *type* rather than a syntax error — but it is still model
 * output and still has to be checked before the runtime is told it has
 * arguments.
 */
function toCanonicalToolCall(block: WireToolUseBlock, index: number): CanonicalToolCall {
  const toolCallId = block.id ?? `toolu_${index}`;
  const name = block.name ?? '';
  const input = block.input;

  if (input === undefined || input === null) {
    return { toolCallId, name, arguments: {} };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      toolCallId,
      name,
      arguments: {},
      parseError: 'Tool arguments must be a JSON object.',
    };
  }
  return { toolCallId, name, arguments: input as Record<string, unknown> };
}

function mapStopReason(
  raw: string | null | undefined,
  hasToolCalls: boolean,
): CanonicalResponse['finishReason'] {
  if (hasToolCalls) return 'tool_call';
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_call';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Reassembles a streamed message.
 *
 * Tool arguments arrive as `input_json_delta` fragments keyed by block index,
 * with the name in the `content_block_start` event and the JSON split
 * arbitrarily across the deltas that follow.
 */
class AnthropicStreamAccumulator {
  private text = '';
  private stopReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly toolBlocks = new Map<number, { id: string; name: string; json: string }>();

  setInputTokens(tokens: number | undefined): void {
    if (typeof tokens === 'number') this.inputTokens = tokens;
  }

  setOutputTokens(tokens: number | undefined): void {
    if (typeof tokens === 'number') this.outputTokens = tokens;
  }

  startBlock(index: number, block: WireContentBlock | undefined): void {
    if (!block || block.type !== 'tool_use') return;
    const toolUse = block as WireToolUseBlock;
    this.toolBlocks.set(index, {
      id: toolUse.id ?? `toolu_${index}`,
      name: toolUse.name ?? '',
      json: '',
    });
  }

  appendText(delta: string): void {
    this.text += delta;
  }

  appendToolJson(index: number, fragment: string): void {
    const existing = this.toolBlocks.get(index);
    // A fragment for a block that never started is dropped: without the start
    // event there is no tool name, and inventing one would hand the runtime a
    // call it was never asked to make.
    if (!existing) return;
    existing.json += fragment;
  }

  setStopReason(reason: string): void {
    this.stopReason = reason;
  }

  usage(): CanonicalResponse['usage'] {
    return { promptTokens: this.inputTokens, completionTokens: this.outputTokens };
  }

  finish(): CanonicalResponse {
    const toolCalls = [...this.toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, fragment]) => parseStreamedToolCall(fragment));

    return {
      text: this.text,
      toolCalls,
      finishReason: mapStopReason(this.stopReason, toolCalls.length > 0),
      usage: this.usage(),
    };
  }
}

function parseStreamedToolCall(fragment: {
  id: string;
  name: string;
  json: string;
}): CanonicalToolCall {
  if (fragment.json.trim().length === 0) {
    // No arguments streamed at all is the documented shape for a tool with an
    // empty input object.
    return { toolCallId: fragment.id, name: fragment.name, arguments: {} };
  }
  try {
    const parsed: unknown = JSON.parse(fragment.json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        toolCallId: fragment.id,
        name: fragment.name,
        arguments: {},
        parseError: 'Tool arguments must be a JSON object.',
      };
    }
    return {
      toolCallId: fragment.id,
      name: fragment.name,
      arguments: parsed as Record<string, unknown>,
    };
  } catch (error) {
    return {
      toolCallId: fragment.id,
      name: fragment.name,
      arguments: {},
      parseError: error instanceof Error ? error.message : 'Arguments were not valid JSON.',
    };
  }
}

/**
 * Whether a host is the local machine.
 *
 * The https rule exists so an API key is never put on a network in the clear.
 * Loopback traffic reaches no network at all, and a local gateway speaking
 * this protocol is a real deployment — so loopback is the one exception, and
 * it is spelled out rather than approximated by a prefix match.
 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function supportsVision(model: string): boolean {
  const lower = model.toLowerCase();
  return !NO_VISION_HINTS.some((hint) => lower.startsWith(hint));
}

function capabilitiesFor(model: string): ModelCapabilities {
  return {
    text: true,
    streaming: true,
    toolCalling: true,
    parallelToolCalling: true,
    vision: supportsVision(model),
    // No response-format or schema field exists on this API surface, so a
    // JSON reply can be requested but not enforced. Reported honestly.
    structuredOutput: false,
    fileInput: false,
    audioInput: false,
    systemInstruction: true,
    modelListing: true,
    contextWindow: null,
    maxOutputTokens: null,
  };
}

/**
 * Maps an error type reported by the API to a normalised category.
 *
 * The type string is authoritative where it is present, because the same
 * status can carry different meanings — a 400 is an invalid request, but a
 * 400 whose type is `authentication_error` is a credential problem.
 */
function categoryForErrorType(type: string | undefined, status: number | undefined) {
  switch (type) {
    case 'authentication_error':
      return 'authentication_failed' as const;
    case 'permission_error':
      return 'access_denied' as const;
    case 'not_found_error':
      return 'unsupported_capability' as const;
    case 'rate_limit_error':
      return 'rate_limited' as const;
    case 'overloaded_error':
      return 'provider_unavailable' as const;
    case 'api_error':
      return 'transient_provider_failure' as const;
    case 'invalid_request_error':
    case 'request_too_large':
      return 'invalid_request' as const;
    default:
      break;
  }
  if (status === undefined) return 'transient_provider_failure' as const;
  if (status === 401) return 'authentication_failed' as const;
  if (status === 403) return 'access_denied' as const;
  if (status === 404) return 'unsupported_capability' as const;
  if (status === 429) return 'rate_limited' as const;
  // 529 is this API's documented "overloaded" status, which is a wait rather
  // than a server fault.
  if (status === 529) return 'provider_unavailable' as const;
  if (status >= 500) return 'transient_provider_failure' as const;
  return 'invalid_request' as const;
}

function failureFromErrorBody(
  body: WireErrorBody,
  status: number | undefined,
  fallbackMessage: string,
  retry?: number,
  detail?: string,
): ProviderFailure {
  const type = body.error?.type;
  const category = categoryForErrorType(type, status);

  const userMessage =
    category === 'authentication_failed'
      ? 'The API key was rejected. Check the key and that it is still active.'
      : category === 'access_denied'
        ? 'The key was accepted but is not permitted to use this model.'
        : category === 'unsupported_capability'
          ? 'The model id was not found. Check it against the model list.'
          : category === 'rate_limited'
            ? retry === undefined
              ? 'The provider is rate limiting requests. Try again shortly.'
              : `The provider is rate limiting requests. Retry in about ${Math.ceil(retry / 1000)}s.`
            : category === 'provider_unavailable'
              ? 'The provider is temporarily overloaded. This usually clears on its own.'
              : category === 'transient_provider_failure'
                ? 'The provider reported a server error. This is usually temporary.'
                : 'The provider rejected the request.';

  return providerFailure(ANTHROPIC_PROVIDER_ID, category, fallbackMessage, {
    ...(type === undefined ? {} : { providerCode: type }),
    ...(status === undefined ? {} : { httpStatus: status }),
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
    userMessage,
    // The provider's own message, not the request body: it describes what was
    // wrong with the call and carries no credential material.
    ...(detail === undefined ? {} : { technicalDetails: detail }),
  });
}

/**
 * Normalises an HTTP failure.
 *
 * `secret` is the credential this request was made with, threaded down so the
 * provider's own error body cannot hand it back to us — see `readErrorBody`.
 * Passed explicitly rather than read from ambient state, because the thing
 * that must not emit a secret should be given it deliberately.
 */
async function toHttpFailure(response: Response, secret?: string): Promise<ProviderFailure> {
  const raw = await readErrorBody(response, { ...(secret === undefined ? {} : { secret }) });
  let body: WireErrorBody = {};
  try {
    body = JSON.parse(raw) as WireErrorBody;
  } catch {
    body = {};
  }
  return failureFromErrorBody(
    body,
    response.status,
    `The provider returned ${response.status}.`,
    retryAfterMs(response),
    raw,
  );
}

export const anthropicFactory: ProviderFactory = {
  id: ANTHROPIC_PROVIDER_ID,
  displayName: 'Anthropic API',
  kind: 'api',
  authKind: 'api_key',
  description:
    'The Anthropic Messages API, authenticated with an API key from the API console. A ' +
    'subscription to the consumer product does not grant API access.',
  baseUrl: { required: false, defaultUrl: ANTHROPIC_DEFAULT_BASE_URL },
  operations: ['generate', 'stream', 'listModels', 'validateConnection', 'toolCalling', 'vision'],
  baselineCapabilities: capabilitiesFor(''),
  requiresGuardedTransport: true,
  create: (transport) => new AnthropicAdapter(transport),
};
