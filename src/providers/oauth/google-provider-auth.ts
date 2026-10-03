/**
 * Authorizing a Google account so the agent can use the Gemini API.
 *
 * This is **not** a sign-in to AI Browser Agent. Nothing here creates a
 * product account, a session, or an `abaUserId`; nothing here is required to
 * open the extension or to run a local task. What it produces is one thing: an
 * access token that the Gemini adapter can present as a credential, bound to
 * one connected account like any pasted key. `src/identity/` is the separate,
 * optional product sign-in and the two must not be confused — a user who
 * never signs in can complete this, and a user who signs in has not done it.
 *
 * ## Why Google and no other provider
 *
 * Because Google is the only vendor on this build's list that will issue a
 * third party an authorization an MV3 extension can both obtain and use. The
 * reasons for each of the others are recorded in
 * `providers/accounts/authorization.ts` with their sources, and two of them
 * are worth repeating here because they are the ones people assume away:
 * Anthropic states in writing that a third party must not route a Pro or Max
 * plan, and OpenAI's plan-sharing flow needs no client secret and still cannot
 * be used, because it requires a redirect to a loopback port an extension
 * cannot listen on.
 *
 * ## Why this needs a permission, and which one
 *
 * Google will register exactly one redirect for a Chrome Extension client:
 * `https://<extension-id>.chromiumapp.org/`. That address resolves nowhere and
 * is intercepted only by `chrome.identity.launchWebAuthFlow`, so the tab-
 * watching flow the connectors use — which deliberately avoids
 * `chrome.identity` — cannot receive this callback. `chrome-extension://` is
 * not an accepted redirect, and the loopback alternative belongs to desktop
 * clients, which Google's own Gemini OAuth guide pairs with a downloaded
 * `client_secret.json` this extension must never hold.
 *
 * So `identity` is needed, and `auth-flow-port.ts`'s objection to it is
 * answered rather than ignored. That objection is that the permission also
 * unlocks `chrome.identity.getAuthToken`, which can mint a token for the
 * *browser profile's own* Google account. Two things keep that shut:
 *
 *  - **`identity` is optional, not required.** It is absent from the
 *    manifest's `permissions` and is requested at the moment the user asks to
 *    connect Google — a dialog they can decline, and a permission they can
 *    revoke afterwards. A user who never connects Google never grants it.
 *  - **the manifest declares no `oauth2` key.** `getAuthToken` uses the client
 *    id and scopes from that key, and there is none, so it has nothing to mint
 *    a token with. `tests/e2e/google-provider-auth.spec.ts` calls it in real
 *    Chromium and asserts it fails.
 *
 * ## What leaves the device
 *
 * The authorization request is a navigation the user performs. The token
 * exchange is one POST to `https://oauth2.googleapis.com/token` carrying the
 * code, the verifier, the client id and the redirect — no secret, because a
 * Chrome Extension client has none. It goes through the egress gate on its own
 * channel with an opaque payload policy, so neither the code nor the refresh
 * token reaches an evidence digest.
 */

import { getLogger } from '@/logging/logger';
import {
  createCodeChallenge,
  createCodeVerifier,
  createState,
  isCallbackUrl,
  timingSafeEqual,
} from '@/connectors/oauth/oauth-flow';
import { GOOGLE_AUTH } from '@/providers/accounts/authorization';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';

const log = getLogger('security');

/** How long the user has on Google's screens before the flow is abandoned. */
export const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** How long an authorization may sit unanswered before its state expires. */
export const GOOGLE_AUTH_TTL_MS = 10 * 60 * 1000;

/**
 * A token, as Google issued it.
 *
 * `refreshToken` is optional because Google returns one only on the first
 * consent for a client — a re-authorization without `prompt=consent` comes
 * back with an access token alone. That is why the request below asks for
 * consent explicitly: a connection that cannot refresh would break silently
 * an hour later, which is worse than one extra screen.
 */
export interface GoogleProviderToken {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly refreshToken?: string;
  readonly scope: string;
}

