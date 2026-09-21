/**
 * Canonical error taxonomy (specification section 60).
 *
 * Every failure surfaced by a tool, provider, connector or the runtime maps to
 * one of these codes. The list is closed on purpose: unknown failures must be
 * classified explicitly rather than leaking raw exception text to the model.
 */
export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'PERMISSION_DENIED',
  'POLICY_BLOCKED',
  'TOOL_NOT_FOUND',
  'INVALID_ARGUMENT',
  'ELEMENT_NOT_FOUND',
  'ELEMENT_NOT_INTERACTABLE',
  'TAB_NOT_FOUND',
  'NAVIGATION_TIMEOUT',
  'NETWORK_ERROR',
  'CONNECTOR_ERROR',
  'RATE_LIMITED',
  'MODEL_ERROR',
  'MODEL_UNSUPPORTED',
  'TOOL_CALL_INVALID',
  'CONTEXT_LIMIT',
  'TASK_TIMEOUT',
  'LOOP_DETECTED',
  'USER_CANCELLED',
  'ORIGIN_CHANGED',
  'BUDGET_EXHAUSTED',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
  'DEBUGGER_UNAVAILABLE',
  'PAGE_NOT_READY',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A structured failure.
 *
 * `userMessage` is safe to render in the UI. `technicalDetails` may contain
 * implementation specifics and must be redacted before it reaches a model or a
 * persisted log.
 */
export interface AgentError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly userMessage: string;
  readonly recoverable: boolean;
  readonly retryable: boolean;
  readonly technicalDetails?: string;
}

/** Failure codes that are never worth retrying (specification section 73). */
const NON_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PERMISSION_DENIED',
  'POLICY_BLOCKED',
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'INVALID_ARGUMENT',
  'TOOL_CALL_INVALID',
  'TOOL_NOT_FOUND',
  'MODEL_UNSUPPORTED',
  'USER_CANCELLED',
  'LOOP_DETECTED',
  'BUDGET_EXHAUSTED',
  'NOT_IMPLEMENTED',
  'ORIGIN_CHANGED',
]);

/** Transient failures that a bounded retry may resolve. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'NAVIGATION_TIMEOUT',
  'ELEMENT_NOT_FOUND',
  'ELEMENT_NOT_INTERACTABLE',
  'PAGE_NOT_READY',
  'CONNECTOR_ERROR',
]);

export function isRetryableCode(code: ErrorCode): boolean {
  if (NON_RETRYABLE.has(code)) return false;
  return RETRYABLE.has(code);
}

export interface AgentErrorInit {
  readonly userMessage?: string;
  readonly recoverable?: boolean;
  readonly retryable?: boolean;
  readonly technicalDetails?: string;
}

export function createError(
  code: ErrorCode,
  message: string,
  init: AgentErrorInit = {},
): AgentError {
  const retryable = init.retryable ?? isRetryableCode(code);
  return {
    code,
    message,
    userMessage: init.userMessage ?? message,
    recoverable: init.recoverable ?? retryable,
    retryable,
    ...(init.technicalDetails === undefined ? {} : { technicalDetails: init.technicalDetails }),
  };
}

/** Thrown inside tool implementations; converted to an `AgentError` at the boundary. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly init: AgentErrorInit;

  constructor(code: ErrorCode, message: string, init: AgentErrorInit = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.init = init;
  }

  toAgentError(): AgentError {
    return createError(this.code, this.message, this.init);
  }
}

export type Result<T, E = AgentError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
