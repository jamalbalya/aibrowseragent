/**
 * Structured provider failures and the provider-independent error taxonomy.
 *
 * Lives in `providers/core` rather than in any one adapter: the agent runtime
 * must be able to understand a failure from *every* provider without importing
 * from a specific adapter. An adapter that threw its own error class would
 * otherwise have its error code and retry classification silently downgraded
 * to a generic model error.
 *
 * Three provider families report the same failure in three vocabularies —
 * `invalid_request_error`, `RESOURCE_EXHAUSTED`, a bare HTTP 429. The category
 * below is the one vocabulary the rest of the system reasons in; the
 * provider's own wording is kept beside it as diagnostics, never in place of
 * it.
 */
import { createError, type AgentError } from '@/types/result';

/**
 * Provider-independent failure categories (specification section 60).
 *
 * Closed on purpose. A failure that does not fit one of these is classified
 * explicitly rather than passed through as provider text, because the retry
 * decision downstream reads the category and nothing else.
 */
export const PROVIDER_ERROR_CATEGORIES = [
  'authentication_failed',
  'access_denied',
  'rate_limited',
  'transient_provider_failure',
  'invalid_request',
  'unsupported_capability',
  'malformed_response',
  'transport_blocked',
  'provider_unavailable',
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

/**
 * Which canonical error code each category reports as.
 *
 * The mapping decides retryability, because `createError` derives it from the
 * code. Authentication and unsupported capability are terminal: retrying a
 * rejected key or an absent feature burns budget to reach the same answer.
 */
const CATEGORY_CODES: Record<ProviderErrorCategory, AgentError['code']> = {
  authentication_failed: 'AUTH_EXPIRED',
  access_denied: 'PERMISSION_DENIED',
  rate_limited: 'RATE_LIMITED',
  transient_provider_failure: 'MODEL_ERROR',
  invalid_request: 'INVALID_ARGUMENT',
  unsupported_capability: 'MODEL_UNSUPPORTED',
  malformed_response: 'MODEL_ERROR',
  transport_blocked: 'POLICY_BLOCKED',
  provider_unavailable: 'NETWORK_ERROR',
};

/**
 * Categories a bounded retry may resolve.
 *
 * `MODEL_ERROR` covers both a 503 and a reply that did not parse, and only one
 * of those is worth attempting again — so retryability is decided here, by
 * category, rather than left to the code alone.
 */
const RETRYABLE_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set<ProviderErrorCategory>([
  'rate_limited',
  'transient_provider_failure',
  'provider_unavailable',
]);

export function isRetryableCategory(category: ProviderErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

/**
 * A normalised provider failure.
 *
 * `providerCode` keeps the provider's own identity for the failure — its
 * `type` string, its `status` enum — so a diagnostic does not lose which
 * provider said what. It is an identifier, never a message body and never
 * credential material.
 */
export interface ProviderFailure {
  readonly category: ProviderErrorCategory;
  readonly error: AgentError;
  readonly providerId: string;
  readonly providerCode?: string;
  readonly httpStatus?: number;
  /** Server-supplied backoff, when the provider sent one. */
  readonly retryAfterMs?: number;
}

export interface ProviderFailureInit {
  readonly providerCode?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly userMessage?: string;
  readonly technicalDetails?: string;
}

/** Builds a normalised failure from a category and provider diagnostics. */
export function providerFailure(
  providerId: string,
  category: ProviderErrorCategory,
  message: string,
  init: ProviderFailureInit = {},
): ProviderFailure {
  const error = createError(CATEGORY_CODES[category], message, {
    retryable: isRetryableCategory(category),
    ...(init.userMessage === undefined ? {} : { userMessage: init.userMessage }),
    ...(init.technicalDetails === undefined ? {} : { technicalDetails: init.technicalDetails }),
  });
  return {
    category,
    error,
    providerId,
    ...(init.providerCode === undefined ? {} : { providerCode: init.providerCode }),
    ...(init.httpStatus === undefined ? {} : { httpStatus: init.httpStatus }),
    ...(init.retryAfterMs === undefined ? {} : { retryAfterMs: init.retryAfterMs }),
  };
}

export class ProviderRequestError extends Error {
  readonly agentError: AgentError;
  readonly category: ProviderErrorCategory;
  readonly providerId: string;
  readonly providerCode?: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(failure: ProviderFailure) {
    super(failure.error.message);
    this.name = 'ProviderRequestError';
    this.agentError = failure.error;
    this.category = failure.category;
    this.providerId = failure.providerId;
    if (failure.providerCode !== undefined) this.providerCode = failure.providerCode;
    if (failure.httpStatus !== undefined) this.httpStatus = failure.httpStatus;
    if (failure.retryAfterMs !== undefined) this.retryAfterMs = failure.retryAfterMs;
  }

  get failure(): ProviderFailure {
    return {
      category: this.category,
      error: this.agentError,
      providerId: this.providerId,
      ...(this.providerCode === undefined ? {} : { providerCode: this.providerCode }),
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
    };
  }
}

/**
 * Structural check rather than `instanceof`.
 *
 * Adapters may be bundled separately, and a duplicated class identity across
 * bundles would make `instanceof` fail for an error that is perfectly valid.
 */
export function isProviderRequestError(error: unknown): error is { agentError: AgentError } {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = (error as { agentError?: unknown }).agentError;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as AgentError).code === 'string' &&
    typeof (candidate as AgentError).userMessage === 'string'
  );
}

/** Reads the normalised category off a thrown provider failure, if it has one. */
export function failureCategoryOf(error: unknown): ProviderErrorCategory | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = (error as { category?: unknown }).category;
  if (typeof candidate !== 'string') return null;
  return (PROVIDER_ERROR_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as ProviderErrorCategory)
    : null;
}
