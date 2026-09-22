/**
 * OAuth 2.0 authorization code flow with PKCE.
 *
 * Every mechanism here exists because of a specific attack, and the comments
 * name it rather than describing the mechanics:
 *
 *  - **PKCE** (RFC 7636). The authorization code travels through a browser
 *    redirect, which means through a URL, which means through history,
 *    referrers and anything watching navigations. A stolen code is useless
 *    without the verifier, which never leaves this extension.
 *  - **State**, unpredictable and single-use. Without it any site could send
 *    the user to our callback with a code of the attacker's choosing and the
 *    extension would attach the attacker's account to the user's connector.
 *  - **Binding state to the connector**. A callback that validates state but
 *    not which connector it belongs to lets a response for one service
 *    complete an authorization for another.
 *  - **Exact redirect matching**. A prefix match on the redirect URI is an
 *    open redirect: `https://ok.example.evil.test/` starts with
 *    `https://ok.example`.
 *
 * Nothing here performs I/O. Building a URL and validating a callback are
 * pure, which is what lets every one of those cases be tested exhaustively.
 */

import { canonicalUrlIdentity } from '@/security/egress/destination';

/** How long an unfinished authorization stays valid. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

export interface AuthorizationRequest {
  readonly connectorId: string;
  readonly clientId: string;
  readonly authorizationEndpoint: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Extra parameters a provider documents, e.g. `prompt=consent`. */
  readonly extraParams?: Readonly<Record<string, string>>;
}

/**
 * The half of an in-flight authorization that stays in the extension.
 *
 * The verifier is the secret that makes a stolen code worthless, so it is
 * held here and never put in a URL, a log or a record.
 */
export interface PendingAuthorization {
  readonly connectorId: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
}

export interface PreparedAuthorization {
  readonly url: string;
  readonly pending: PendingAuthorization;
}

export type CallbackRejection =
  | 'NO_PENDING_AUTHORIZATION'
  | 'STATE_MISSING'
  | 'STATE_MISMATCH'
  | 'STATE_EXPIRED'
  | 'REDIRECT_MISMATCH'
  | 'CONNECTOR_MISMATCH'
  | 'CODE_MISSING'
  | 'PROVIDER_ERROR'
  | 'MALFORMED_CALLBACK';

export type CallbackResult =
  | { readonly ok: true; readonly code: string; readonly pending: PendingAuthorization }
  | { readonly ok: false; readonly code: CallbackRejection; readonly reason: string };

/** Base64url without padding, as PKCE and state both require. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * A code verifier.
 *
 * 32 random bytes, which is 43 base64url characters — the minimum RFC 7636
 * permits is 43 and the guidance is at least 256 bits of entropy.
 */
export function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

/** S256 challenge. `plain` is not offered: it defeats the point of PKCE. */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Unpredictable state. Same entropy as the verifier; both are anti-guessing. */
export function createState(): string {
  return base64Url(randomBytes(32));
}

/**
 * Builds the authorization URL and the pending record that must survive until
 * the callback arrives.
 *
 * The redirect URI is validated here rather than trusted: a connector
 * descriptor with a malformed or non-absolute redirect would otherwise
 * produce an authorization request whose callback could never be matched
 * exactly, and a callback that cannot be matched exactly is one that has to
 * be matched loosely.
 */
export async function prepareAuthorization(
  request: AuthorizationRequest,
  now: number,
): Promise<PreparedAuthorization> {
  if (canonicalUrlIdentity(request.authorizationEndpoint) === null) {
    throw new Error('The authorization endpoint is not a usable URL.');
  }
  if (canonicalUrlIdentity(request.redirectUri) === null) {
    throw new Error('The redirect URI is not a usable URL.');
  }

  const codeVerifier = createCodeVerifier();
  const challenge = await createCodeChallenge(codeVerifier);
  const state = createState();

  const url = new URL(request.authorizationEndpoint);
  // Set rather than append, so an endpoint that already carried one of these
  // cannot end up sending two and letting the provider pick.
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (request.scopes.length > 0) url.searchParams.set('scope', request.scopes.join(' '));
  for (const [key, value] of Object.entries(request.extraParams ?? {})) {
    // Reserved parameters are not overridable from a descriptor: that would
    // let one turn PKCE off or point the redirect somewhere else.
    if (RESERVED_PARAMS.has(key)) continue;
    url.searchParams.set(key, value);
  }

  return {
    url: url.toString(),
    pending: {
      connectorId: request.connectorId,
      state,
      codeVerifier,
      redirectUri: request.redirectUri,
      scopes: [...request.scopes],
      createdAt: now,
    },
  };
}

const RESERVED_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'code',
]);

/**
 * Whether a navigation is this authorization's callback.
 *
 * Origin **and** path must match exactly. A prefix comparison would accept
 * `https://callback.example.attacker.test/cb`, and a path-prefix comparison
 * would accept `/cb-evil`.
 */
export function isCallbackUrl(candidate: string, redirectUri: string): boolean {
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(candidate);
    expected = new URL(redirectUri);
  } catch {
    return false;
  }
  return (
    actual.origin.toLowerCase() === expected.origin.toLowerCase() &&
    actual.pathname === expected.pathname
  );
}

/**
 * Validates a callback against the authorization that is actually pending.
 *
 * Order matters. The provider's own `error` is reported before anything else
 * so a user who declined sees that rather than a state complaint; after that
 * every check that could let a foreign response through runs before the code
 * is looked at, so a rejected callback never reveals whether a code was
 * present.
 */
export function validateCallback(
  callbackUrl: string,
  pending: PendingAuthorization | undefined,
  now: number,
): CallbackResult {
  if (!pending) {
    return {
      ok: false,
      code: 'NO_PENDING_AUTHORIZATION',
      reason: 'No authorization was in progress, so this callback was not expected.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    return { ok: false, code: 'MALFORMED_CALLBACK', reason: 'The callback URL is not a URL.' };
  }

  if (!isCallbackUrl(callbackUrl, pending.redirectUri)) {
    return {
      ok: false,
      code: 'REDIRECT_MISMATCH',
      reason: 'The callback did not arrive at the redirect URI this authorization registered.',
    };
  }

  const providerError = parsed.searchParams.get('error');
  if (providerError !== null) {
    return {
      ok: false,
      code: 'PROVIDER_ERROR',
      // The provider's own code, which is a fixed vocabulary such as
      // `access_denied`. Its description is not echoed: it is attacker-
      // influenced text on a URL anyone can navigate to.
      reason: `The service refused the authorization (${providerError.slice(0, 64)}).`,
    };
  }

  const state = parsed.searchParams.get('state');
  if (state === null) {
    return { ok: false, code: 'STATE_MISSING', reason: 'The callback carried no state value.' };
  }
  if (!timingSafeEqual(state, pending.state)) {
    return {
      ok: false,
      code: 'STATE_MISMATCH',
      reason: 'The callback state did not match the authorization that was started.',
    };
  }
  if (now - pending.createdAt > AUTHORIZATION_TTL_MS) {
    return {
      ok: false,
      code: 'STATE_EXPIRED',
      reason: 'The authorization took too long to complete. Start it again.',
    };
  }

  const code = parsed.searchParams.get('code');
  if (code === null || code.length === 0) {
    return {
      ok: false,
      code: 'CODE_MISSING',
      reason: 'The callback carried no authorization code.',
    };
  }

  return { ok: true, code, pending };
}

/**
 * Constant-time string comparison.
 *
 * State comparison is a secret comparison. An early-exit compare leaks a
 * prefix oracle, and while exploiting one through a browser redirect is
 * awkward, the cost of not having the weakness is a loop.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
