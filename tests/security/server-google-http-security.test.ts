/**
 * TEST-SECURITY-048 — attacking the Google auth flow through HTTP.
 *
 * The service-level refusals are proved in `server-google-security`. These
 * are the same attacks delivered the way a real attacker would deliver them:
 * as requests. That matters because a transport is where a correct service
 * gets undone — a status code that distinguishes two refusals, an error body
 * that names the reason, a replay that the router lets through because it
 * parsed the body differently the second time.
 *
 * The property asserted throughout is **indistinguishability**: every refusal
 * on a route answers with the same status and the same body, whatever was
 * wrong. An attacker who can tell "unknown state" from "spent challenge" from
 * "this Google account belongs to somebody else" learns what to try next.
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
  type GoogleTokenEndpoint,
  type IdentityBackend,
} from '@server/index';
import { GoogleFixture } from '../fixtures/google-oidc-fixture';

const NOW = 1_800_000_000_000;
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const ORIGIN = 'https://api.example.test';
const REDIRECT = `${ORIGIN}${DEFAULT_PATHS.redirectPath}`;
const DEVICE = 'dev_11111111-2222-3333-4444-555555555555';

describe('attacking Google sign-in over HTTP', () => {
  let clock: FixedClock;
  let google: GoogleFixture;
  let recorder: RecordingLogSink;
  let shared: { nonce: string; now: number; claims: Record<string, unknown> };
  let backend: IdentityBackend;
  let router: AuthRouter;
  let issuer: AccessTokenIssuer;

  beforeEach(async () => {
    clock = new FixedClock(NOW);
    google = await GoogleFixture.create();
    recorder = new RecordingLogSink();
    shared = { nonce: '', now: NOW, claims: {} };
    issuer = await createAccessTokenIssuer('k'.repeat(64));

    const tokens: GoogleTokenEndpoint = {
      async redeem() {
        return {
          idToken: await google.idToken(
            { audience: CLIENT_ID, nonce: shared.nonce, now: shared.now },
            shared.claims,
          ),
        };
      },
    };

    backend = createIdentityBackend({
      clock,
      log: createLogger(recorder.sink),
      google: {
        config: {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT,
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        },
        jwks: google.jwks(),
        tokens,
      },
    });
    router = createAuthRouter({
      backend,
      log: createLogger(recorder.sink),
      accessTokens: issuer,
      // These suites drive the Google and session routes, which are not rate
      // limited, so one constant source is all the limiter needs.
      sourceOf: () => 'suite',
    });
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    router(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  const get = (path: string): Promise<Response> =>
    router(new Request(`${ORIGIN}${path}`, { method: 'GET' }));

  /** Runs start, returning the challenge and the live state. */
  async function begin(): Promise<{ challengeId: string; state: string }> {
    const response = await post(DEFAULT_PATHS.startPath, {});
    const started = (await response.json()) as { challengeId: string; authorizationUrl: string };
    const url = new URL(started.authorizationUrl);
    shared.nonce = url.searchParams.get('nonce') ?? '';
    shared.now = clock.now();
    return { challengeId: started.challengeId, state: url.searchParams.get('state') ?? '' };
  }

  /** Completes the redirect leg, returning the landing URL. */
  async function callback(state: string): Promise<URL> {
    const response = await get(
      `${DEFAULT_PATHS.redirectPath}?code=google-code&state=${encodeURIComponent(state)}`,
    );
    return new URL(response.headers.get('location') ?? '', ORIGIN);
  }

  /** A complete sign-in, returning the artifact that was minted. */
  async function completeToArtifact(): Promise<{ challengeId: string; exchangeCode: string }> {
    const { state } = await begin();
    const landing = await callback(state);
    return {
      challengeId: landing.searchParams.get('challenge') ?? '',
      exchangeCode: landing.searchParams.get('code') ?? '',
    };
  }

  /* --------------------------- state and CSRF --------------------------- */

  it('01 — a callback with no state, an unknown state or a forged state all fail alike', async () => {
    await begin();

    const outcomes: string[] = [];
    for (const query of [
      '',
      '?code=google-code',
      '?state=not-a-real-state',
      '?code=google-code&state=not-a-real-state',
      '?code=google-code&state=' + 'a'.repeat(200),
      '?code=&state=',
    ]) {
      const response = await get(`${DEFAULT_PATHS.redirectPath}${query}`);
      const location = new URL(response.headers.get('location') ?? '', ORIGIN);
      outcomes.push(`${response.status}:${location.searchParams.get('error') ?? 'none'}`);
    }

    // One outcome, repeated. Nothing distinguishes an absent state from a
    // wrong one, which is what stops a state being probed for.
    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toBe('303:auth_failed');
  });

  it('02 — a callback that fails carries no challenge and no code', async () => {
    const landing = new URL(
      (await get(`${DEFAULT_PATHS.redirectPath}?code=x&state=y`)).headers.get('location') ?? '',
      ORIGIN,
    );
    expect(landing.searchParams.get('challenge')).toBeNull();
    expect(landing.searchParams.get('code')).toBeNull();
    expect(landing.pathname).toBe(DEFAULT_PATHS.callbackPath);
  });

  it('03 — a state cannot be replayed once it has been spent', async () => {
    const { state } = await begin();

    const first = await callback(state);
    expect(first.searchParams.get('code')).not.toBeNull();

    // Second presentation of the same state: the challenge was consumed
    // before anything else happened, so it finds a spent row.
    const second = await callback(state);
    expect(second.searchParams.get('code')).toBeNull();
    expect(second.searchParams.get('error')).toBe('auth_failed');
  });

  it('04 — two callbacks for one state do not both succeed', async () => {
    const { state } = await begin();

    const [a, b] = await Promise.all([callback(state), callback(state)]);
    const succeeded = [a, b].filter((url) => url.searchParams.get('code') !== null);

    expect(succeeded).toHaveLength(1);
  });

  /* ---------------------------- the artifact ---------------------------- */

  it('05 — the exchange artifact is single-use', async () => {
    const artifact = await completeToArtifact();

    const first = await post(DEFAULT_PATHS.exchangePath, { ...artifact, deviceId: DEVICE });
    expect(first.status).toBe(200);

    const second = await post(DEFAULT_PATHS.exchangePath, { ...artifact, deviceId: DEVICE });
    expect(second.status).toBe(401);
  });

  it('06 — an artifact from one flow cannot be used with another flow’s challenge', async () => {
    const a = await completeToArtifact();
    const b = await completeToArtifact();

    const crossed = await post(DEFAULT_PATHS.exchangePath, {
      challengeId: a.challengeId,
      exchangeCode: b.exchangeCode,
    });
    expect(crossed.status).toBe(401);
  });

  it('07 — an artifact is not a session token and buys nothing on its own', async () => {
    const { exchangeCode } = await completeToArtifact();

    // Without the challenge id the client has held since start, it is inert.
    const alone = await post(DEFAULT_PATHS.exchangePath, {
      challengeId: exchangeCode,
      exchangeCode,
    });
    expect(alone.status).toBe(401);
  });

  it('08 — every exchange refusal is the same status and the same body', async () => {
    const good = await completeToArtifact();
    await post(DEFAULT_PATHS.exchangePath, good); // spend it

    const bodies: string[] = [];
    const statuses: number[] = [];
    for (const attempt of [
      good, // spent
      { challengeId: 'chl_00000000000000000000000000000000', exchangeCode: 'nope' }, // unknown
      { challengeId: good.challengeId, exchangeCode: 'wrong-code' }, // wrong artifact
    ]) {
      const response = await post(DEFAULT_PATHS.exchangePath, attempt);
      statuses.push(response.status);
      bodies.push(await response.text());
    }

    expect(new Set(statuses).size).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    expect(statuses[0]).toBe(401);
  });

  /* -------------------------- identity spoofing -------------------------- */

  it('09 — the client cannot name the account, the subject or the email', async () => {
    const artifact = await completeToArtifact();

    const response = await post(DEFAULT_PATHS.exchangePath, {
      ...artifact,
      // Every field an attacker would try. None is read: the route has no
      // parameter for any of them, and identity comes from the verified token.
      abaUserId: 'usr_ffffffffffffffffffffffffffffffff',
      sub: 'attacker-subject',
      email: 'victim@example.com',
      emailVerified: true,
      subject: 'attacker-subject',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { abaUserId: string };
    expect(body.abaUserId).not.toBe('usr_ffffffffffffffffffffffffffffffff');
    expect(body.abaUserId.startsWith('usr_')).toBe(true);
  });

  it('10 — a forged ID token is refused, and the refusal looks like every other', async () => {
    // The token endpoint returns a token signed by a *different* key: the
    // shape an attacker who cannot sign for Google would produce.
    const impostor = await GoogleFixture.create('impostor-key');
    const forged = createIdentityBackend({
      clock,
      log: createLogger(recorder.sink),
      google: {
        config: {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT,
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        },
        // Published keys are the real fixture's; the token is the impostor's.
        jwks: google.jwks(),
        tokens: {
          redeem: async () => ({
            idToken: await impostor.idToken({ audience: CLIENT_ID, nonce: 'n', now: NOW }),
          }),
        },
      },
    });
    const forgedRouter = createAuthRouter({
      sourceOf: () => 'suite',
      backend: forged,
      log: createLogger(recorder.sink),
      accessTokens: issuer,
    });

    const start = await forgedRouter(
      new Request(`${ORIGIN}${DEFAULT_PATHS.startPath}`, { method: 'POST' }),
    );
    const started = (await start.json()) as { authorizationUrl: string };
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

    const response = await forgedRouter(
      new Request(`${ORIGIN}${DEFAULT_PATHS.redirectPath}?code=c&state=${state}`),
    );
    const landing = new URL(response.headers.get('location') ?? '', ORIGIN);

    expect(landing.searchParams.get('code')).toBeNull();
    expect(landing.searchParams.get('error')).toBe('auth_failed');
  });

  /* ------------------------------ sessions ------------------------------ */

  it('11 — a returning sign-in reuses the account and never creates a second', async () => {
    const first = await post(DEFAULT_PATHS.exchangePath, {
      ...(await completeToArtifact()),
      deviceId: DEVICE,
    });
    const second = await post(DEFAULT_PATHS.exchangePath, {
      ...(await completeToArtifact()),
      deviceId: DEVICE,
    });

    const a = (await first.json()) as { abaUserId: string; refreshToken: string };
    const b = (await second.json()) as { abaUserId: string; refreshToken: string };

    expect(b.abaUserId).toBe(a.abaUserId);
    // A new session each time, so the refresh tokens differ.
    expect(b.refreshToken).not.toBe(a.refreshToken);
  });

  it('12 — a deleted account cannot sign in, and says nothing about why', async () => {
    const first = await post(DEFAULT_PATHS.exchangePath, {
      ...(await completeToArtifact()),
      deviceId: DEVICE,
    });
    const { abaUserId } = (await first.json()) as { abaUserId: string };
    await backend.store.markUserDeleted(abaUserId, clock.now());

    // The refusal happens at the callback, before an artifact is minted —
    // earlier than the exchange, and better: there is no artifact to leak and
    // nothing for the client to retry with.
    const { state } = await begin();
    const landing = await callback(state);

    expect(landing.searchParams.get('code')).toBeNull();
    // Indistinguishable from an unknown state or a forged token. The error
    // does not confirm that this Google account ever had an ABA account.
    expect(landing.searchParams.get('error')).toBe('auth_failed');

    // And the exchange has nothing to accept either way.
    const response = await post(DEFAULT_PATHS.exchangePath, {
      challengeId: 'chl_00000000000000000000000000000000',
      exchangeCode: 'anything',
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(JSON.stringify({ error: 'invalid_request' }));
  });

  /* --------------------------- token handling --------------------------- */

  it('13 — no response body carries the Google code, the verifier or the nonce', async () => {
    const { state } = await begin();
    const nonce = shared.nonce;
    const landing = await callback(state);
    const response = await post(DEFAULT_PATHS.exchangePath, {
      challengeId: landing.searchParams.get('challenge'),
      exchangeCode: landing.searchParams.get('code'),
      deviceId: DEVICE,
    });
    const body = await response.text();

    for (const secret of ['google-code', state, nonce, 'code_verifier']) {
      expect(body, secret).not.toContain(secret);
    }
  });

  it('14 — an access token from one deployment does not verify under another key', async () => {
    const artifact = await completeToArtifact();
    const response = await post(DEFAULT_PATHS.exchangePath, { ...artifact, deviceId: DEVICE });
    const { accessToken } = (await response.json()) as { accessToken: string };

    const other = await createAccessTokenIssuer('x'.repeat(64));
    expect(await other.verify(accessToken, NOW)).toBeNull();
    // And it still verifies under its own.
    expect(await issuer.verify(accessToken, NOW)).not.toBeNull();
  });

  /* ------------------------ isolation guarantees ------------------------ */

  it('15 — the whole flow touches no provider credential and no K1 material', async () => {
    await post(DEFAULT_PATHS.exchangePath, {
      ...(await completeToArtifact()),
      deviceId: DEVICE,
    });

    // The backend's schema has nowhere to put any of this, which is the real
    // guarantee. Asserted over everything the flow wrote.
    const serialised = JSON.stringify({
      logs: recorder.records,
      store: await backend.store.listDevices(
        (await backend.store.findIdentityBySubject('google', 'google-subject-1'))?.aba_user_id ??
          '',
      ),
    });
    for (const forbidden of [
      'apiKey',
      'api_key',
      'providerKey',
      'recoveryKey',
      'kek',
      'dek',
      'ciphertext',
      'envelope',
    ]) {
      expect(serialised.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('16 — the router holds no network primitive of its own', async () => {
    // The backend reaches Google through the injected `GoogleTokenEndpoint`
    // port and the JWKS provider, never by calling out itself. A transport
    // that could fetch would be a fourth network holder nobody reviewed.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../server/http/router.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|globalThis\.fetch|new WebSocket|XMLHttpRequest/);
  });
});
