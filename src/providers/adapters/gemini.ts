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
import { isLoopbackHostname } from '@/security/origin/origin-validator';
import { createError } from '@/types/result';
import { providerFailure, type ProviderFailure } from '@/providers/core/provider-error';
import {
  admitModelIds,
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
  /**
   * An opaque token Google attaches beside a `functionCall` and requires back.
   *
   * A sibling field on the Part, not inside `functionCall`. Replaying a call
   * without it is refused — see `CanonicalToolCall.providerSignature`.
   */
  thoughtSignature?: string;
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
  /** `google.rpc` status details. See `retryDelayFromDetails`. */
  details?: unknown;
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
      const bearer = config.credentialScheme === 'bearer';
      return Promise.resolve({
        authenticated: false,
        error: createError(
          'AUTH_REQUIRED',
          bearer ? 'An access token is required.' : 'An API key is required.',
          {
            userMessage: bearer
              ? 'Authorize a Google account again — this connection has no usable access token.'
              : 'Enter a Gemini API key issued for this project.',
          },
        ),
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
    if (parsed.protocol !== 'https:' && !isLoopbackHostname(parsed.hostname)) {
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

    // **The cache cannot outlive the credential it was measured with.**
    //
    // One adapter instance is shared by every account on this provider — the
    // registry caches instances by provider id — and `resolveBrainAccount`
    // reconnects it on every request rather than disconnecting first. So
    // without this, capabilities discovered under one account's credential
    // were still in the map when a *different* account's turn ran: two Gemini
    // accounts on different tiers or in different regions can have different
    // access to the same model id, and the second one would read the first
    // one's answer.
    //
    // Cleared on a change of credential or endpoint, not on every connect.
    // Clearing unconditionally would discard the cache on every request, which
    // is a network round trip in front of each one — the cost the cache exists
    // to avoid. The same account reconnecting keeps what it measured.
    if (this.config !== null) {
      const sameCredential = this.config.apiKey === config.apiKey;
      const sameEndpoint = this.config.baseUrl === baseUrl;
      const sameScheme = this.config.credentialScheme === config.credentialScheme;
      if (!sameCredential || !sameEndpoint || !sameScheme) this.discovered.clear();
    }

    // A connection with no model is legitimate and has to be: the product's
    // journey is connect, discover what this credential can see, then choose.
    // `connect` used to refuse without one, which made that journey
    // impossible for this provider and for Anthropic — a user had to know a
    // model id before they could ask what the ids were. The requirement now
    // belongs to the operations that need a model, which is where it means
    // something. See `requireModel`.
    this.config = {
      ...config,
      baseUrl,
      ...(config.model === undefined ? {} : { model: bareModelId(config.model) }),
    };
    return Promise.resolve({
      authenticated: true,
      // An access token is not a key, and a label reading "key …a1b2" for one
      // would be telling the user they pasted something they did not. The last
      // four characters are also not a useful way to tell two Google
      // authorizations apart — they are opaque and they change on every
      // refresh — so an OAuth connection is labelled by what it is, and the
      // panel shows the Google account beside it.
      accountLabel:
        config.credentialScheme === 'bearer'
          ? `${parsed.host} (authorized with Google)`
          : `${parsed.host} (key …${config.apiKey.slice(-4)})`,
    });
  }

  disconnect(): Promise<void> {
    this.config = null;
    this.discovered.clear();
    return Promise.resolve();
  }

  /**
   * The model this connection will act on, or a refusal naming the gap.
   *
   * `connect` deliberately accepts a connection with no model, because
   * discovery has to happen before a choice can be made. Every operation that
   * puts a model in the request path goes through here instead, so the refusal
   * arrives before a URL like `/models/:generateContent` is built and sent to
   * the vendor as a malformed request.
   */
  private requireModel(): string {
    const model = bareModelId(this.require().model ?? '');
    if (model.length === 0) {
      throw toThrowable(
        providerFailure(GEMINI_PROVIDER_ID, 'invalid_request', 'No model is selected.', {
          userMessage: 'Choose a model for this account before running a task.',
        }),
      );
    }
    return model;
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
   * The credential goes in exactly one header and nowhere else, and which
   * header depends on what the credential *is*. A key issued by AI Studio is
   * read from `x-goog-api-key`; an access token from an OAuth authorization is
   * read from `Authorization: Bearer` and is **not** accepted in the key
   * header. Sending either in the other's place is an unauthenticated request
   * carrying the user's credential, which the service answers 401 with the
   * credential already spent.
   *
   * Measured rather than assumed: `generativelanguage.googleapis.com` answers
   * a bearer-token request with *"Expected OAuth 2 access token, login cookie
   * or other valid authentication credential"*, so bearer is a scheme this API
   * recognises.
   *
   * `extraHeaders` is applied first so a user-supplied header cannot displace
   * the credential, and the unused scheme's header is never set at all — an
   * empty `x-goog-api-key` alongside a bearer token would be a second,
   * blank credential on the request.
   */
  /**
   * How this connection authenticates, for error classification.
   *
   * Read from the live config rather than passed down, so a failure cannot be
   * classified against a different connection's shape than the request was
   * made with.
   */
  private authShape(): { readonly bearer: boolean; readonly quotaProject?: string } {
    const bearer = this.config?.credentialScheme === 'bearer';
    const project = this.config?.quotaProject;
    return { bearer, ...(project === undefined ? {} : { quotaProject: project }) };
  }

  private headers(): Record<string, string> {
    const config = this.require();
    const base = {
      ...(config.extraHeaders ?? {}),
      'Content-Type': 'application/json',
    };
    if (config.credentialScheme === 'bearer') {
      return {
        ...base,
        Authorization: `Bearer ${config.apiKey ?? ''}`,
        // Google documents that a user-credential call to a client-based API
        // must name a project for billing and quota, and answers one that does
        // not with a message saying so. The quickstart's own curl example sends
        // this header beside the bearer token.
        //
        // Only with a bearer credential. A key already carries its own
        // project, so sending this with one would name a second project for
        // the same call. Omitted when none is configured rather than sent
        // empty — an empty value is a project id Google cannot resolve.
        ...(config.quotaProject === undefined
          ? {}
          : { 'x-goog-user-project': config.quotaProject }),
      };
    }
    return { ...base, 'x-goog-api-key': config.apiKey ?? '' };
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
        await managementContext(GEMINI_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        log.debug('Model list request was refused.', { status: response.status });
        return [];
      }
      const body = await parseJsonBody<WireModelList>(GEMINI_PROVIDER_ID, response);
      const listed = (body.models ?? [])
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
      return admitModelIds(GEMINI_PROVIDER_ID, listed);
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
        await managementContext(GEMINI_PROVIDER_ID, id, this.managementSalt),
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
        await managementContext(GEMINI_PROVIDER_ID, model, this.managementSalt),
      );
      if (!response.ok) {
        return {
          reachable: false,
          error: (await toHttpFailure(response, this.config?.apiKey, this.authShape())).error,
        };
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
    const model = this.requireModel();
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

    if (!response.ok)
      throw toThrowable(await toHttpFailure(response, this.config?.apiKey, this.authShape()));

    const body = await parseJsonBody<WireGenerateResponse>(GEMINI_PROVIDER_ID, response);
    // A 200 carrying an error object is documented and must not be read as a
    // successful empty reply.
    if (body.error) {
      throw toThrowable(failureFromError(body.error, undefined, 'The provider reported an error.'));
    }
    return parseGenerateResponse(body);
  }

  async *stream(request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    const model = this.requireModel();
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
      yield {
        type: 'error',
        error: (await toHttpFailure(response, this.config?.apiKey, this.authShape())).error,
      };
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
        // The whole part: the signature is a sibling of `functionCall`.
        if (part.functionCall) accumulator.addFunctionCall(part);
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
    const model = this.requireModel();
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
          // Translated, not passed through: see `toWireSchema`.
          parameters: toWireSchema(tool.parameters),
        })),
      },
    ];
    body.toolConfig = { functionCallingConfig: { mode: toWireMode(request.toolChoice) } };
  }

  return body;
}

