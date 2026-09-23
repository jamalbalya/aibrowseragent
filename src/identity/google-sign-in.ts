/**
 * Google sign-in, from the extension's side.
 *
 * Four steps, and the extension's job in each is deliberately small:
 *
 *  1. ask the backend to start a flow; it gets a challenge id and a URL;
 *  2. open that URL in a tab it created, and watch **only that tab** for the
 *     backend's callback path;
 *  3. read the one-time exchange code out of the callback URL;
 *  4. trade the challenge id and the code for a session, over a request the
 *     extension itself makes.
 *
 * **The extension verifies no identity.** It does not see an ID token, a
 * Google subject, or an email until the backend has verified them, and it
 * could not check a signature usefully anyway — a modified extension would
 * simply skip the check. Everything security-relevant happens on the server;
 * this drives a browser.
 *
 * **No new permission.** The tab is opened with `tabs`, which the extension
 * already holds, and watched through `AuthFlowPort` — the same mechanism the
 * connector OAuth flow uses, tested in `auth-flow-port.ts`. `chrome.identity`
 * is not used: its permission also unlocks `getAuthToken`, which reaches the
 * browser profile's own Google account, and that is a capability this product
 * must never hold.
 *
 * **Nothing bearer-shaped comes out of the tab.** The callback URL carries a
 * one-time exchange code and a challenge id. It does not carry a session
 * token, a refresh token or an `abaUserId`, so the URL that lands in history
 * is not a credential.
 */
import { getLogger } from '@/logging/logger';
import { IDENTITY_PATHS, type IdentityConfig } from './identity-config';
import type { IdentityTransport } from './identity-transport';
import type { AuthFlowPort } from '@/connectors/oauth/auth-flow-port';

const log = getLogger('security');

/** How long the user has to complete the Google screens. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** The callback path on the backend origin. Matched exactly, never by prefix. */
export const CALLBACK_PATH = '/v1/auth/google/callback';

export type SignInFailure =
  'NOT_CONFIGURED' | 'START_FAILED' | 'CANCELLED' | 'CALLBACK_INVALID' | 'EXCHANGE_FAILED';

export type SignInResult =
  | {
      readonly ok: true;
      readonly abaUserId: string;
      readonly accessToken: string;
      readonly accessExpiresAt: number;
      readonly refreshToken: string;
      readonly refreshExpiresAt: number;
      readonly email: string | null;
    }
  | { readonly ok: false; readonly failure: SignInFailure };

export interface GoogleSignInOptions {
  readonly config: IdentityConfig;
  readonly transport: IdentityTransport;
  readonly authFlow: AuthFlowPort;
  readonly timeoutMs?: number;
  /**
   * This installation's device id, read when the exchange is made.
   *
   * A function rather than a value because minting one is a storage read, and
   * a sign-in that never completes should not have caused a write. Optional:
   * a sign-in without one still works, and the account simply has no device
   * associated with this installation.
   */
  readonly deviceId?: () => Promise<string>;
}