export type GoogleAuthFailure =
  | 'NOT_CONFIGURED'
  | 'PERMISSION_DENIED'
  | 'CANCELLED'
  | 'CALLBACK_INVALID'
  | 'STATE_MISMATCH'
  | 'STATE_EXPIRED'
  | 'DECLINED'
  | 'EXCHANGE_FAILED'
  | 'SCOPE_NOT_GRANTED';

export type GoogleAuthResult =
  | { readonly ok: true; readonly token: GoogleProviderToken }
  | { readonly ok: false; readonly failure: GoogleAuthFailure; readonly reason: string };

/** The half of an in-flight authorization that never leaves the extension. */
export interface PendingGoogleAuth {
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface PreparedGoogleAuth {
  readonly url: string;
  readonly pending: PendingGoogleAuth;
}

/**
 * Builds the authorization URL.
 *
 * `access_type=offline` and `prompt=consent` are both deliberate and both cost
 * the user something, so they are justified here rather than copied from a
 * tutorial. Without `offline` Google issues no refresh token and the
 * connection dies at the first expiry; without `consent` Google may skip the
 * screen on a re-authorization and return no refresh token even with
 * `offline`, which produces exactly the same silent death a week later.
 *
 * `include_granted_scopes` is **not** sent. It asks Google to add every scope
 * the user has previously granted this client to the new token, which would
 * make the token's reach depend on unrelated history rather than on what this
 * connection asked for.
 */
export async function prepareGoogleAuthorization(
  options: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly scope?: string;
    readonly loginHint?: string;
  },
  now: number,
): Promise<PreparedGoogleAuth> {
  const codeVerifier = createCodeVerifier();
  const challenge = await createCodeChallenge(codeVerifier);
  const state = createState();

  const url = new URL(GOOGLE_AUTH.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scope ?? GOOGLE_AUTH.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  // A hint, never a constraint: it preselects an account on Google's screen
  // and the user can still choose another. It is the user's own address, typed
  // by them, and it is not an assertion about who they are.
  if (options.loginHint !== undefined && options.loginHint.length > 0) {
    url.searchParams.set('login_hint', options.loginHint);
  }

  return {
    url: url.toString(),
    pending: { state, codeVerifier, redirectUri: options.redirectUri, createdAt: now },
  };
}

/**
 * Reads a callback, or says exactly why it was refused.
 *
 * Order matters, and it is the order `oauth-flow.ts` established: the redirect
 * must match before anything on the URL is read, the provider's own error is
 * reported before a state complaint so a user who declined sees that, and the
 * code is looked at last so a rejected callback never reveals whether one was
 * present.
 */
export function readGoogleCallback(
  callbackUrl: string,
  pending: PendingGoogleAuth | undefined,
  now: number,
):
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly failure: GoogleAuthFailure; readonly reason: string } {
  if (pending === undefined) {
    return {
      ok: false,
      failure: 'CALLBACK_INVALID',
      reason: 'No Google authorization was in progress, so this callback was not expected.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    return { ok: false, failure: 'CALLBACK_INVALID', reason: 'The callback URL is not a URL.' };
  }
  if (!isCallbackUrl(callbackUrl, pending.redirectUri)) {
    return {
      ok: false,
      failure: 'CALLBACK_INVALID',
      reason: 'The callback did not arrive at the redirect this authorization registered.',
    };
  }

  const refused = parsed.searchParams.get('error');
  if (refused !== null) {
    // Google's own code — `access_denied` and friends — and not its
    // description, which is attacker-influenceable text on a URL.
    return {
      ok: false,
      failure: 'DECLINED',
      reason: `Google did not grant the authorization (${refused.slice(0, 64)}).`,
    };
  }

  const state = parsed.searchParams.get('state');
  if (state === null || !timingSafeEqual(state, pending.state)) {
    return {
      ok: false,
      failure: 'STATE_MISMATCH',
      reason: 'The callback did not match the authorization that was started.',
    };
  }
  if (now - pending.createdAt > GOOGLE_AUTH_TTL_MS) {
    return {
      ok: false,
      failure: 'STATE_EXPIRED',
      reason: 'The authorization took too long to complete. Start it again.',
    };
  }

  const code = parsed.searchParams.get('code');
  if (code === null || code.length === 0) {
    return {
      ok: false,
      failure: 'CALLBACK_INVALID',
      reason: 'The callback carried no authorization code.',
    };
  }
  return { ok: true, code };
}

/** Form-encodes an exchange. Separate so a test can read what is sent. */
export function tokenExchangeBody(input: {
  readonly clientId: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}): string {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', input.code);
  form.set('client_id', input.clientId);
  form.set('code_verifier', input.codeVerifier);
  form.set('redirect_uri', input.redirectUri);
  // No `client_secret`. A Chrome Extension client has none, and a build that
  // sent an empty one would be telling Google it is a confidential client
  // whose secret is the empty string.
  return form.toString();
}

export function refreshBody(input: {
  readonly clientId: string;
  readonly refreshToken: string;
}): string {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', input.refreshToken);
  form.set('client_id', input.clientId);
  return form.toString();
}

/**
 * Reads Google's token response.
 *
 * A granted scope narrower than the one requested is a **failure** rather than
 * a partial success. Google's consent screen lets a user uncheck a scope, and
 * a token without `cloud-platform` cannot list a model or run one — so storing
 * it would produce an account that looks connected and fails at its first use,
 * with no way for the user to tell why.
 */
export function readTokenResponse(
  body: unknown,
  now: number,
  requiredScope: string = GOOGLE_AUTH.scope,
): GoogleProviderToken | { readonly error: GoogleAuthFailure; readonly reason: string } {
  if (typeof body !== 'object' || body === null) {
    return { error: 'EXCHANGE_FAILED', reason: 'Google’s reply was not readable.' };
  }
  const record = body as Record<string, unknown>;
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  if (accessToken.length === 0) {
    return { error: 'EXCHANGE_FAILED', reason: 'Google’s reply carried no access token.' };
  }
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 0;
  const scope = typeof record.scope === 'string' ? record.scope : '';
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  for (const needed of requiredScope.split(/\s+/).filter((entry) => entry.length > 0)) {
    if (!granted.has(needed)) {
      return {
        error: 'SCOPE_NOT_GRANTED',
        reason:
          'Google did not grant access to the Gemini API, so this connection could not run a ' +
          'model. Authorize again and leave the requested access selected.',
      };
    }
  }
  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : '';
  return {
    accessToken,
    // A token with no stated lifetime is treated as already needing refresh
    // rather than as valid forever.
    expiresAt: now + Math.max(0, expiresIn) * 1000,
    ...(refreshToken.length === 0 ? {} : { refreshToken }),
    scope,
  };
}

/** Access tokens are refreshed this long before they expire. */
export const REFRESH_SKEW_MS = 2 * 60 * 1000;

export function needsRefresh(token: Pick<GoogleProviderToken, 'expiresAt'>, now: number): boolean {
  return now >= token.expiresAt - REFRESH_SKEW_MS;
}

/** One POST to Google's token endpoint, performed by the caller's transport. */
export type TokenPost = (
  body: string,
) => Promise<{ readonly status: number; readonly body: unknown }>;

/** Asks for the optional `identity` permission, so a test can decline it. */
export type PermissionPort = () => Promise<boolean>;

export interface GoogleProviderAuthOptions {
  readonly clientId: string | null;
  readonly redirectUri: string;
  readonly authFlow: AuthFlowPort;
  readonly post: TokenPost;
  readonly requestPermission: PermissionPort;
  readonly now: () => number;
  readonly timeoutMs?: number;
}

export class GoogleProviderAuth {
  constructor(private readonly options: GoogleProviderAuthOptions) {}

  /**
   * Runs one authorization.
   *
   * Every outcome is a value rather than a throw, because every one of them is
   * something an ordinary person does: declining the permission dialog,
   * closing the Google tab, unchecking a scope, losing connectivity.
   */
  async authorize(signal: AbortSignal, loginHint?: string): Promise<GoogleAuthResult> {
    const clientId = this.options.clientId;
    if (clientId === null) {
      return {
        ok: false,
        failure: 'NOT_CONFIGURED',
        reason:
          'This build carries no Google OAuth client id, so there is nothing to authorize against.',
      };
    }

    // Asked for first, and only now. A user who never connects Google is
    // never shown this dialog, and the permission is theirs to revoke.
    if (!(await this.options.requestPermission())) {
      return {
        ok: false,
        failure: 'PERMISSION_DENIED',
        reason:
          'Connecting a Google account needs permission to open Google’s sign-in window. ' +
          'Nothing was changed.',
      };
    }

    const prepared = await prepareGoogleAuthorization(
      {
        clientId,
        redirectUri: this.options.redirectUri,
        ...(loginHint === undefined ? {} : { loginHint }),
      },
      this.options.now(),
    );

    let outcome: AuthFlowOutcome;
    try {
      outcome = await this.options.authFlow.run(
        {
          authorizationUrl: prepared.url,
          redirectUri: prepared.pending.redirectUri,
          timeoutMs: this.options.timeoutMs ?? GOOGLE_AUTH_TIMEOUT_MS,
        },
        signal,
      );
    } catch {
      return {
        ok: false,
        failure: 'CANCELLED',
        reason: 'Google’s sign-in window could not be opened.',
      };
    }
    if (outcome.kind !== 'callback') {
      log.info('A Google provider authorization did not complete.', { reason: outcome.reason });
      return { ok: false, failure: 'CANCELLED', reason: outcome.reason };
    }

    const callback = readGoogleCallback(outcome.url, prepared.pending, this.options.now());
    if (!callback.ok) return { ok: false, failure: callback.failure, reason: callback.reason };

    return this.exchange(clientId, callback.code, prepared.pending);
  }

  private async exchange(
    clientId: string,
    code: string,
    pending: PendingGoogleAuth,
  ): Promise<GoogleAuthResult> {
    let response: { status: number; body: unknown };
    try {
      response = await this.options.post(
        tokenExchangeBody({
          clientId,
          code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
        }),
      );
    } catch {
      return {
        ok: false,
        failure: 'EXCHANGE_FAILED',
        reason: 'Google could not be reached to complete the authorization.',
      };
    }
    if (response.status !== 200) {
      return {
        ok: false,
        failure: 'EXCHANGE_FAILED',
        reason: 'Google refused to issue a token for this authorization.',
      };
    }

    const token = readTokenResponse(response.body, this.options.now());
    if ('error' in token) return { ok: false, failure: token.error, reason: token.reason };
    if (token.refreshToken === undefined) {
      // Not fatal: the access token works now. Recorded because it means the
      // connection will need re-authorizing by hand when it expires, and the
      // panel says so rather than the user discovering it.
      log.info('A Google provider authorization returned no refresh token.', {});
    }
    // Logged with none of it. Neither token has a field on the logger's
    // allowlist, and the scope string is not a credential.
    log.info('A Google provider authorization completed.', {});
    return { ok: true, token };
  }

  /**
   * Exchanges a refresh token for a new access token.
   *
   * Google does not reissue a refresh token here, so the stored one is kept.
   * A refusal is final: a revoked grant does not become valid by being asked
   * again, and retrying one is how a loop against a revoked grant starts.
   */
  async refresh(refreshToken: string): Promise<GoogleAuthResult> {
    const clientId = this.options.clientId;
    if (clientId === null) {
      return { ok: false, failure: 'NOT_CONFIGURED', reason: 'No Google client id is configured.' };
    }
    let response: { status: number; body: unknown };
    try {
      response = await this.options.post(refreshBody({ clientId, refreshToken }));
    } catch {
      return {
        ok: false,
        failure: 'EXCHANGE_FAILED',
        reason: 'Google could not be reached to renew this authorization.',
      };
    }
    if (response.status !== 200) {
      return {
        ok: false,
        failure: 'EXCHANGE_FAILED',
        reason: 'Google refused to renew this authorization. Connect the account again.',
      };
    }
    const token = readTokenResponse(response.body, this.options.now());
    if ('error' in token) return { ok: false, failure: token.error, reason: token.reason };
    return { ok: true, token: { ...token, refreshToken } };
  }
}