/**
 * Fields Google's `Schema` type actually has.
 *
 * Gemini's `functionDeclarations[].parameters` is not JSON Schema. It is
 * Google's `Schema` message — an OpenAPI 3.0 subset — and it is parsed by
 * protobuf JSON, which **rejects an unknown field** rather than ignoring it.
 * A canonical tool schema carrying one gets the whole request refused:
 *
 *   400 Invalid JSON payload received. Unknown name "additionalProperties"
 *   at 'tools[0].function_declarations[0].parameters': Cannot find field.
 *
 * That is not a hypothetical. The capability doctor's own probe tool declares
 * `additionalProperties: false`, which is ordinary and correct JSON Schema and
 * which every other provider here accepts. So on Gemini the tool-calling probe
 * failed every time, the model was reported `CHAT_ONLY`, and **the browser
 * agent could not run on Gemini at all** — on the one provider this build
 * supports a Google authorization for. No mocked test could find it, because a
 * fixture accepts whatever we send it.
 *
 * An allow-list rather than a deny-list of the four fields found to be
 * rejected, because the question is not "which spellings have I tried" but
 * "which fields does the type have", and Google documents that. A field left
 * out silently loosens a constraint, which the tool's own argument validation
 * still catches; a field wrongly kept refuses the request outright and takes
 * the whole tool with it.
 *
 * Verified live against `gemini-flash-latest`: `title`, `default`, `enum`,
 * `minLength` and `format` are accepted; `additionalProperties`, `$schema`,
 * `const` and `examples` are each rejected by name. Note `example` singular is
 * Google's spelling and `examples` plural is JSON Schema's — the plural is the
 * one that fails, which is exactly the kind of difference a translation layer
 * exists to absorb.
 */
