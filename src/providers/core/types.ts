/**
 * Provider-neutral AI interface (specification sections 12, 13, 47, 69).
 *
 * The agent runtime speaks only this vocabulary. Nothing below this line knows
 * that OpenAI, Anthropic or Gemini exist; nothing above it knows about HTTP.
 * That separation is what makes the invariant hold: changing the AI brain must
 * not remove the agent body's capabilities.
 */
import type { EgressContext, ProviderTransport } from '@/security/egress/provider-transport';
import type { ProviderKind } from './provider-kind';
import type { AgentError } from '@/types/result';

/** Canonical content parts. */
export type CanonicalContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      /** Base64 payload without a data: prefix. */
      readonly data: string;
      readonly mimeType: string;
    }
  | {
      readonly type: 'tool_call';
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly name: string;
      /** JSON-encoded result envelope. */
      readonly content: string;
      readonly isError: boolean;
    };

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';

export interface CanonicalMessage {
  readonly role: CanonicalRole;
  readonly content: readonly CanonicalContent[];
}

/** Provider-neutral tool declaration (specification section 71). */
export interface CanonicalToolSchema {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  /** JSON Schema draft 2020-12 object schema. */
  readonly parameters: Record<string, unknown>;
}

export interface CanonicalRequest {
  readonly systemInstruction: string;
  readonly messages: readonly CanonicalMessage[];
  readonly tools?: readonly CanonicalToolSchema[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /**
   * Security context for the outbound request.
   *
   * Carried on the request rather than held ambiently because tasks can run
   * concurrently, and an ambient "current task" would attribute one task's
   * request to another's taint. An adapter that omits it is refused by the
   * transport.
   */
  readonly egress?: EgressContext;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export type FinishReason =
  'stop' | 'tool_call' | 'length' | 'content_filter' | 'cancelled' | 'error';

export interface CanonicalToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /** Present when the provider returned arguments that were not valid JSON. */
  readonly parseError?: string;
}

export interface CanonicalResponse {
  readonly text: string;
  readonly toolCalls: readonly CanonicalToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  /** Provider-specific extras. Never interpreted by the runtime. */
  readonly providerMetadata?: Record<string, unknown>;
}

export type CanonicalEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | { readonly type: 'tool_call'; readonly toolCall: CanonicalToolCall }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'done'; readonly response: CanonicalResponse }
  | { readonly type: 'error'; readonly error: AgentError };

/**
 * Capabilities a single request can ask for.
 *
 * Declared here rather than in `capability-guard.ts` because
 * `ModelCapabilities.unverified` has to name them, and the guard imports this
 * module. `capability-guard.ts` re-exports both so its own callers are
 * unaffected.
 */
export const REQUESTABLE_CAPABILITIES = [
  'vision',
  'toolCalling',
  'streaming',
  'systemInstruction',
] as const;

export type RequestableCapability = (typeof REQUESTABLE_CAPABILITIES)[number];

/** Capability matrix (specification section 69). */
export interface ModelCapabilities {
  readonly text: boolean;
  readonly streaming: boolean;
  readonly toolCalling: boolean;
  readonly parallelToolCalling: boolean;
  readonly vision: boolean;
  readonly structuredOutput: boolean;
  readonly fileInput: boolean;
  readonly audioInput: boolean;
  /**
   * Whether the provider accepts a system instruction as a first-class field.
   *
   * Separate from `text` because the three API families place it in three
   * different positions, and a provider that has no such field would need the
   * instruction folded into the conversation — a downgrade the caller has to
   * be told about rather than one the adapter performs quietly.
   */
  readonly systemInstruction: boolean;
  /** Whether the endpoint exposes a model list to discover from. */
  readonly modelListing: boolean;
  /** Maximum input tokens, or null when the provider does not report one. */
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  /**
   * Capabilities this report cannot speak for: **probe required**, not absent.
   *
   * A boolean has two values and a capability has three states — confirmed
   * supported, confirmed unsupported, and not yet established. Collapsing the
   * third into `false` is what made a gateway model's vision permanently
   * unavailable: the adapter honestly could not know, wrote `false`, and every
   * reader downstream — including the probe that existed to settle it — read
   * that as "this model has no vision".
   *
   * So a capability named here has a boolean that is a **conservative
   * placeholder**, and the authority is `CapabilityDoctor`. Two rules follow,
   * and `capability-guard.ts` and `capability-doctor.ts` enforce them:
   *
   *  - a request for an unverified capability is refused **explicitly**, as
   *    `capability_unverified` rather than `unsupported_capability`, so the
   *    answer is "run the doctor" and never a silent "no";
   *  - the doctor **probes** an unverified capability instead of skipping it,
   *    and its measurement is what clears the entry.
   *
   * Absent or empty means every boolean above is a claim. Only the four
   * requestable capabilities can appear, because they are the four the doctor
   * measures and the four a request can ask for.
   */
  readonly unverified?: readonly RequestableCapability[];
}

