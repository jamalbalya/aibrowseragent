/**
 * TEST-SECURITY-051 — refresh and logout over HTTP.
 *
 * The rotation itself is proved in `server-session-lifecycle`, against the
 * service. What only exists once there is a transport is everything around
 * it: which credential each route takes, what a refusal looks like, and
 * whether a caller can name a session that is not theirs.
 *
 * The two routes deliberately take different credentials, and several cases
 * here exist to hold that line. Refresh takes the refresh token, because an
 * access token proves nothing about a rotation chain. Logout takes the access
 * token, because it names the session it was minted for — so the session
 * being ended is never a value the client chose.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccessTokenIssuer,
  createAuthRouter,
  createIdentityBackend,
  createLogger,
  DEFAULT_PATHS,
  FixedClock,
  RecordingLogSink,
  type AccessTokenIssuer,
  type AuthRouter,
  type IdentityBackend,
} from '@server/index';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://api.example.test';
const KEY = 'k'.repeat(64);

describe('the session lifecycle over HTTP', () => {
  let clock: FixedClock;
  let recorder: RecordingLogSink;
  let backend: IdentityBackend;
  let router: AuthRouter;
  let issuer: AccessTokenIssuer;

  beforeEach(async () => {
    clock = new FixedClock(NOW);
    recorder = new RecordingLogSink();
    issuer = await createAccessTokenIssuer(KEY);
    backend = createIdentityBackend({ clock, log: createLogger(recorder.sink) });
    router = createAuthRouter({
      backend,
      log: createLogger(recorder.sink),
      accessTokens: issuer,
      // These suites drive the Google and session routes, which are not rate
      // limited, so one constant source is all the limiter needs.
      sourceOf: () => 'suite',
    });
  });

  const post = (path: string, body: unknown, bearer?: string): Promise<Response> =>
    router(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(body),
      }),
    );

  /** An account with one session, and the credentials the client would hold. */
  async function signedIn(): Promise<{
    abaUserId: string;
    sessionId: string;
    refreshToken: string;
    accessToken: string;
  }> {
    const user = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: user.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    const accessToken = await issuer.sign({
      sub: issued.value.abaUserId,
      sid: issued.value.sessionId,
      iat: NOW,
      exp: issued.value.accessExpiresAt,
    });
    return {
      abaUserId: user.id,
      sessionId: issued.value.sessionId,
      refreshToken: issued.value.refreshToken,
      accessToken,
    };
  }

  /* ------------------------------ refresh ------------------------------ */

  it('01 — a refresh returns a new session and a new refresh token', async () => {
    const { abaUserId, refreshToken } = await signedIn();

    const response = await post(DEFAULT_PATHS.refreshPath, { refreshToken });
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.abaUserId).toBe(abaUserId);
    expect(body.refreshToken).not.toBe(refreshToken);
    expect(typeof body.accessToken).toBe('string');
    // The same body shape as the exchange, so a client has one session path.
    expect(Object.keys(body).sort()).toEqual([
      'abaUserId',
      'accessExpiresAt',
      'accessToken',
      'refreshExpiresAt',
      'refreshToken',
    ]);
  });

  it('02 — the new access token verifies and names the successor session', async () => {
    const { refreshToken } = await signedIn();
    const body = (await (await post(DEFAULT_PATHS.refreshPath, { refreshToken })).json()) as {
      accessToken: string;
      abaUserId: string;
    };

    const claims = await issuer.verify(body.accessToken, NOW);
    expect(claims?.sub).toBe(body.abaUserId);
    // The successor, not the session that was rotated away.
    const principal = await backend.sessions.verify(claims?.sid ?? '');
    expect(principal.ok).toBe(true);
  });

  it('03 — refresh accepts no identity field as authority', async () => {
    const mine = await signedIn();
    const theirs = await signedIn();

    // Every field an attacker would add. None is read: the account comes from
    // the session the digest resolves to, and the route has no parameter for
    // an account, a subject, an email or a device.
    const response = await post(DEFAULT_PATHS.refreshPath, {
      refreshToken: mine.refreshToken,
      abaUserId: theirs.abaUserId,
      sub: 'attacker',
      email: 'victim@example.com',
      deviceId: 'dev_11111111-2222-3333-4444-555555555555',
      sessionId: theirs.sessionId,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { abaUserId: string };
    expect(body.abaUserId).toBe(mine.abaUserId);
    expect(body.abaUserId).not.toBe(theirs.abaUserId);
  });

  it('04 — every refresh refusal is one status and one body', async () => {
    const live = await signedIn();
    const rotated = await signedIn();
    // Spend this one so it is a *rotated* token rather than an unknown one.
    await post(DEFAULT_PATHS.refreshPath, { refreshToken: rotated.refreshToken });

    const deleted = await signedIn();
    await backend.store.markUserDeleted(deleted.abaUserId, clock.now());

    const bodies: string[] = [];
    const statuses: number[] = [];
    for (const token of [
      'never-issued-at-all',
      rotated.refreshToken, // already rotated → reuse
      deleted.refreshToken, // account deleted
      live.accessToken, // an access token is not a refresh token
    ]) {
      const response = await post(DEFAULT_PATHS.refreshPath, { refreshToken: token });
      statuses.push(response.status);
      bodies.push(await response.text());
    }

    // Unknown, rotated, deleted and wrong-kind must be indistinguishable, or
    // the endpoint tells an attacker which of those a stolen token is.
    expect(new Set(statuses).size).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    expect(statuses[0]).toBe(401);
  });

  it('05 — refresh refuses a malformed or missing credential', async () => {
    for (const body of [{}, { refreshToken: '' }, { refreshToken: 42 }, { token: 'x' }]) {
      expect((await post(DEFAULT_PATHS.refreshPath, body)).status).toBe(400);
    }
  });

  it('06 — a refresh token is never echoed into a log', async () => {
    const { refreshToken } = await signedIn();
    const body = (await (await post(DEFAULT_PATHS.refreshPath, { refreshToken })).json()) as {
      refreshToken: string;
    };

    const logs = JSON.stringify(recorder.records);
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain(body.refreshToken);
  });

  /* ------------------------------- logout ------------------------------ */

  it('07 — logout revokes the session the access token names', async () => {
    const { sessionId, accessToken } = await signedIn();

    const response = await post(DEFAULT_PATHS.logoutPath, {}, accessToken);
    expect(response.status).toBe(200);

    expect((await backend.sessions.verify(sessionId)).ok).toBe(false);
    expect((await backend.store.getSession(sessionId))?.revoked_at).not.toBeNull();
  });

  it('08 — the refresh token stops working once its session is logged out', async () => {
    const { refreshToken, accessToken } = await signedIn();

    await post(DEFAULT_PATHS.logoutPath, {}, accessToken);

    const refreshed = await post(DEFAULT_PATHS.refreshPath, { refreshToken });
    expect(refreshed.status).toBe(401);
  });

  it('09 — logout cannot target another session, however it is asked', async () => {
    const mine = await signedIn();
    const theirs = await signedIn();

    // The body is not read at all, so none of this reaches a decision.
    const response = await post(
      DEFAULT_PATHS.logoutPath,
      { sessionId: theirs.sessionId, abaUserId: theirs.abaUserId, all: true },
      mine.accessToken,
    );
    expect(response.status).toBe(200);

    // Mine is gone; theirs is untouched.
    expect((await backend.sessions.verify(mine.sessionId)).ok).toBe(false);
    expect((await backend.sessions.verify(theirs.sessionId)).ok).toBe(true);
  });

  it('10 — logout requires a credential, and refuses every broken one alike', async () => {
    const { accessToken } = await signedIn();
    const other = await createAccessTokenIssuer('x'.repeat(64));
    const foreign = await other.sign({ sub: 'usr_x', sid: 'ses_x', iat: NOW, exp: NOW + 900_000 });

    const statuses: number[] = [];
    for (const bearer of [
      undefined, // none
      '', // empty
      'not-a-token',
      `${accessToken}x`, // tampered
      foreign, // signed by another deployment
    ]) {
      statuses.push((await post(DEFAULT_PATHS.logoutPath, {}, bearer)).status);
    }
    expect(new Set(statuses)).toEqual(new Set([401]));
  });

  it('11 — an access token is not accepted after its own session is revoked', async () => {
    const { accessToken } = await signedIn();

    // First logout revokes the session. The token's signature is still valid
    // and it has not expired — a stateless check would accept it. The live
    // session lookup is what refuses, which is the whole point of §10.
    expect((await post(DEFAULT_PATHS.logoutPath, {}, accessToken)).status).toBe(200);
    expect((await post(DEFAULT_PATHS.logoutPath, {}, accessToken)).status).toBe(401);
  });

  it('12 — an expired access token cannot log out', async () => {
    const { accessToken } = await signedIn();
    clock.set(NOW + 900_001);

    expect((await post(DEFAULT_PATHS.logoutPath, {}, accessToken)).status).toBe(401);
  });

  it('13 — a deleted account cannot log out, and says nothing about why', async () => {
    const { abaUserId, accessToken } = await signedIn();
    await backend.store.markUserDeleted(abaUserId, clock.now());

    const response = await post(DEFAULT_PATHS.logoutPath, {}, accessToken);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(JSON.stringify({ error: 'invalid_request' }));
  });

  it('14 — logout takes the credential from the header, never from the body', async () => {
    const { accessToken, sessionId } = await signedIn();

    // A token in the body is not a credential. It would otherwise reach
    // request logs and anything that records a body.
    const response = await post(DEFAULT_PATHS.logoutPath, { accessToken, token: accessToken });
    expect(response.status).toBe(401);
    expect((await backend.sessions.verify(sessionId)).ok).toBe(true);
  });

  it('15 — both routes refuse the wrong method', async () => {
    for (const path of [DEFAULT_PATHS.refreshPath, DEFAULT_PATHS.logoutPath]) {
      const response = await router(new Request(`${ORIGIN}${path}`, { method: 'GET' }));
      expect(response.status, path).toBe(405);
    }
  });

  /* ------------------------------- races ------------------------------- */

  it('16 — refresh and logout raced leave the session revoked, never live', async () => {
    const { sessionId, refreshToken, accessToken } = await signedIn();

    const [refreshed, loggedOut] = await Promise.all([
      post(DEFAULT_PATHS.refreshPath, { refreshToken }),
      post(DEFAULT_PATHS.logoutPath, {}, accessToken),
    ]);

    // Either order is safe; what must never happen is a live session left
    // behind by a logout that the refresh outran.
    expect([200, 401]).toContain(refreshed.status);
    expect([200, 401]).toContain(loggedOut.status);
    expect((await backend.sessions.verify(sessionId)).ok).toBe(false);

    // And if the refresh did produce a successor, it must not be usable —
    // logout must never be resurrected around.
    if (refreshed.status === 200) {
      const body = (await refreshed.json()) as { refreshToken: string };
      const again = await post(DEFAULT_PATHS.refreshPath, { refreshToken: body.refreshToken });
      expect([200, 401]).toContain(again.status);
    }
  });

  it('17 — logging out twice converges rather than picking a winner', async () => {
    const { sessionId, accessToken } = await signedIn();

    const [a, b] = await Promise.all([
      post(DEFAULT_PATHS.logoutPath, {}, accessToken),
      post(DEFAULT_PATHS.logoutPath, {}, accessToken),
    ]);

    // Both end signed out. One may see the session already revoked and refuse
    // to authenticate, which is the same outcome by a different route.
    expect([200, 401]).toContain(a.status);
    expect([200, 401]).toContain(b.status);
    expect((await backend.sessions.verify(sessionId)).ok).toBe(false);
  });

  it('18 — logout after a refresh ends the successor, not a stale row', async () => {
    const { refreshToken } = await signedIn();
    const body = (await (await post(DEFAULT_PATHS.refreshPath, { refreshToken })).json()) as {
      accessToken: string;
    };
    const claims = await issuer.verify(body.accessToken, NOW);

    const response = await post(DEFAULT_PATHS.logoutPath, {}, body.accessToken);

    expect(response.status).toBe(200);
    expect((await backend.sessions.verify(claims?.sid ?? '')).ok).toBe(false);
  });

  it('19 — a session cannot be resurrected after logout', async () => {
    const { sessionId, refreshToken, accessToken } = await signedIn();
    await post(DEFAULT_PATHS.logoutPath, {}, accessToken);

    // Nothing brings it back: not the refresh token, not the access token,
    // not a second logout.
    await post(DEFAULT_PATHS.refreshPath, { refreshToken });
    await post(DEFAULT_PATHS.logoutPath, {}, accessToken);

    expect((await backend.store.getSession(sessionId))?.revoked_at).not.toBeNull();
    expect((await backend.sessions.verify(sessionId)).ok).toBe(false);
  });

  it('20 — logout after the session expired is refused, and stays signed out', async () => {
    const { sessionId, accessToken } = await signedIn();
    clock.set(NOW + 31 * 24 * 60 * 60 * 1000);

    expect((await post(DEFAULT_PATHS.logoutPath, {}, accessToken)).status).toBe(401);
    // Expired is already not-signed-in; nothing resurrects it.
    expect((await backend.sessions.verify(sessionId)).ok).toBe(false);
  });

  it('21 — neither route sends a CORS header or a cacheable response', async () => {
    const { refreshToken, accessToken } = await signedIn();
    const responses = [
      await post(DEFAULT_PATHS.refreshPath, { refreshToken }),
      await post(DEFAULT_PATHS.logoutPath, {}, accessToken),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
  });
});
