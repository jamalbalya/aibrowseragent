/**
 * The HTTP surface for authentication. Eight routes and nothing else.
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
 * ## The session lifecycle
 *
 * Sign-in is three of the six routes; the other three complete the life of
 * the session it produces:
 *
 * ```
 *   POST /v1/auth/refresh   credential: the refresh token, in the body
 *   POST /v1/auth/logout    credential: the access token, in Authorization
 * ```
 *
 * They take different credentials because they answer different questions.
 * Refresh asks "may this token become a new session?", and the refresh token
 * is the only thing that can answer it — an access token proves nothing about
 * a rotation chain. Logout asks "may this caller end *this* session?", which
 * the access token answers directly because it names the session it was
 * minted for. `IDENTITY_AUTH_ARCHITECTURE.md` §19 lists logout under the
 * access token for that reason.
 *
 * Neither restates a security decision. Refresh hands the token to
 * `SessionService.rotateSession`, where the atomic claim, reuse detection,
 * family revocation, expiry and the deleted-account check already live.
 * Logout resolves a `Principal` and calls `revokeSession`, which revokes the
 * session the principal names and deletes nothing.
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
import type { IssuedSession } from '../app/session-service';
import type { Principal } from '../domain/authorization';

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
  /** Where the extension rotates a refresh token into a new session. */
  readonly refreshPath: string;
  /** Where a session revokes itself. */
  readonly logoutPath: string;
  /** Where the extension asks for a one-time code by email. */
  readonly emailStartPath: string;
  /** Where the extension presents that code. */
  readonly emailVerifyPath: string;
  /**
   * The authenticated caller's own identities.
   *
   * Under `/v1/me/` rather than `/v1/auth/` deliberately: everything under
   * `/v1/auth/` is reachable without a session and exists to create one,
   * while everything here **requires** one and acts on the account it names.
   * The prefix is the boundary, so a route added to the wrong group looks
   * wrong.
   */
  readonly identitiesPath: string;
  readonly identityLinkStartPath: string;
  readonly identityAttachPath: string;
  readonly identityDetachPath: string;
}