/** Whether `capability` is a placeholder in `capabilities` rather than a claim. */
export function isUnverified(
  capabilities: ModelCapabilities,
  capability: RequestableCapability,
): boolean {
  return capabilities.unverified?.includes(capability) ?? false;
}

/**
 * The same capabilities with `capability` settled at `supported`.
 *
 * Used by the doctor, which is the only thing entitled to resolve the third
 * state: a measurement replaces the placeholder and removes the entry.
 */
export function asVerified(
  capabilities: ModelCapabilities,
  capability: RequestableCapability,
  supported: boolean,
): ModelCapabilities {
  const left = (capabilities.unverified ?? []).filter((entry) => entry !== capability);
  // `unverified` is always written, including as an empty list: "measured, and
  // the list is now empty" and "never had a list" must not be the same value.
  return { ...capabilities, [capability]: supported, unverified: left };
}

export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  text: false,
  streaming: false,
  toolCalling: false,
  parallelToolCalling: false,
  vision: false,
  structuredOutput: false,
  fileInput: false,
  audioInput: false,
  systemInstruction: false,
  modelListing: false,
  contextWindow: null,
  maxOutputTokens: null,
  // Every boolean above is a placeholder here, not a claim: this constant is
  // what a connection holds before the doctor has run on it. Naming them keeps
  // "no measurement yet" distinguishable from "measured, and absent".
  unverified: REQUESTABLE_CAPABILITIES,
};

export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
  /**
   * Which group this model belongs to, for a provider that has groups.
   *
   * A gateway fronts several upstream providers at once, so its catalogue is a
   * hierarchy rather than a list, and this is the opaque key of the level above
   * the model. Optional because a single-upstream provider has no such level —
   * and it is a *key*, never a label: two upstreams can present the same label,
   * and a UI that keyed on the label would merge them and send a request to
   * whichever won.
   */
  readonly upstreamKey?: string;
  /**
   * Capabilities as *advertised*. These are a starting point only — the
   * capability doctor verifies them before the UI reports Agent Ready.
   */
  readonly advertisedCapabilities?: Partial<ModelCapabilities>;
}

export type AuthKind = 'api_key' | 'oauth' | 'none';

export interface ProviderConfig {
  readonly providerId: string;
  readonly baseUrl?: string;
  /**
   * Credential material. Held only in the credential store and passed straight
   * into the adapter; it is never copied into task records, logs or evidence.
   */
  readonly apiKey?: string;
  readonly model?: string;
  /**
   * Capabilities already **measured** for `model` on this connection.
   *
   * Supplied by the runtime, which holds the doctor's report and the
   * `capabilityScope` proving which (connection, model) pair it was taken on.
   * The adapter returns these from `getCapabilities` for that exact model, so
   * the pre-flight check in `generate`/`stream` reads a measurement when one
   * exists and the advertised placeholder when none does — one capability
   * system, with the doctor at the top of it.
   *
   * Scoped by construction: the runtime only passes a measurement whose scope
   * matches, and the adapter only returns it for an exact `modelId` match, so a
   * measurement cannot leak to another model or another account.
   */
  readonly measuredCapabilities?: ModelCapabilities;
  readonly organization?: string;
  readonly project?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /**
   * How `apiKey` is presented to the endpoint.
   *
   * `api_key` — the vendor's own key header, which is what every pasted
   * credential uses and what an adapter does by default.
   * `bearer` — `Authorization: Bearer <token>`, for a connection authorized by
   * OAuth, where the credential is an access token rather than a key.
   *
   * On the config rather than inferred from the value, for the reason the
   * connector framework put `credentialHeader` on the descriptor: a key and a
   * token are both opaque strings, and guessing which header a string wants by
   * looking at it is how a credential gets sent in a header the endpoint
   * ignores — an unauthenticated request with the user's credential attached
   * to it. Only an adapter whose provider documents both needs to read it.
   */
  readonly credentialScheme?: 'api_key' | 'bearer';
  /**
   * The Google Cloud project to meter an OAuth-authorized call against.
   *
   * Sent as `x-goog-user-project`, and **only** alongside a bearer credential.
   * Google documents that a user-credential call to a client-based API must
   * name a quota project, and answers one that does not with a message about
   * exactly that. A key carries its own project, so a key request must not send
   * this — it would name a second project for the same call.
   *
   * Validated before it gets here (`parseQuotaProject`), because it travels in
   * a header and an unvalidated header value is header injection.
   */
  readonly quotaProject?: string;
}

