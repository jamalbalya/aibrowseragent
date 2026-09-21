/**
 * Gemini generateContent adapter (specification section 15).
 *
 * The third wire format, and the one furthest from the other two. Differences
 * that had to be handled rather than papered over:
 *
 *  - a conversation is `contents`, each with `parts`, and the assistant's role
 *    is `model` rather than `assistant`;
 *  - the system prompt is `systemInstruction`, a `Content` of its own, not a
 *    message and not a string field;
 *  - a tool call is a `functionCall` part with an `args` object, and a result
 *    is a `functionResponse` part whose `response` must itself be an object —
 *    not a JSON string;
 *  - **there are no tool call ids.** Calls and responses are correlated by
 *    function name. Canonical ids are synthesised on the way out and the name
 *    is what goes back, which is the one place the canonical model carries
 *    more information than the provider does;
 *  - images are `inlineData`, base64 beside a mime type;
 *  - the model id lives in the request path, and the operation is a suffix on
 *    it (`:generateContent`), not a separate route;
 *  - streaming is the same JSON envelope repeated, requested with `alt=sse`,
 *    with no terminating sentinel.
 *
 * Authentication is the `x-goog-api-key` header. The key never enters a URL:
 * the request path is built from the model id alone, and `connect` refuses a
 * base URL carrying a query string. That is deliberate — the egress gate
 * derives a destination identity from the request URL, and a credential in a
 * query string would put it into consent keys, audit records and evidence.
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

export const GEMINI_PROVIDER_ID = 'gemini';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Models that exist on this endpoint but are not generative. */
const NON_GENERATIVE_HINTS = ['embedding', 'aqa', 'text-embedding'];

// --- wire types -------------------------------------------------------------

interface WirePart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}

interface WireContent {
  role?: string;
  parts?: WirePart[];
}

interface WireCandidate {
  content?: WireContent;
  finishReason?: string;
  index?: number;
}

interface WireGenerateResponse {
  candidates?: WireCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
  promptFeedback?: { blockReason?: string };
  error?: WireError;
}

interface WireError {
  code?: number;
  message?: string;
  status?: string;
}

interface WireModel {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface WireModelList {
  models?: WireModel[];
}

export class GeminiAdapter implements AIProviderAdapter {
  readonly id = GEMINI_PROVIDER_ID;
  readonly displayName = 'Google Gemini API';
  readonly kind = 'api' as const;
  readonly authKind = 'api_key' as const;

  private config: ProviderConfig | null = null;

  /** Salt for probe evidence, so probe digests stay unlinkable from task ones. */
  private readonly managementSalt = generateTaintSalt();

  /**
   * Capabilities discovered from the endpoint, keyed by bare model id.
   *
   * Cached because `getCapabilities` is consulted before every request that
   * could be refused for an unsupported feature, and re-asking the endpoint
   * each time would put a network round trip in front of every model turn.
   */
  private readonly discovered = new Map<string, ModelCapabilities>();

  constructor(private readonly transport: ProviderTransport = refusingTransport()) {}

