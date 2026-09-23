/**
 * The HTTP surface for Google sign-in. Three routes and nothing else.
 *
 * Phase 1 deliberately shipped no transport, because a routing layer with no
 * endpoint behind it is scaffolding. There is an endpoint behind it now, so
 * this is the minimum that exposes it.
 *
 * **No framework.** The handler is `(Request) => Promise<Response>` over the
 * platform's own types, which is what every current server runtime already
 * speaks. It adds no dependency, it is a pure function, and a test can drive
 * it without opening a socket — so the routes are exercised end to end rather
 * than described.
 *
 * ## The layering is the point
 *
 * ```
 *   router.ts          parses HTTP, validates shape, maps Result → status
 *        ↓
 *   GoogleAuthService  state, PKCE, nonce, challenge lifecycle, account resolution
 *        ↓
 *   Store              rows
 * ```
 *
 * No Google verification logic lives here. This file never sees an ID token,
 * never compares an issuer, never touches a JWKS. It reads query parameters
 * and a JSON body, hands them to the service, and turns what comes back into
 * a status code. That separation is what lets the security tests target the
 * service directly and lets these tests target the transport.
 *
 * ## Why the redirect path and the callback path are different
 *
 * Google is registered against `redirectPath`. The extension watches
 * `callbackPath`. They are deliberately **not** the same URL:
 *
 * ```
 *   Google  →  GET  /v1/auth/google/redirect?code=…&state=…      (backend works here)
 *           →  302  /v1/auth/google/callback?challenge=…&code=…  (extension sees this)
 * ```
 *
 * The extension's tab watcher fires on the first URL matching the path it
 * watches. If Google redirected straight to that path, the watcher would
 * capture Google's own authorization code and `state` — the wrong URL, before
 * the backend had done anything — and whether it did would depend on Chrome's
 * redirect timing. Two paths remove the race entirely rather than tuning it.
 *
 * ## What may appear in a URL
 *
 * Exactly one secret-ish value: the one-time exchange artifact, on the
 * callback redirect. It is random, single-use, short-lived, bound to the
 * completed flow, and useless as a session token. **No access token, refresh
 * token, ID token, `abaUserId`, PKCE verifier, `state` or nonce ever reaches
 * a URL**, which is why the tokens come back over the POST the extension
 * makes itself. `Referrer-Policy: no-referrer` is set on every response so
 * the one value that is in a URL does not leave in a `Referer` header either.
 */
import type { IdentityBackend } from '../index';
import type { ServerLogger } from '../logging';
import type { AccessTokenIssuer } from '../app/access-token';

/** Paths, taken from configuration rather than assumed. */
export interface AuthRouterPaths {
  /** Where the extension asks to begin. */
  readonly startPath: string;
  /** Registered with Google. The backend works here. */
  readonly redirectPath: string;
  /** Where the extension's tab watcher looks. The backend lands here. */
  readonly callbackPath: string;
  /** Where the extension trades the artifact for tokens. */
  readonly exchangePath: string;
}

export const DEFAULT_PATHS: AuthRouterPaths = {
  startPath: '/v1/auth/start',
  redirectPath: '/v1/auth/google/redirect',
  callbackPath: '/v1/auth/google/callback',
  exchangePath: '/v1/auth/exchange',
};

export interface AuthRouterOptions {
  readonly backend: IdentityBackend;
  readonly log: ServerLogger;
  /**
   * Mints the access token the exchange returns.
   *
   * Injected because the signing key belongs to a deployment. The domain
   * returns a session and the lifetime an access token should have; turning
   * that into a signed assertion is this layer's job, and this is the only
   * place in the transport that holds the means to do it.
   */
  readonly accessTokens: AccessTokenIssuer;
  readonly paths?: AuthRouterPaths;
  /**
   * Cap on a request body, in bytes.
   *
   * A sign-in body is two short strings. Anything larger is either a mistake
   * or an attempt to make the server hold memory on an unauthenticated route,
   * and both are answered the same way.
   */
  readonly maxBodyBytes?: number;
}

export const MAX_BODY_BYTES = 8 * 1024;

/**
 * Headers on every response.
 *
 * `no-store` because an authentication response must not sit in a cache;
 * `no-referrer` because the callback URL carries the exchange artifact and a
 * `Referer` header is the classic way a value in a URL escapes the page it
 * was meant for; `nosniff` because the landing page is the one HTML response
 * here and content-type confusion on an auth origin is not worth allowing.
 */
const SAFE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * The single error vocabulary.
 *
 * Every refusal on every route answers with one of these, and none of them
 * says whether an account exists, whether an identity is already attached to
 * another account, or which check failed. Telling an attacker which step
 * rejected them tells them what to change.
 */
type ErrorCode = 'invalid_request' | 'not_found' | 'method_not_allowed' | 'server_error';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SAFE_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(code: ErrorCode, status: number): Response {
  return json({ error: code }, status);
}

/**
 * Reads a JSON body, refusing anything oversized or malformed.
 *
 * The declared length is checked first so an oversized body is refused before
 * it is read, and the read is checked again afterwards because a declared
 * length is a claim rather than a fact.
 */
async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length > limit) return null;
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > limit) return null;
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A required string field of a bounded length. Absent, empty and oversized all fail. */
function requiredString(body: unknown, field: string, max = 512): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}

/** An optional string field. Present-but-wrong is `undefined`, same as absent. */
function optionalString(body: unknown, field: string, max = 512): string | undefined {
  const value = requiredString(body, field, max);
  return value === null ? undefined : value;
}