export interface AuthResult {
  readonly authenticated: boolean;
  readonly error?: AgentError;
  /** Non-secret identity shown in the UI, e.g. a masked key suffix. */
  readonly accountLabel?: string;
}

export interface HealthResult {
  readonly reachable: boolean;
  readonly latencyMs?: number;
  readonly error?: AgentError;
}

/**
 * The contract every AI provider adapter implements.
 *
 * `stream` and `generateWithTools` are optional: an adapter declares what it
 * genuinely supports, and the capability doctor verifies the claim rather than
 * trusting it.
 */
export interface AIProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly authKind: AuthKind;

  connect(config: ProviderConfig): Promise<AuthResult>;
  disconnect(): Promise<void>;

  listModels(): Promise<ModelInfo[]>;
  getCapabilities(model: string): Promise<ModelCapabilities>;
  validateConnection(): Promise<HealthResult>;

  generate(request: CanonicalRequest): Promise<CanonicalResponse>;
  stream?(request: CanonicalRequest): AsyncIterable<CanonicalEvent>;
}

/**
 * Operations an adapter genuinely implements.
 *
 * Declared per factory so the registry can answer "can this provider stream?"
 * without constructing an adapter and probing it, and so that a provider that
 * omits one is visibly missing it rather than failing at the call site.
 */
export const PROVIDER_OPERATIONS = [
  'generate',
  'stream',
  'listModels',
  'validateConnection',
  'toolCalling',
  'vision',
] as const;

export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number];

/** How an endpoint is addressed. */
export interface BaseUrlRequirement {
  /**
   * Whether the user must supply one.
   *
   * False for a provider with a single documented endpoint; true for one
   * whose whole purpose is to point somewhere the user chooses.
   */
  readonly required: boolean;
  readonly defaultUrl?: string;
}

/** Factory registered with the provider registry. */
export interface ProviderFactory {
  readonly id: string;
  readonly displayName: string;
  /**
   * What sort of provider this is, independent of how it authenticates.
   *
   * An API endpoint and a web application can share an `authKind` and share
   * nothing else: one has a documented contract, the other has markup that
   * changes without notice and content that is untrusted by definition.
   */
  readonly kind: ProviderKind;
  readonly authKind: AuthKind;
  readonly description: string;
  readonly baseUrl: BaseUrlRequirement;
  readonly operations: readonly ProviderOperation[];
  /**
   * Capabilities the adapter implements, before any particular model.
   *
   * A floor, not a promise about a model: `getCapabilities` narrows this per
   * model and the capability doctor verifies what is left. A capability that
   * is false here is one the adapter has no code for at all.
   */
  readonly baselineCapabilities: ModelCapabilities;
  /**
   * Whether the adapter must be built with a guarded transport.
   *
   * Always true, and stated rather than assumed: a future entry that set it
   * to false would have to say so in the registry, where it is reviewable,
   * instead of quietly constructing its own way out.
   */
  readonly requiresGuardedTransport: true;
  /**
   * Builds an adapter.
   *
   * The transport is supplied by the registry and is the adapter's only route
   * to the network. Omitting it yields one that refuses every request, so a
   * provider constructed outside the registry cannot reach out unguarded.
   */
  create(transport: ProviderTransport): AIProviderAdapter;
}

export const textMessage = (role: CanonicalRole, text: string): CanonicalMessage => ({
  role,
  content: [{ type: 'text', text }],
});

/** Flattens the text parts of a message, ignoring tool and image parts. */
export function messageText(message: CanonicalMessage): string {
  return message.content
    .filter((part): part is Extract<CanonicalContent, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