const GEMINI_SCHEMA_FIELDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'propertyOrdering',
  'default',
  'example',
  'anyOf',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'pattern',
]);

/** Sub-schemas that are themselves schemas, and so recurse. */
const SCHEMA_VALUED = new Set(['items']);
/** Sub-schemas held in a map of schemas. */
const SCHEMA_MAP_VALUED = new Set(['properties']);
/** Sub-schemas held in a list of schemas. */
const SCHEMA_LIST_VALUED = new Set(['anyOf']);

/**
 * A canonical tool schema as Google's `Schema` type.
 *
 * Recursive, because a rejected field nested three levels down refuses the
 * request just as completely as one at the top. `type` arrays — JSON Schema's
 * `["string", "null"]` — become a single type plus `nullable`, which is how
 * the same idea is spelled here.
 */
function toWireSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWireSchema);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(source)) {
    if (!GEMINI_SCHEMA_FIELDS.has(key)) continue;

    if (key === 'type' && Array.isArray(entry)) {
      const types = entry.filter((t): t is string => typeof t === 'string');
      const concrete = types.filter((t) => t !== 'null');
      if (concrete.length > 0) out.type = concrete[0];
      if (types.length !== concrete.length) out.nullable = true;
      continue;
    }
    if (SCHEMA_VALUED.has(key)) {
      out[key] = toWireSchema(entry);
      continue;
    }
    if (SCHEMA_LIST_VALUED.has(key)) {
      out[key] = Array.isArray(entry) ? entry.map(toWireSchema) : toWireSchema(entry);
      continue;
    }
    if (SCHEMA_MAP_VALUED.has(key)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      out[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([name, sub]) => [
          name,
          toWireSchema(sub),
        ]),
      );
      continue;
    }
    out[key] = entry;
  }

  return out;
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
      // No id field exists; the name is the correlation key. The signature is
      // a sibling of `functionCall`, not a field inside it, and omitting it is
      // a 400 on the turn that sends the tool result back.
      return {
        functionCall: { name: part.name, args: part.arguments },
        ...(part.providerSignature === undefined
          ? {}
          : { thoughtSignature: part.providerSignature }),
      };
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

  // Filtered on the **part**, not on `functionCall`, because the signature is
  // a sibling field: mapping to `part.functionCall` first threw it away.
  const toolCalls = parts
    .filter((part) => part.functionCall !== undefined)
    .map((part, index) => toCanonicalToolCall(part.functionCall!, index, part.thoughtSignature));

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
  signature?: string,
): CanonicalToolCall {
  const name = call.name ?? '';
  const toolCallId = `fc_${index}_${name || 'unnamed'}`;
  const args = call.args;
  // Carried through every return below, because a call replayed without it is
  // refused and the shape of the arguments has nothing to do with that.
  const signed =
    signature === undefined || signature.length === 0 ? {} : { providerSignature: signature };

  if (args === undefined || args === null) {
    return { toolCallId, name, arguments: {}, ...signed };
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return {
      toolCallId,
      name,
      arguments: {},
      parseError: 'Tool arguments must be a JSON object.',
      ...signed,
    };
  }
  return { toolCallId, name, arguments: args as Record<string, unknown>, ...signed };
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
  /**
   * The whole part, not just its `functionCall`.
   *
   * `thoughtSignature` sits beside `functionCall` rather than inside it, so
   * keeping only the call discarded the one field a later turn is refused
   * without.
   */
  private readonly calls: WirePart[] = [];

  appendText(delta: string): void {
    this.text += delta;
  }

  addFunctionCall(part: WirePart): void {
    this.calls.push(part);
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
    const toolCalls = this.calls.map((part, index) =>
      toCanonicalToolCall(part.functionCall ?? {}, index, part.thoughtSignature),
    );
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
 * generation methods and token limits are authoritative — with one exception,
 * measured rather than assumed.
 *
 * ## Why `streamGenerateContent` is not read from the list
 *
 * It used to be, and it was wrong. `supportedGenerationMethods` on this
 * endpoint no longer carries `streamGenerateContent` for any current model:
 * a live `GET /v1beta/models` reports
 * `['generateContent', 'countTokens', 'createCachedContent', 'batchGenerateContent']`
 * for `gemini-flash-latest`, while `POST .../gemini-flash-latest:streamGenerateContent?alt=sse`
 * answers 200 with SSE frames.
 *
 * Reading the absence as a denial made this adapter advertise
 * `streaming: false` for **every** Gemini model. The capability guard then
 * refused the request, which meant the capability doctor's streaming probe
 * could never run — so the one mechanism in this build that would have caught
 * the mistake was the mechanism the mistake disabled. Gemini streaming was
 * off, everywhere, and nothing said so.
 *
 * So the presence of `generateContent` is taken as positive evidence and the
 * absence of its streaming sibling as no evidence at all. That is this
 * adapter's advertised baseline; the doctor's real probe is what settles it,
 * which is the arrangement every other capability here already has.
 */
function capabilitiesFromModel(model: string, reported: WireModel): ModelCapabilities {
  const methods = reported.supportedGenerationMethods;
  const known = Array.isArray(methods) && methods.length > 0;
  const generative = !NON_GENERATIVE_HINTS.some((hint) => model.toLowerCase().includes(hint));
  const text = known ? methods.includes('generateContent') : generative;

  return {
    text,
    streaming: text,
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

/**
 * Whether Google is complaining about the quota project rather than the model.
 *
 * Google's documented behaviour for a **user-credential** call to a
 * client-based API: *"If your API call returns an error message saying that
 * user credentials are not supported or that the quota project is not set, you
 * must explicitly set the quota project by including the `x-goog-user-project`
 * header."* That is a configuration gap with a specific fix, and the shared
 * message for the same status — *"the key was accepted but is not permitted to
 * use this model"* — would send the user to change their model, which cannot
 * help and mentions a key they may not have.
 *
 * Matched on Google's own phrases rather than echoed. The body is
 * attacker-influenceable text in general and a provider's error body can echo
 * a credential, so what is read is whether a known phrase is *present*; the
 * sentence the user sees is this build's.
 */
function namesTheQuotaProject(detail: string | undefined): boolean {
  if (detail === undefined) return false;
  const lowered = detail.toLowerCase();
  return (
    lowered.includes('quota project') ||
    lowered.includes('user credentials are not supported') ||
    lowered.includes('x-goog-user-project')
  );
}

/**
 * Whether Google is saying the model is retired rather than misspelled.
 *
 * Both arrive as `NOT_FOUND`, and the fix is the opposite in each case. A
 * misspelled id should send the user to the model list. A retired one must
 * not: it **is** in the list. Live, `GET /v1beta/models` offers
 * `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-2.5-flash-lite` as its
 * first three generative entries, and a `generateContent` call on each answers
 * 404 *"This model … is no longer available to new users."*
 *
 * So the shared sentence — *"Check it against the model list"* — was being
 * shown in the one case where checking the list confirms the user was right
 * and leaves them believing this extension is broken.
 *
 * Matched on Google's own phrases rather than echoed, for the same reason
 * `namesTheQuotaProject` is: a provider's error body is
 * attacker-influenceable in general and can echo a credential, so what is read
 * is whether a known phrase is *present* and the sentence shown is this
 * build's.
 */
function namesARetiredModel(detail: string | undefined): boolean {
  if (detail === undefined) return false;
  const lowered = detail.toLowerCase();
  return (
    lowered.includes('no longer available') ||
    lowered.includes('has been deprecated') ||
    lowered.includes('is deprecated') ||
    lowered.includes('has been retired')
  );
}

/**
 * How long Google said to wait, from the error body.
 *
 * **Google sends no `Retry-After` header.** Measured, not assumed: driving the
 * free tier past its fifteen-requests-per-minute limit returns 429 with the
 * header **absent** and the guidance in the body instead —
 *
 * ```json
 * { "error": { "status": "RESOURCE_EXHAUSTED", "details": [
 *   { "@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [...] },
 *   { "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "11s" }
 * ] } }
 * ```
 *
 * That matters more than it looks. The retry policy was just taught to honour
 * server guidance over its own backoff, and `retryAfterMs(response)` reads the
 * header — so for the provider most likely to rate-limit, on the free tier
 * this product is built around, the new behaviour would never have engaged.
 * The agent would retry after about eight seconds when Google had said eleven,
 * collect another 429, and spend its three attempts getting nowhere.
 *
 * `retryDelay` is a protobuf `Duration` rendered as a string: seconds with an
 * optional fractional part and a trailing `s`. Parsed defensively because it
 * arrives in an error body, which is attacker-influenceable in general: a
 * value that is not a plain duration is treated as no guidance at all rather
 * than coerced into a number.
 */
export function retryDelayFromDetails(body: unknown): number | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const details = (body as { details?: unknown }).details;
  if (!Array.isArray(details)) return undefined;

  for (const entry of details) {
    if (entry === null || typeof entry !== 'object') continue;
    const type = (entry as { '@type'?: unknown })['@type'];
    if (typeof type !== 'string' || !type.endsWith('google.rpc.RetryInfo')) continue;
    const delay = (entry as { retryDelay?: unknown }).retryDelay;
    if (typeof delay !== 'string') continue;
    // `11s`, `1.5s`, `0.100s`. Nothing else, and no unit but seconds: the
    // field is documented as a Duration and a Duration is always seconds.
    const match = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(delay.trim());
    if (match === null) continue;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    return Math.round(seconds * 1000);
  }
  return undefined;
}

function failureFromError(
  error: WireError,
  retry: number | undefined,
  fallbackMessage: string,
  detail?: string,
  options: { readonly bearer?: boolean; readonly quotaProject?: string } = {},
): ProviderFailure {
  const category = categoryForStatusEnum(error.status, error.code);

  // Only for a bearer credential: a key request cannot be short a quota
  // project, so reading the same phrase there would be a coincidence.
  const quotaProjectMissing = options.bearer === true && namesTheQuotaProject(detail);

  const userMessage = quotaProjectMissing
    ? options.quotaProject === undefined
      ? 'Google needs to know which Cloud project to meter this against. This build has no ' +
        'quota project configured — see docs/release/OWNER-CHECKLIST.md section G-6, or ' +
        'connect with a Gemini API key instead.'
      : 'Google refused the Cloud project this build names for billing and quota. Check that ' +
        'the project exists, has the Generative Language API enabled, and that the authorized ' +
        'account may use it.'
    : category === 'authentication_failed'
      ? options.bearer === true
        ? 'Google rejected the authorization. Connect the Google account again.'
        : 'The API key was rejected. Check the key and that it is enabled for this API.'
      : category === 'access_denied'
        ? options.bearer === true
          ? 'The authorized account is not permitted to use this model, or the Generative ' +
            'Language API is not enabled on its project.'
          : 'The key was accepted but is not permitted to use this model.'
        : category === 'unsupported_capability'
          ? namesARetiredModel(detail)
            ? 'This model is still listed but Google has retired it for this account. Choose a ' +
              'different model — a current one from the list will work.'
            : 'The model id was not found. Check it against the model list.'
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

/**
 * Normalises an HTTP failure.
 *
 * `secret` is the credential this request was made with, threaded down so the
 * provider's own error body cannot hand it back to us — see `readErrorBody`.
 * Passed explicitly rather than read from ambient state, because the thing
 * that must not emit a secret should be given it deliberately.
 */
async function toHttpFailure(
  response: Response,
  secret?: string,
  options: { readonly bearer?: boolean; readonly quotaProject?: string } = {},
): Promise<ProviderFailure> {
  const raw = await readErrorBody(response, { ...(secret === undefined ? {} : { secret }) });
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
    // The header first, for the day Google starts sending one; the body
    // otherwise, which is where it actually is today.
    retryAfterMs(response) ?? retryDelayFromDetails(error),
    `The provider returned ${response.status}.`,
    raw,
    options,
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
