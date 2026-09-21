/**
 * Provider-neutral AI interface (specification sections 12, 13, 47, 69).
 *
 * The agent runtime speaks only this vocabulary. Nothing below this line knows
 * that OpenAI, Anthropic or Gemini exist; nothing above it knows about HTTP.
 * That separation is what makes the invariant hold: changing the AI brain must
 * not remove the agent body's capabilities.
 */
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
  /** Maximum input tokens, or null when the provider does not report one. */
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
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
  contextWindow: null,
  maxOutputTokens: null,
};

export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
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
  readonly organization?: string;
  readonly project?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
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
  readonly authKind: AuthKind;

  connect(config: ProviderConfig): Promise<AuthResult>;
  disconnect(): Promise<void>;

  listModels(): Promise<ModelInfo[]>;
  getCapabilities(model: string): Promise<ModelCapabilities>;
  validateConnection(): Promise<HealthResult>;

  generate(request: CanonicalRequest): Promise<CanonicalResponse>;
  stream?(request: CanonicalRequest): AsyncIterable<CanonicalEvent>;
}

/** Factory registered with the provider registry. */
export interface ProviderFactory {
  readonly id: string;
  readonly displayName: string;
  readonly authKind: AuthKind;
  readonly description: string;
  create(): AIProviderAdapter;
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