function readString(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(body: unknown, field: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads the exchange code out of a callback URL.
 *
 * The URL's **origin and path must match exactly**. A prefix match would
 * accept `https://backend.example.attacker.test/v1/auth/...`, which is the
 * classic open-redirect shape, and the connector flow refuses it for the same
 * reason.
 */
export function parseCallback(
  backendOrigin: string,
  rawUrl: string,
): { readonly challengeId: string; readonly exchangeCode: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.origin !== backendOrigin) return null;
  if (url.pathname !== CALLBACK_PATH) return null;

  const challengeId = url.searchParams.get('challenge');
  const exchangeCode = url.searchParams.get('code');
  if (challengeId === null || exchangeCode === null) return null;
  if (challengeId.length === 0 || exchangeCode.length === 0) return null;
  return { challengeId, exchangeCode };
}

export class GoogleSignIn {
  constructor(private readonly options: GoogleSignInOptions) {}

  /**
   * Runs a sign-in.
   *
   * Returns a failure rather than throwing, because every one of these is an
   * ordinary outcome a person can cause — closing the tab, declining the
   * consent screen, losing connectivity — and none should surface as a crash.
   */
  async signIn(signal: AbortSignal): Promise<SignInResult> {
    const started = await this.start();
    if (started === null) return { ok: false, failure: 'START_FAILED' };

    const outcome = await this.options.authFlow.run(
      {
        authorizationUrl: started.authorizationUrl,
        redirectUri: `${this.options.config.backendOrigin}${CALLBACK_PATH}`,
        timeoutMs: this.options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
      },
      signal,
    );
    if (outcome.kind !== 'callback') {
      log.info('A Google sign-in did not complete.', { reason: outcome.reason });
      return { ok: false, failure: 'CANCELLED' };
    }

    const callback = parseCallback(this.options.config.backendOrigin, outcome.url);
    if (callback === null) return { ok: false, failure: 'CALLBACK_INVALID' };
    // The challenge the backend named at start must be the one that came
    // back. A mismatch means this callback belongs to a different flow.
    if (callback.challengeId !== started.challengeId) {
      return { ok: false, failure: 'CALLBACK_INVALID' };
    }

    return this.exchange(callback.challengeId, callback.exchangeCode);
  }

  /** The device id, or `null` when there is none and when reading one fails. */
  private async readDeviceId(): Promise<string | null> {
    if (this.options.deviceId === undefined) return null;
    try {
      const value = await this.options.deviceId();
      return value.length > 0 ? value : null;
    } catch {
      // A device association is not what authorises a sign-in, so failing to
      // read one must not fail the sign-in.
      return null;
    }
  }

  private async start(): Promise<{
    readonly challengeId: string;
    readonly authorizationUrl: string;
  } | null> {
    try {
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.googleStart,
        body: { method: 'google' },
      });
      if (response.status !== 200) return null;

      const challengeId = readString(response.body, 'challengeId');
      const authorizationUrl = readString(response.body, 'authorizationUrl');
      if (challengeId === null || authorizationUrl === null) return null;

      // The backend names the authorization endpoint, but the extension is
      // what opens it, so it checks: https only, and a real URL. A backend
      // that returned `javascript:` would otherwise be opening a scheme in a
      // tab this extension created.
      let parsed: URL;
      try {
        parsed = new URL(authorizationUrl);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:') return null;

      return { challengeId, authorizationUrl };
    } catch {
      return null;
    }
  }

  private async exchange(challengeId: string, exchangeCode: string): Promise<SignInResult> {
    try {
      // Read now rather than at construction: a sign-in that is cancelled
      // before this point should not have minted anything.
      const deviceId = await this.readDeviceId();
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.exchange,
        body: {
          challengeId,
          exchangeCode,
          ...(deviceId === null ? {} : { deviceId }),
        },
      });
      if (response.status !== 200) return { ok: false, failure: 'EXCHANGE_FAILED' };

      const abaUserId = readString(response.body, 'abaUserId');
      const accessToken = readString(response.body, 'accessToken');
      const refreshToken = readString(response.body, 'refreshToken');
      const accessExpiresAt = readNumber(response.body, 'accessExpiresAt');
      const refreshExpiresAt = readNumber(response.body, 'refreshExpiresAt');
      if (
        abaUserId === null ||
        accessToken === null ||
        refreshToken === null ||
        accessExpiresAt === null ||
        refreshExpiresAt === null
      ) {
        return { ok: false, failure: 'EXCHANGE_FAILED' };
      }

      // Logged without any of it: the ids are correlation values, and the
      // tokens have no field on the logger's allowlist.
      log.info('A Google sign-in completed.', {});
      return {
        ok: true,
        abaUserId,
        accessToken,
        accessExpiresAt,
        refreshToken,
        refreshExpiresAt,
        email: readString(response.body, 'email'),
      };
    } catch {
      return { ok: false, failure: 'EXCHANGE_FAILED' };
    }
  }
}