export const DEFAULT_PATHS: AuthRouterPaths = {
  startPath: '/v1/auth/start',
  redirectPath: '/v1/auth/google/redirect',
  callbackPath: '/v1/auth/google/callback',
  exchangePath: '/v1/auth/exchange',
  refreshPath: '/v1/auth/refresh',
  logoutPath: '/v1/auth/logout',
  emailStartPath: '/v1/auth/email/start',
  emailVerifyPath: '/v1/auth/email/verify',
  identitiesPath: '/v1/me/identities',
  identityLinkStartPath: '/v1/me/identities/start',
  identityAttachPath: '/v1/me/identities/attach',
  identityDetachPath: '/v1/me/identities/detach',
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
  /**
   * How this deployment tells one caller from another, for rate limiting.
   *
   * **Required, and required even for a deployment with no email sign-in.**
   * The alternative was an optional field, and an optional field is one a
   * deployment forgets: email routes would then ship with every caller
   * sharing a single counter, which is either no protection or a global
   * denial of service, and nothing would have failed to make that visible.
   * A required parameter makes it a decision somebody took.
   *
   * What it should return is whatever the deployment genuinely knows — a peer
   * address, a proxy-supplied client address it trusts, a tenant id. It is
   * used for counting and for nothing else: it is never stored, never logged,
   * never compared against an account, and authorises nothing, so a wrong
   * value weakens a limit and cannot grant access.
   *
   * A deployment that truly cannot distinguish callers returns a constant and
   * accepts one shared bucket. That is a weaker limit, taken knowingly.
   */
  readonly sourceOf: (request: Request) => string;
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
type ErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'server_error'
  /** Too many requests for this address or this caller. Carries a retry hint. */
  | 'rate_limited'
  /** A code could not be sent, or the server is at capacity. Try again later. */
  | 'unavailable';

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

/**
 * Reads a bearer credential out of the Authorization header.
 *
 * Header only. A token in a query parameter would reach browser history,
 * server logs and any `Referer` the page sent, which is the whole reason the
 * exchange artifact is the only value this API ever puts in a URL.
 */
function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token.length === 0 || token.length > 4096 ? null : token;
}

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
  const { backend, log, accessTokens, sourceOf } = options;

  /**
   * The body every session-issuing route returns.
   *
   * Shared so `exchange` and `refresh` cannot drift into returning different
   * shapes for the same thing — a client that had to tell them apart would be
   * a client with two session paths.
   *
   * The access token is minted here because the domain deliberately does not:
   * it carries the account, the session and an expiry, and never an email, a
   * Google subject, a device id or the refresh token.
   */
  const sessionBody = async (session: IssuedSession): Promise<Record<string, unknown>> => ({
    abaUserId: session.abaUserId,
    accessToken: await accessTokens.sign({
      sub: session.abaUserId,
      sid: session.sessionId,
      iat: backend.clock.now(),
      exp: session.accessExpiresAt,
    }),
    accessExpiresAt: session.accessExpiresAt,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.refreshExpiresAt,
  });

  /**
   * The authenticated-route boundary. The minimum, and no more.
   *
   * Two checks, and the second is the one that matters. The signature and
   * expiry prove the token was minted here and is current — but a stateless
   * token cannot know that its session was revoked a second ago, and logout
   * is precisely an operation on a session's liveness. So the `sid` is
   * resolved through `sessions.verify`, which re-reads the session **and**
   * the account: a revoked session, an expired one and a deleted account are
   * all refused there, live, however valid the signature is.
   *
   * Authority comes from the signed `sid` and `sub`. Nothing the caller sends
   * — body, query, header — can name a different session or account.
   */
  const authenticate = async (request: Request): Promise<Principal | null> => {
    const bearer = bearerFrom(request);
    if (bearer === null) return null;

    const claims = await accessTokens.verify(bearer, backend.clock.now());
    if (claims === null) return null;

    const principal = await backend.sessions.verify(claims.sid);
    if (!principal.ok) return null;
    // Defence in depth: the token's account and the session's must agree.
    // They cannot disagree unless a token was minted for the wrong session,
    // and continuing then would act for one account under another's token.
    if (principal.value.abaUserId !== claims.sub) return null;
    return principal.value;
  };

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
    // The same rule for email: a deployment with no mail transport has no
    // email routes, rather than routes that accept a request and then cannot
    // send anything.
    const email = backend.email;

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

      return json(
        {
          ...(await sessionBody(outcome.value.session)),
          deviceRegistered: outcome.value.deviceRegistered,
        },
        200,
      );
    }

    /* ----------------------------- refresh ----------------------------- */
    if (path === paths.refreshPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);

      // **The refresh token is the credential.** There is no parameter here
      // for an `abaUserId`, a Google subject, an email or a device id, so
      // none of them can be offered as authority — the account comes from the
      // session row the digest resolves to, and from nowhere else.
      const refreshToken = requiredString(body, 'refreshToken', 4096);
      if (refreshToken === null) return errorResponse('invalid_request', 400);

      // Straight to the existing domain service. Every security decision —
      // the atomic claim, reuse detection, family revocation, expiry, the
      // deleted-account check — lives there and is not restated here.
      const rotated = await backend.sessions.rotateSession(refreshToken);
      if (!rotated.ok) {
        log.warn('auth.http.refresh_refused', { errorCode: rotated.error.code });
        // One status and one body for every refusal. An unknown token, an
        // expired one, a rotated one and a deleted account must be
        // indistinguishable, or the endpoint becomes an oracle for which of
        // those a stolen token is.
        return errorResponse('invalid_request', 401);
      }

      return json(await sessionBody(rotated.value), 200);
    }

    /* ------------------------------ logout ----------------------------- */
    if (path === paths.logoutPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);

      const principal = await authenticate(request);
      if (principal === null) return errorResponse('invalid_request', 401);

      // The session revoked is the one the credential names. The request body
      // is not read at all, so there is no field in which another session id
      // or another account could be offered.
      await backend.sessions.revokeSession(principal);
      // Idempotent by construction: revoking an already-revoked session is a
      // write that changes nothing, and a second logout simply fails to
      // authenticate because the session it names is revoked. Both end
      // signed out, which is the only state logout is allowed to produce.
      return json({ ok: true }, 200);
    }

    /* -------------------------- email: start --------------------------- */
    if (path === paths.emailStartPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
      if (email === null) return errorResponse('not_found', 404);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);

      // 320 rather than the default 512: the service refuses anything over
      // 254, and a shorter bound here means an oversized value is refused
      // before it is read as a field at all.
      const address = requiredString(body, 'email', 320);
      if (address === null) return errorResponse('invalid_request', 400);

      const started = await email.start({ email: address, source: sourceOf(request) });
      if (!started.ok) {
        log.warn('auth.http.email_start_failed', { errorCode: started.error.code });
        return errorResponse('server_error', 500);
      }

      if (started.value.kind === 'refused') {
        log.warn('auth.http.email_start_refused', { reason: started.value.reason });
        return refuseStart(started.value.reason, started.value.retryAfterMs);
      }

      // The same body whether or not this address has ever been seen, because
      // the service never looked. The code is not in it, and no field here
      // could carry one.
      return json(
        {
          challengeId: started.value.challengeId,
          expiresAt: started.value.expiresAt,
          resendAvailableAt: started.value.resendAvailableAt,
        },
        200,
      );
    }

    /* -------------------------- email: verify -------------------------- */
    if (path === paths.emailVerifyPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
      if (email === null) return errorResponse('not_found', 404);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);

      const challengeId = requiredString(body, 'challengeId', 64);
      // 16 rather than 6: the service decides what a code looks like, and a
      // transport that pre-judged it would be a second place the rule lives.
      const code = requiredString(body, 'code', 16);
      if (challengeId === null || code === null) return errorResponse('invalid_request', 400);
      const deviceId = optionalString(body, 'deviceId', 64);

      const verified = await email.verify({
        challengeId,
        code,
        source: sourceOf(request),
        ...(deviceId === undefined ? {} : { deviceId }),
      });
      if (!verified.ok) {
        log.warn('auth.http.email_verify_failed', { errorCode: verified.error.code });
        return errorResponse('server_error', 500);
      }

      if (verified.value.kind === 'refused') {
        log.warn('auth.http.email_verify_refused', { reason: verified.value.reason });
        if (verified.value.reason === 'RATE_LIMITED') {
          return rateLimited(verified.value.retryAfterMs);
        }
        // 401 with a reason that describes **this caller's own challenge** and
        // nothing else. Whether an account exists, and whether an address is
        // already held elsewhere, are both folded into `UNAVAILABLE`.
        return json(
          {
            error: 'invalid_request',
            reason: verified.value.reason,
            remainingAttempts: verified.value.remainingAttempts,
          },
          401,
        );
      }

      return json(
        {
          ...(await sessionBody(verified.value.session)),
          deviceRegistered: verified.value.deviceRegistered,
          email: verified.value.email,
        },
        200,
      );
    }

    /* --------------------- me: list own identities --------------------- */
    if (path === paths.identitiesPath) {
      if (request.method !== 'GET') return errorResponse('method_not_allowed', 405);

      const principal = await authenticate(request);
      if (principal === null) return errorResponse('invalid_request', 401);

      // `listIdentities` takes the principal and has no account parameter, so
      // there is no way to ask for somebody else's — the enumeration this
      // route would otherwise offer is unrepresentable rather than refused.
      const rows = await backend.identities.listIdentities(principal);
      return json(
        {
          identities: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            // The address, for display. No subject: a Google `sub` is an
            // opaque provider identifier that says nothing to the person and
            // is the authority the account rests on, so it stays server-side.
            email: row.email,
            emailVerified: row.email_verified,
            linkedAt: row.linked_at,
            lastUsedAt: row.last_used_at,
            // Whether removing it is permitted *right now*, computed here so
            // the panel does not have to re-derive the last-identity rule and
            // get it subtly different.
            removable: rows.filter((other) => isVerified(other)).length > 1 && isVerified(row),
          })),
        },
        200,
      );
    }

    /* -------------------- me: start a linking flow --------------------- */
    if (path === paths.identityLinkStartPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);

      const principal = await authenticate(request);
      if (principal === null) return errorResponse('invalid_request', 401);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);
      const method = requiredString(body, 'method', 16);

      if (method === 'google') {
        if (google === null) return errorResponse('not_found', 404);
        // The principal is passed, never an account id from the body. The
        // challenge records the target from the session and the column is
        // write-once.
        const started = await google.start({ link: principal });
        if (!started.ok) return errorResponse('server_error', 500);
        return json(
          {
            method: 'google',
            challengeId: started.value.challengeId,
            authorizationUrl: started.value.authorizationUrl,
          },
          200,
        );
      }

      if (method === 'email') {
        if (email === null) return errorResponse('not_found', 404);
        const address = requiredString(body, 'email', 320);
        if (address === null) return errorResponse('invalid_request', 400);

        const started = await email.start({
          email: address,
          source: sourceOf(request),
          link: principal,
        });
        if (!started.ok) return errorResponse('server_error', 500);
        if (started.value.kind === 'refused') {
          log.warn('auth.http.link_start_refused', { reason: started.value.reason });
          return refuseStart(started.value.reason, started.value.retryAfterMs);
        }
        return json(
          {
            method: 'email',
            challengeId: started.value.challengeId,
            expiresAt: started.value.expiresAt,
            resendAvailableAt: started.value.resendAvailableAt,
          },
          200,
        );
      }

      return errorResponse('invalid_request', 400);
    }

    /* ------------------------ me: attach identity ----------------------- */
    if (path === paths.identityAttachPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);

      const principal = await authenticate(request);
      if (principal === null) return errorResponse('invalid_request', 401);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);

      const challengeId = requiredString(body, 'challengeId', 64);
      if (challengeId === null) return errorResponse('invalid_request', 400);

      // **There is no identity field on this route.** No email, no subject,
      // no kind, no `emailVerified`. The only thing a caller may send is
      // proof material for a flow the server itself started and the server
      // itself verifies, so "an email string is proof" is not a mistake this
      // endpoint can be talked into — there is nowhere to put the string.
      const code = optionalString(body, 'code', 16);
      const exchangeCode = optionalString(body, 'exchangeCode', 256);
      if ((code === undefined) === (exchangeCode === undefined)) {
        // Exactly one. Both would be a caller trying to pick whichever branch
        // the server happens to check first.
        return errorResponse('invalid_request', 400);
      }

      const attached =
        exchangeCode !== undefined
          ? google === null
            ? null
            : await google.completeLink(principal, { challengeId, exchangeCode })
          : email === null
            ? null
            : await email.completeLink(principal, {
                challengeId,
                code: code as string,
                source: sourceOf(request),
              });

      if (attached === null) return errorResponse('not_found', 404);
      if (!attached.ok) {
        log.warn('auth.http.attach_refused', { errorCode: attached.error.code });
        // `IDENTITY_IN_USE` is the one refusal a caller is entitled to tell
        // apart, because it is the only one that changes what they should do
        // next — and it names no account, says nothing about which one holds
        // the identity, and does not reveal that any particular account
        // exists (AUTH-28). Everything else collapses.
        return json(
          {
            error: 'invalid_request',
            reason: attached.error.code === 'IDENTITY_IN_USE' ? 'IDENTITY_IN_USE' : 'REFUSED',
          },
          attached.error.code === 'IDENTITY_IN_USE' ? 409 : 401,
        );
      }

      return json(
        {
          identity: {
            id: attached.value.id,
            kind: attached.value.kind,
            email: attached.value.email,
          },
        },
        200,
      );
    }

    /* ------------------------ me: detach identity ----------------------- */
    if (path === paths.identityDetachPath) {
      if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);

      const principal = await authenticate(request);
      if (principal === null) return errorResponse('invalid_request', 401);

      const body = await readJsonBody(request, limit);
      if (body === null) return errorResponse('invalid_request', 400);
      const identityId = requiredString(body, 'identityId', 64);
      if (identityId === null) return errorResponse('invalid_request', 400);

      // An identity on another account answers `NOT_FOUND`, identically to one
      // that does not exist, so detach cannot be used to discover whose an
      // identity is (AUTH-8).
      const detached = await backend.identities.detachIdentity(principal, identityId);
      if (!detached.ok) {
        log.warn('auth.http.detach_refused', { errorCode: detached.error.code });
        return json(
          {
            error: 'invalid_request',
            // `LAST_IDENTITY` is actionable — it tells the person to add a
            // second way in first — and reveals nothing about anybody else.
            reason: detached.error.code === 'LAST_IDENTITY' ? 'LAST_IDENTITY' : 'NOT_FOUND',
          },
          detached.error.code === 'LAST_IDENTITY' ? 409 : 404,
        );
      }

      return json({ revokedSessions: detached.value.revokedSessions }, 200);
    }

    return errorResponse('not_found', 404);
  };
}

