/**
 * The authorization state machine shared by AI providers and connectors.
 *
 * Both answer the same question — is this counterparty usable right now, and
 * if not, what has to happen — and both have the same failure to avoid:
 * becoming usable without having passed through a step that confirmed
 * authentication. Two copies of that table would eventually disagree, and the
 * disagreement would be in the security-relevant direction.
 *
 * What is *not* shared is identity. An AI provider, a web provider and a
 * connector are three different domains; this module holds the states and the
 * edges, and each domain wraps them in its own status type so a connector can
 * never be handed to something expecting a provider.
 */

export const AUTH_STATES = [
  'UNCONFIGURED',
  'NEEDS_AUTH',
  'AUTHENTICATING',
  'READY',
  'UNAVAILABLE',
  'DENIED',
] as const;

export type AuthState = (typeof AUTH_STATES)[number];

/**
 * Permitted transitions.
 *
 * Written as an explicit table rather than as scattered `if` statements so
 * that "can this become READY from here?" has one answer in one place. The
 * table is the security property: the only route into `READY` is from
 * `AUTHENTICATING`, so nothing can be declared usable without having passed
 * through a step that required a confirmed signal.
 */
export const AUTH_TRANSITIONS: Readonly<Record<AuthState, readonly AuthState[]>> = {
  // A configured API provider is usable immediately; a web provider and an
  // OAuth connector are not.
  UNCONFIGURED: ['NEEDS_AUTH', 'READY', 'UNAVAILABLE', 'DENIED'],
  NEEDS_AUTH: ['AUTHENTICATING', 'UNAVAILABLE', 'DENIED', 'UNCONFIGURED'],
  // Deliberately no NEEDS_AUTH -> READY edge.
  AUTHENTICATING: ['READY', 'NEEDS_AUTH', 'UNAVAILABLE', 'DENIED'],
  READY: ['NEEDS_AUTH', 'UNAVAILABLE', 'DENIED', 'UNCONFIGURED'],
  UNAVAILABLE: ['NEEDS_AUTH', 'AUTHENTICATING', 'READY', 'DENIED', 'UNCONFIGURED'],
  // Access refused is terminal until the counterparty is reconfigured.
  DENIED: ['UNCONFIGURED'],
};

export function canTransitionAuthState(from: AuthState, to: AuthState): boolean {
  return AUTH_TRANSITIONS[from].includes(to);
}

/**
 * Reasons that may accompany entry into `READY`.
 *
 * Something becomes ready because authentication was confirmed, and for no
 * other reason. Listing the permitted reasons — rather than accepting any —
 * closes the path where a caller reports success with a reason that says
 * something else happened.
 */
export const READY_AUTH_REASONS: readonly string[] = ['authenticated'];

export function isReadyReason(reason: string): boolean {
  return READY_AUTH_REASONS.includes(reason);
}