  connect(config: ProviderConfig): Promise<AuthResult> {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      return Promise.resolve({
        authenticated: false,
        error: createError('AUTH_REQUIRED', 'An API key is required.', {
          userMessage: 'Enter a Gemini API key issued for this project.',
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

    const baseUrl = (config.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
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
      // This endpoint also accepts a key as a `key=` query parameter. This
      // adapter does not use it and will not accept a base URL that could
      // carry one: the egress gate builds a destination identity from the
      // request URL, so a credential there would reach consent keys, audit
      // records and evidence. The header is the only mechanism used.
      return Promise.resolve({
        authenticated: false,
        error: createError('INVALID_ARGUMENT', 'The base URL must not carry a query string.', {
          userMessage:
            'Enter only the endpoint, without a query string. The API key is sent as a header, ' +
            'never in the URL.',
        }),
      });
    }

    this.config = { ...config, baseUrl, model: bareModelId(config.model) };
    return Promise.resolve({
      authenticated: true,
      accountLabel: `${parsed.host} (key …${config.apiKey.slice(-4)})`,
    });
  }

  disconnect(): Promise<void> {
    this.config = null;
    this.discovered.clear();
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
   * The key goes in `x-goog-api-key` and nowhere else. `extraHeaders` is
   * applied first so a user-supplied header cannot displace the credential.
   */
  private headers(): Record<string, string> {
    const config = this.require();
    return {
      ...(config.extraHeaders ?? {}),
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey ?? '',
    };
  }

  /**
   * Builds a request URL.
   *
   * The assertion is not decoration. This is the one adapter whose provider
   * documents a credential-in-URL mechanism, so the invariant that it is not
   * used here is checked at the point where a URL is made rather than left to
   * review.
   */
  private url(path: string): string {
    const url = `${this.require().baseUrl ?? GEMINI_DEFAULT_BASE_URL}${path}`;
    if (/[?&](key|api_?key|access_token)=/i.test(url)) {
      throw new Error('A provider URL must never carry a credential.');
    }
    return url;
  }

  async listModels(): Promise<ModelInfo[]> {
    const config = this.require();
    try {
      const response = await this.transport.request(
        this.url('/models?pageSize=200'),
        {
          method: 'GET',
          headers: this.headers(),
          signal: AbortSignal.timeout(20_000),
        },
        managementContext(GEMINI_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        log.debug('Model list request was refused.', { status: response.status });
        return [];
      }
      const body = await parseJsonBody<WireModelList>(GEMINI_PROVIDER_ID, response);
      return (body.models ?? [])
        .filter((entry): entry is WireModel & { name: string } => typeof entry.name === 'string')
        .filter((entry) => (entry.supportedGenerationMethods ?? []).includes('generateContent'))
        .map((entry) => {
          const id = bareModelId(entry.name);
          const capabilities = capabilitiesFromModel(id, entry);
          // Cached here too: a caller that listed models has already paid for
          // the discovery, and asking again per model would be wasteful.
          this.discovered.set(id, capabilities);
          return {
            id,
            displayName: entry.displayName ?? id,
            advertisedCapabilities: capabilities,
          };
        });
    } catch (error) {
      log.debug('Model list request failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Capabilities, discovered from the endpoint where it will say.
   *
   * `GET /models/{id}` reports which generation methods a model supports and
   * its token limits, which is real discovery rather than a guess from the
   * model's name. When the lookup fails — an offline check, an endpoint that
   * does not expose it — the conservative defaults below are used and the
   * capability doctor remains the authority.
   */
  async getCapabilities(model: string): Promise<ModelCapabilities> {
    const id = bareModelId(model);
    const cached = this.discovered.get(id);
    if (cached) return cached;

    const fallback = capabilitiesFromModel(id, {});
    if (!this.config) return fallback;

    try {
      const response = await this.transport.request(
        this.url(`/models/${encodeURIComponent(id)}`),
        {
          method: 'GET',
          headers: this.headers(),
          signal: AbortSignal.timeout(20_000),
        },
        managementContext(GEMINI_PROVIDER_ID, id, this.managementSalt),
      );
      if (!response.ok) return fallback;
      const body = await parseJsonBody<WireModel>(GEMINI_PROVIDER_ID, response);
      const discovered = capabilitiesFromModel(id, body);
      this.discovered.set(id, discovered);
      return discovered;
    } catch (error) {
      log.debug('Capability discovery failed; using conservative defaults.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  async validateConnection(): Promise<HealthResult> {
    const config = this.require();
    const started = Date.now();
    const model = bareModelId(config.model ?? '');
    try {
      const response = await this.transport.request(
        this.url(`/models/${encodeURIComponent(model)}:generateContent`),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 1 },
          }),
          signal: AbortSignal.timeout(30_000),
        },
        managementContext(GEMINI_PROVIDER_ID, model, this.managementSalt),
      );
      if (!response.ok) {
        return { reachable: false, error: (await toHttpFailure(response)).error };
      }
      return { reachable: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        reachable: false,
        error: toNetworkError(GEMINI_PROVIDER_ID, error, ':generateContent').error,
      };
    }
  }

  async generate(request: CanonicalRequest): Promise<CanonicalResponse> {
    const model = bareModelId(this.require().model ?? '');
    const unsupported = await this.unsupported(request, false);
    if (unsupported) throw toThrowable(unsupported);

    let response: Response;
    try {
      response = await this.transport.request(
        this.url(`/models/${encodeURIComponent(model)}:generateContent`),
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(buildBody(request)),
          signal: request.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
        requireEgress(request),
      );
    } catch (error) {
      throw toThrowable(toNetworkError(GEMINI_PROVIDER_ID, error, ':generateContent'));
    }

    if (!response.ok) throw toThrowable(await toHttpFailure(response));

    const body = await parseJsonBody<WireGenerateResponse>(GEMINI_PROVIDER_ID, response);
    // A 200 carrying an error object is documented and must not be read as a
    // successful empty reply.
    if (body.error) {
      throw toThrowable(failureFromError(body.error, undefined, 'The provider reported an error.'));
    }
    return parseGenerateResponse(body);
  }

  async *stream(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const model = bareModelId(this.require().model ?? '');
    const unsupported = await this.unsupported(request, true);
    if (unsupported) {
      yield { type: 'error', error: unsupported.error };
      return;
    }

    let response: Response;
    try {
      response = await this.transport.request(
        // `alt=sse` is the documented way to get framed events rather than a
        // streamed JSON array. It is a response-format parameter, not a
        // credential, so it is the one thing this adapter puts in a query.
        this.url(`/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`),
        {
          method: 'POST',
          headers: { ...this.headers(), Accept: 'text/event-stream' },
          body: JSON.stringify(buildBody(request)),
          signal: request.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        },
        requireEgress(request),
      );
    } catch (error) {
      yield {
        type: 'error',
        error: toNetworkError(GEMINI_PROVIDER_ID, error, ':streamGenerateContent').error,
      };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', error: (await toHttpFailure(response)).error };
      return;
    }
    if (!response.body) {
      yield {
        type: 'error',
        error: providerFailure(GEMINI_PROVIDER_ID, 'malformed_response', 'The stream had no body.')
          .error,
      };
      return;
    }

    const accumulator = new GeminiStreamAccumulator();

    for await (const data of readServerSentEvents(response.body)) {
      let chunk: WireGenerateResponse;
      try {
        chunk = JSON.parse(data) as WireGenerateResponse;
      } catch {
        // A malformed frame is skipped rather than killing the stream.
        continue;
      }

      if (chunk.error) {
        yield {
          type: 'error',
          error: failureFromError(chunk.error, undefined, 'The provider reported an error.').error,
        };
        return;
      }

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === 'string' && part.text.length > 0) {
          accumulator.appendText(part.text);
          yield { type: 'text_delta', delta: part.text };
        }
        if (part.functionCall) accumulator.addFunctionCall(part.functionCall);
      }
      if (candidate?.finishReason) accumulator.setFinishReason(candidate.finishReason);
      if (chunk.usageMetadata) {
        accumulator.setUsage(chunk.usageMetadata);
        yield { type: 'usage', usage: accumulator.usage() };
      }
    }

    const final = accumulator.finish();
    for (const toolCall of final.toolCalls) {
      yield { type: 'tool_call', toolCall };
    }
    yield { type: 'done', response: final };
  }

  private async unsupported(
    request: CanonicalRequest,
    streaming: boolean,
  ): Promise<ProviderFailure | null> {
    const model = bareModelId(this.require().model ?? '');
    return checkCapabilities(
      GEMINI_PROVIDER_ID,
      model,
      request,
      await this.getCapabilities(model),
      streaming,
    );
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

/** `models/gemini-x` and `gemini-x` are the same model; this is the bare form. */
export function bareModelId(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

function buildBody(request: CanonicalRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toWireContents(request.messages),
  };

  // A `Content`, not a string and not a message. Its role is omitted because
  // the field itself says whose instruction it is.
  if (request.systemInstruction.trim().length > 0) {
    body.systemInstruction = { parts: [{ text: request.systemInstruction }] };
  }

  const generationConfig: Record<string, unknown> = {};
  if (request.maxOutputTokens !== undefined) {
    generationConfig.maxOutputTokens = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

  if (request.tools && request.tools.length > 0) {
    // One `tools` entry holding every declaration, which is the documented
    // shape; one entry per tool is accepted in places and inconsistent.
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: toWireMode(request.toolChoice) } };
  }

  return body;
}

function toWireMode(choice: CanonicalRequest['toolChoice']): string {
  switch (choice) {
    case 'required':
      return 'ANY';
    case 'none':
      return 'NONE';
    default:
      return 'AUTO';
  }
}

/**
 * Canonical messages to `contents`.
 *
 * The assistant is called `model` here, and a tool result is a part of the
 * user turn — there is no third role. Consecutive turns of the same role are
 * merged for the same reason as in the other adapters: the API expects an
 * alternating conversation.
 */
function toWireContents(messages: readonly CanonicalMessage[]): Record<string, unknown>[] {
  const contents: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = [];

  for (const message of messages) {
    const parts = message.content
      .map(toWirePart)
      .filter((p): p is Record<string, unknown> => p !== null);
    if (parts.length === 0) continue;

    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  return contents;
}

function toWirePart(part: CanonicalContent): Record<string, unknown> | null {
  switch (part.type) {
    case 'text':
      return part.text.length === 0 ? null : { text: part.text };
    case 'image':
      return { inlineData: { mimeType: part.mimeType, data: part.data } };
    case 'tool_call':
      // No id field exists; the name is the correlation key.
      return { functionCall: { name: part.name, args: part.arguments } };
    case 'tool_result':
      return {
        functionResponse: {
          name: part.name,
          response: toFunctionResponse(part.content, part.isError),
        },
      };
  }
}

/**
 * Canonical tool output to a `functionResponse.response`.
 *
 * The field must be an object, and the canonical envelope is a JSON string.
 * A string that does not parse into an object is wrapped rather than dropped
 * or sent as-is: the model still needs to see what the tool said, and a
 * rejected request would lose it entirely.
 */
function toFunctionResponse(content: string, isError: boolean): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    value = content;
  }
  const payload =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };

  // There is no `is_error` flag on this API, so failure is stated in the
  // payload rather than silently lost.
  return isError ? { error: payload } : payload;
}

function parseGenerateResponse(body: WireGenerateResponse): CanonicalResponse {
  const candidate = body.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const text = parts
    .map((part) => part.text)
    .filter((t): t is string => typeof t === 'string')
    .join('');

  const toolCalls = parts
    .map((part) => part.functionCall)
    .filter((call): call is NonNullable<WirePart['functionCall']> => call !== undefined)
    .map((call, index) => toCanonicalToolCall(call, index));

  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(
      candidate?.finishReason,
      toolCalls.length > 0,
      body.promptFeedback?.blockReason,
    ),
    usage: {
      promptTokens: body.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    },
    ...(body.modelVersion === undefined && body.responseId === undefined
      ? {}
      : { providerMetadata: { model: body.modelVersion, id: body.responseId } }),
  };
}

/**
 * A `functionCall` part to a canonical tool call.
 *
 * The id is synthesised: this API has none, and the canonical model requires
 * one so that a result can be attributed to the call that produced it. It is
 * derived from position and name so that it is stable within a turn, and it
 * is never sent back — `functionResponse` correlates by name.
 */
function toCanonicalToolCall(
  call: NonNullable<WirePart['functionCall']>,
  index: number,
): CanonicalToolCall {
  const name = call.name ?? '';
  const toolCallId = `fc_${index}_${name || 'unnamed'}`;
  const args = call.args;

  if (args === undefined || args === null) {
    return { toolCallId, name, arguments: {} };
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return {
      toolCallId,
      name,
      arguments: {},
      parseError: 'Tool arguments must be a JSON object.',
    };
  }
  return { toolCallId, name, arguments: args as Record<string, unknown> };
}

function mapFinishReason(
  raw: string | undefined,
  hasToolCalls: boolean,
  blockReason?: string,
): CanonicalResponse['finishReason'] {
  if (blockReason !== undefined) return 'content_filter';
  if (hasToolCalls) return 'tool_call';
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/**
 * Reassembles a streamed response.
 *
 * Unlike the other two formats, function calls arrive whole rather than as
 * JSON fragments, so there is nothing to reassemble for them — only text
 * accumulates.
 */
class GeminiStreamAccumulator {
  private text = '';
  private finishReason: string | undefined;
  private promptTokens = 0;
  private completionTokens = 0;
  private readonly calls: NonNullable<WirePart['functionCall']>[] = [];

  appendText(delta: string): void {
    this.text += delta;
  }

  addFunctionCall(call: NonNullable<WirePart['functionCall']>): void {
    this.calls.push(call);
  }

  setFinishReason(reason: string): void {
    this.finishReason = reason;
  }

  setUsage(usage: NonNullable<WireGenerateResponse['usageMetadata']>): void {
    this.promptTokens = usage.promptTokenCount ?? this.promptTokens;
    this.completionTokens = usage.candidatesTokenCount ?? this.completionTokens;
  }

  usage(): CanonicalResponse['usage'] {
    return { promptTokens: this.promptTokens, completionTokens: this.completionTokens };
  }

  finish(): CanonicalResponse {
    const toolCalls = this.calls.map((call, index) => toCanonicalToolCall(call, index));
    return {
      text: this.text,
      toolCalls,
      finishReason: mapFinishReason(this.finishReason, toolCalls.length > 0),
      usage: this.usage(),
    };
  }
}

/**
 * Capabilities for a model, from what the endpoint reported about it.
 *
 * With no report, the defaults are what this adapter implements for the
 * generative model families on this surface; with one, the supported
 * generation methods and token limits are authoritative.
 */
function capabilitiesFromModel(model: string, reported: WireModel): ModelCapabilities {
  const methods = reported.supportedGenerationMethods;
  const known = Array.isArray(methods) && methods.length > 0;
  const generative = !NON_GENERATIVE_HINTS.some((hint) => model.toLowerCase().includes(hint));

  return {
    text: known ? methods.includes('generateContent') : generative,
    streaming: known ? methods.includes('streamGenerateContent') : generative,
    toolCalling: generative,
    parallelToolCalling: generative,
    vision: generative,
    // `responseMimeType` and `responseSchema` on `generationConfig` are part
    // of this API surface, so structured output is genuinely available.
    structuredOutput: generative,
    fileInput: false,
    audioInput: false,
    systemInstruction: true,
    modelListing: true,
    contextWindow: typeof reported.inputTokenLimit === 'number' ? reported.inputTokenLimit : null,
    maxOutputTokens:
      typeof reported.outputTokenLimit === 'number' ? reported.outputTokenLimit : null,
  };
}

/**
 * Maps a reported status to a normalised category.
 *
 * The `status` enum is preferred over the HTTP code because this endpoint
 * reports several distinct conditions as 400 — a malformed body and a
 * rejected key among them — and only the enum tells them apart.
 */
function categoryForStatusEnum(status: string | undefined, code: number | undefined) {
  switch (status) {
    case 'UNAUTHENTICATED':
      return 'authentication_failed' as const;
    case 'PERMISSION_DENIED':
      return 'access_denied' as const;
    case 'NOT_FOUND':
      return 'unsupported_capability' as const;
    case 'RESOURCE_EXHAUSTED':
      return 'rate_limited' as const;
    case 'UNAVAILABLE':
      return 'provider_unavailable' as const;
    case 'DEADLINE_EXCEEDED':
      return 'provider_unavailable' as const;
    case 'INTERNAL':
      return 'transient_provider_failure' as const;
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
    case 'OUT_OF_RANGE':
      return 'invalid_request' as const;
    default:
      break;
  }
  if (code === undefined) return 'transient_provider_failure' as const;
  if (code === 401) return 'authentication_failed' as const;
  if (code === 403) return 'access_denied' as const;
  if (code === 404) return 'unsupported_capability' as const;
  if (code === 429) return 'rate_limited' as const;
  if (code === 503) return 'provider_unavailable' as const;
  if (code >= 500) return 'transient_provider_failure' as const;
  return 'invalid_request' as const;
}

function failureFromError(
  error: WireError,
  retry: number | undefined,
  fallbackMessage: string,
  detail?: string,
): ProviderFailure {
  const category = categoryForStatusEnum(error.status, error.code);

  const userMessage =
    category === 'authentication_failed'
      ? 'The API key was rejected. Check the key and that it is enabled for this API.'
      : category === 'access_denied'
        ? 'The key was accepted but is not permitted to use this model.'
        : category === 'unsupported_capability'
          ? 'The model id was not found. Check it against the model list.'
          : category === 'rate_limited'
            ? retry === undefined
              ? 'The provider is rate limiting requests. Try again shortly.'
              : `The provider is rate limiting requests. Retry in about ${Math.ceil(retry / 1000)}s.`
            : category === 'provider_unavailable'
              ? 'The provider is temporarily unavailable. This usually clears on its own.'
              : category === 'transient_provider_failure'
                ? 'The provider reported a server error. This is usually temporary.'
                : 'The provider rejected the request.';

  return providerFailure(GEMINI_PROVIDER_ID, category, fallbackMessage, {
    ...(error.status === undefined ? {} : { providerCode: error.status }),
    ...(error.code === undefined ? {} : { httpStatus: error.code }),
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
    userMessage,
    ...(detail === undefined ? {} : { technicalDetails: detail }),
  });
}

async function toHttpFailure(response: Response): Promise<ProviderFailure> {
  const raw = await readErrorBody(response);
  let error: WireError = {};
  try {
    const parsed = JSON.parse(raw) as { error?: WireError };
    error = parsed.error ?? {};
  } catch {
    error = {};
  }
  // The HTTP status is authoritative when the body did not carry a code.
  const withStatus: WireError = { ...error, code: error.code ?? response.status };
  return failureFromError(
    withStatus,
    retryAfterMs(response),
    `The provider returned ${response.status}.`,
    raw,
  );
}

export const geminiFactory: ProviderFactory = {
  id: GEMINI_PROVIDER_ID,
  displayName: 'Google Gemini API',
  kind: 'api',
  authKind: 'api_key',
  description:
    'The Gemini generateContent API, authenticated with an API key sent as a request header. ' +
    'Supply the API key and a model id.',
  baseUrl: { required: false, defaultUrl: GEMINI_DEFAULT_BASE_URL },
  operations: ['generate', 'stream', 'listModels', 'validateConnection', 'toolCalling', 'vision'],
  baselineCapabilities: capabilitiesFromModel('', {}),
  requiresGuardedTransport: true,
  create: (transport) => new GeminiAdapter(transport),
};