/** A row that can actually be signed in with. Mirrors `IdentityService`. */
function isVerified(row: {
  readonly subject: string | null;
  readonly email: string | null;
  readonly email_verified: boolean;
}): boolean {
  if (row.subject !== null) return true;
  return row.email !== null && row.email_verified;
}

/**
 * The refusal shapes for `email/start`.
 *
 * A malformed address is a 400 and says so, because the caller already knows
 * what they typed and nothing about any account is revealed by telling them
 * it is not deliverable. Everything else is either a limit or an outage.
 */
function refuseStart(
  reason: 'INVALID_EMAIL' | 'RATE_LIMITED' | 'DELIVERY_FAILED' | 'BUSY',
  retryAfterMs: number | null,
): Response {
  switch (reason) {
    case 'INVALID_EMAIL':
      return errorResponse('invalid_request', 400);
    case 'RATE_LIMITED':
      return rateLimited(retryAfterMs);
    case 'DELIVERY_FAILED':
      // 502: this server is fine and the thing it depends on is not. Never
      // 200, which would leave a person waiting for a message that is not
      // coming.
      return errorResponse('unavailable', 502);
    case 'BUSY':
      return errorResponse('unavailable', 503);
  }
}

/**
 * 429, with the wait in the body and in the header.
 *
 * `Retry-After` is in whole seconds by the specification, rounded up so a
 * client that honours it never retries early. The body carries milliseconds
 * because the panel renders a countdown and a one-second granularity makes it
 * stutter.
 */
function rateLimited(retryAfterMs: number | null): Response {
  const ms = retryAfterMs ?? 0;
  return new Response(JSON.stringify({ error: 'rate_limited', retryAfterMs: ms }), {
    status: 429,
    headers: {
      ...SAFE_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'retry-after': String(Math.ceil(ms / 1000)),
    },
  });
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