/**
 * The page the extension's tab lands on.
 *
 * Static, self-contained and scriptless. It exists so a person who completed
 * a sign-in sees something rather than a blank document, and so the tab has a
 * URL for the extension's watcher to match. It reads nothing from the query
 * string and reflects nothing back, so there is no value on it to inject.
 */
const LANDING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in</title>
<style>
  body{font:16px system-ui,sans-serif;margin:0;display:grid;place-items:center;
       min-height:100vh;background:#f6f7f9;color:#1b1d21}
  main{text-align:center;padding:2rem}
  p{color:#5a5f68}
</style></head>
<body><main>
<h1>You're signed in</h1>
<p>You can close this tab and go back to AI Browser Agent.</p>
</main></body></html>`;

export type AuthRouter = (request: Request) => Promise<Response>;

/**
 * Builds the handler.
 *
 * Returns a closure rather than a class because it has one operation and no
 * state: everything durable lives in the store behind the services.
 */
export function createAuthRouter(options: AuthRouterOptions): AuthRouter {
  const paths = options.paths ?? DEFAULT_PATHS;
  const limit = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const { backend, log, accessTokens } = options;

  /** Builds the URL the extension's watcher will match. */
  const callbackUrl = (origin: string, params: Readonly<Record<string, string>>): string => {
    const url = new URL(paths.callbackPath, origin);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };

  return async function handle(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse('invalid_request', 400);
    }
    const path = url.pathname;

    // Google sign-in is not configured on this deployment. Every route that
    // depends on it is absent rather than failing — a 404 says the same thing
    // to everyone, which is what an unconfigured feature should say.
    const google = backend.google;

    /* ------------------------------ start ------------------------------ */
    if (path === paths.startPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
      if (google === null) return errorResponse('not_found', 404);
      if ((await readJsonBody(request, limit)) === null) {
        return errorResponse('invalid_request', 400);
      }

      const started = await google.start();
      if (!started.ok) {
        log.warn('auth.http.start_failed', { errorCode: started.error.code });
        return errorResponse('server_error', 500);
      }
      // The challenge id and a URL. The state, the nonce and the PKCE
      // verifier stay on the row and are not in this response.
      return json(
        {
          challengeId: started.value.challengeId,
          authorizationUrl: started.value.authorizationUrl,
        },
        200,
      );
    }

    /* ---------------------------- redirect ----------------------------- */
    if (path === paths.redirectPath) {
      if (request.method !== 'GET') return errorResponse('method_not_allowed', 405);
      if (google === null) return errorResponse('not_found', 404);

      // All three go to the service, including Google's own `error`. A
      // person who declines the consent screen arrives here with `error` and
      // no code — an outcome, not an attack — and the service already treats
      // every incomplete callback identically.
      const outcome = await google.handleCallback({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      });
      if (!outcome.ok) {
        // One code for every failure. Which check refused this — an unknown
        // state, a spent challenge, a forged token, an identity already on
        // another account — is exactly what an attacker would use to choose
        // their next attempt.
        log.warn('auth.http.callback_refused', { errorCode: outcome.error.code });
        return redirectTo(callbackUrl(url.origin, { error: 'auth_failed' }));
      }

      return redirectTo(
        callbackUrl(url.origin, {
          challenge: outcome.value.challengeId,
          code: outcome.value.exchangeCode,
        }),
      );
    }

    /* ---------------------------- callback ----------------------------- */
    if (path === paths.callbackPath) {
      if (request.method !== 'GET') return errorResponse('method_not_allowed', 405);
      // Does nothing. The work happened on the redirect route; this is the
      // surface the tab rests on, and the extension reads the query string
      // out of the tab's own URL rather than out of this body.
      return new Response(LANDING_PAGE, {
        status: 200,
        headers: { ...SAFE_HEADERS, 'content-type': 'text/html; charset=utf-8' },
      });
    }

    /* ---------------------------- exchange ----------------------------- */
    if (path === paths.exchangePath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
      if (google === null) return errorResponse('not_found', 404);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);

      const challengeId = requiredString(body, 'challengeId');
      const exchangeCode = requiredString(body, 'exchangeCode');
      if (challengeId === null || exchangeCode === null) {
        return errorResponse('invalid_request', 400);
      }
      // Optional and shape-checked by the service. Nothing here trusts it,
      // and a device id authorises nothing.
      const deviceId = optionalString(body, 'deviceId', 64);

      const outcome = await google.exchange({
        challengeId,
        exchangeCode,
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      if (!outcome.ok) {
        log.warn('auth.http.exchange_refused', { errorCode: outcome.error.code });
        // 401 for every refusal, including a spent artifact and an unknown
        // one. The status must not distinguish them either.
        return errorResponse('invalid_request', 401);
      }

      const { session } = outcome.value;
      // Minted here, from the session the domain issued. It carries the
      // account, the session and an expiry — no email, no Google subject, no
      // device id, and never the refresh token.
      const accessToken = await accessTokens.sign({
        sub: session.abaUserId,
        sid: session.sessionId,
        iat: backend.clock.now(),
        exp: session.accessExpiresAt,
      });
      return json(
        {
          abaUserId: session.abaUserId,
          accessToken,
          accessExpiresAt: session.accessExpiresAt,
          refreshToken: session.refreshToken,
          refreshExpiresAt: session.refreshExpiresAt,
          deviceRegistered: outcome.value.deviceRegistered,
        },
        200,
      );
    }

    return errorResponse('not_found', 404);
  };
}

/**
 * A 303, not a 302.
 *
 * The browser must follow this with a GET whatever the original method was,
 * and 303 says so exactly. It also carries no body: a redirect body is
 * content nobody reads on a route whose whole purpose is the `Location`.
 */
function redirectTo(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, location },
  });
}
