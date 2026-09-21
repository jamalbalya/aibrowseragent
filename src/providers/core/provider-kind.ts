/**
 * Provider kind and runtime state (Stage 3 D1).
 *
 * Two providers can share an authentication mechanism and still be entirely
 * different things. An API endpoint authenticated with a key and a web
 * application authenticated with a key are the same `AuthKind` and nothing
 * else alike: one is a documented request/response contract, the other is a
 * rendered interface whose markup can change without notice and whose content
 * is untrusted by definition.
 *
 * So kind and auth are separate axes. Encoding "this is a web provider" inside
 * the auth type would make every future security decision read the wrong
 * field, and would make a provider's trust properties depend on how it happens
 * to authenticate.
 *
 * Nothing here performs inference. This is the vocabulary the registry and the
 * task runtime use to talk about providers; D4 and D5 remain closed.
 */

export const PROVIDER_KINDS = ['api', 'web'] as const;

/**
 * - `api` a documented endpoint the extension calls directly
 * - `web` an authenticated web application the user is signed into
 */
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Runtime state of a provider connection.
 *
 * Six states, derived from what the codebase actually needs rather than from
 * an exhaustive enumeration. `UNKNOWN` is absent on purpose: a provider that
 * has never been configured is `UNCONFIGURED`, and there is no third thing for
 * a state machine to represent. `UNSUPPORTED` is absent for a different
 * reason — it is a fact about the registry, not a state a connection passes
 * through; an unregistered provider has no state because it has no instance.
 */
export const PROVIDER_STATES = [
  'UNCONFIGURED',
  'NEEDS_AUTH',
  'AUTHENTICATING',
  'READY',
  'UNAVAILABLE',
  'DENIED',
] as const;

export type ProviderState = (typeof PROVIDER_STATES)[number];

/**
 * Why a state was entered. Recorded so a pause is explainable to the user and
 * auditable afterwards — "not ready" with no reason is not actionable.
 */
export type ProviderStateReason =
  | 'not_configured'
  | 'no_session'
  | 'session_expired'
  | 'login_opened'
  | 'authenticated'
  | 'origin_changed'
  | 'tab_closed'
  | 'provider_unreachable'
  | 'access_refused'
  | 'ambiguous_signal'
  | 'user_cancelled';

export interface ProviderStatus {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly state: ProviderState;
  readonly reason: ProviderStateReason;
  /** Canonical origin this status was established against, for web providers. */
  readonly origin?: string;
  readonly since: number;
}

/**
 * Permitted transitions.
 *
 * Written as an explicit table rather than as scattered `if` statements so
 * that "can this provider become READY from here?" has one answer in one
 * place. The table is the security property: the only route into `READY` is
 * from `AUTHENTICATING`, so a provider cannot be declared usable without
 * having passed through a step that required a confirmed signal.
 */
const TRANSITIONS: Record<ProviderState, readonly ProviderState[]> = {
  // A configured API provider is usable immediately; a web provider is not.
  UNCONFIGURED: ['NEEDS_AUTH', 'READY', 'UNAVAILABLE', 'DENIED'],
  NEEDS_AUTH: ['AUTHENTICATING', 'UNAVAILABLE', 'DENIED', 'UNCONFIGURED'],
  // Deliberately no NEEDS_AUTH -> READY edge.
  AUTHENTICATING: ['READY', 'NEEDS_AUTH', 'UNAVAILABLE', 'DENIED'],
  READY: ['NEEDS_AUTH', 'UNAVAILABLE', 'DENIED', 'UNCONFIGURED'],
  UNAVAILABLE: ['NEEDS_AUTH', 'AUTHENTICATING', 'READY', 'DENIED', 'UNCONFIGURED'],
  // Access refused is terminal for this provider until it is reconfigured.
  DENIED: ['UNCONFIGURED'],
};

export function canTransition(from: ProviderState, to: ProviderState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Reasons that may accompany entry into `READY`.
 *
 * A provider becomes ready because authentication was confirmed, and for no
 * other reason. Listing the permitted reasons — rather than accepting any —
 * closes the path where a caller reports success with a reason that says
 * something else happened.
 */
const READY_REASONS: readonly ProviderStateReason[] = ['authenticated'];

export interface TransitionResult {
  readonly status: ProviderStatus;
  readonly changed: boolean;
}

/**
 * Applies a transition, or refuses it.
 *
 * Refusing returns the unchanged status rather than throwing: an out-of-order
 * signal — a stale tab event arriving after the user cancelled, say — is a
 * normal occurrence and should leave the provider where it was, not crash the
 * task that was waiting on it.
 */
export function transitionProvider(
  current: ProviderStatus,
  to: ProviderState,
  reason: ProviderStateReason,
  now: number,
  origin?: string,
): TransitionResult {
  if (!canTransition(current.state, to)) return { status: current, changed: false };

  // The one edge that must not be reachable by accident.
  if (to === 'READY' && !READY_REASONS.includes(reason)) {
    return { status: current, changed: false };
  }

  return {
    status: {
      ...current,
      state: to,
      reason,
      ...(origin === undefined ? {} : { origin }),
      since: now,
    },
    changed: true,
  };
}

/** Initial status for a provider that has not been configured. */
export function initialStatus(providerId: string, kind: ProviderKind, now: number): ProviderStatus {
  return { providerId, kind, state: 'UNCONFIGURED', reason: 'not_configured', since: now };
}

/** Whether a provider may currently be used to run a task. */
export function isUsable(status: ProviderStatus): boolean {
  return status.state === 'READY';
}

/**
 * Whether the task should wait for a person rather than fail.
 *
 * `AUTHENTICATING` means a human is part way through a login the extension
 * must not touch. That is not a stalled automation and must never be resolved
 * by a timeout — see the runtime, which maps this to `WAITING_FOR_USER`.
 */
export function awaitsHuman(status: ProviderStatus): boolean {
  return status.state === 'AUTHENTICATING';
}
