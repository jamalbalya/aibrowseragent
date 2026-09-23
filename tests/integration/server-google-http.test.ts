/**
 * TEST-SERVER-023 — the HTTP surface, driven as HTTP.
 *
 * The service's behaviour is proved in `server-google-flow`. What this adds is
 * everything that only exists once there is a transport: routing, methods,
 * bodies, status codes, redirects, headers, and the exact shape of what a
 * client receives.
 *
 * The handler is a pure `(Request) => Promise<Response>`, so every case here
 * is a real request through the real router against a real backend. Nothing
 * is stubbed except Google itself, which is a controlled fixture signing
 * genuine RS256 tokens with a keypair the test generated.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccessTokenIssuer,
  createAuthRouter,
  createIdentityBackend,
  createLogger,
  DEFAULT_PATHS,
  FixedClock,
  MAX_BODY_BYTES,
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
const SIGNING_KEY = 'k'.repeat(64);
const DEVICE = 'dev_11111111-2222-3333-4444-555555555555';

describe('the Google auth HTTP surface', () => {
  let clock: FixedClock;
  let google: GoogleFixture;
  let recorder: RecordingLogSink;
  let shared: { nonce: string; now: number };
  let backend: IdentityBackend;
  let router: AuthRouter;
  let issuer: AccessTokenIssuer;

  beforeEach(async () => {
    clock = new FixedClock(NOW);
    google = await GoogleFixture.create();
    recorder = new RecordingLogSink();
    shared = { nonce: '', now: NOW };
    issuer = await createAccessTokenIssuer(SIGNING_KEY);

    const tokens: GoogleTokenEndpoint = {
      async redeem() {
        return {
          idToken: await google.idToken({
            audience: CLIENT_ID,
            nonce: shared.nonce,
            now: shared.now,
          }),
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
    router = createAuthRouter({ backend, log: createLogger(recorder.sink), accessTokens: issuer });
  });

  const post = (path: string, body?: unknown): Promise<Response> =>
    router(
      new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const get = (path: string): Promise<Response> =>
    router(new Request(`${ORIGIN}${path}`, { method: 'GET' }));

  /**
   * start → redirect → exchange, over HTTP, returning each response.
   *
   * `deviceId` is `null` for "send none" rather than `undefined`, because a
   * default parameter applies to an explicit `undefined` too — which would
   * have made the no-device case silently send one.
   */
  async function signIn(deviceId: string | null = DEVICE) {
    const startResponse = await post(DEFAULT_PATHS.startPath, {});
    const started = (await startResponse.json()) as {
      challengeId: string;
      authorizationUrl: string;
    };

    const authorize = new URL(started.authorizationUrl);
    shared.nonce = authorize.searchParams.get('nonce') ?? '';
    shared.now = clock.now();
    const state = authorize.searchParams.get('state') ?? '';

    const redirect = await get(
      `${DEFAULT_PATHS.redirectPath}?code=google-auth-code&state=${encodeURIComponent(state)}`,
    );
    const landing = new URL(redirect.headers.get('location') ?? '', ORIGIN);

    const exchange = await post(DEFAULT_PATHS.exchangePath, {
      challengeId: landing.searchParams.get('challenge'),
      exchangeCode: landing.searchParams.get('code'),
      ...(deviceId === null ? {} : { deviceId }),
    });

    return { startResponse, started, redirect, landing, exchange };
  }

  /* ------------------------------ routing ------------------------------ */

  it('01 — serves exactly four paths and 404s everything else', async () => {
    for (const path of ['/', '/v1', '/v1/auth', '/v1/auth/google', '/admin', '/../etc/passwd']) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('02 — refuses the wrong method on every route', async () => {
    expect((await get(DEFAULT_PATHS.startPath)).status).toBe(405);
    expect((await get(DEFAULT_PATHS.exchangePath)).status).toBe(405);
    expect((await post(DEFAULT_PATHS.redirectPath)).status).toBe(405);
    expect((await post(DEFAULT_PATHS.callbackPath)).status).toBe(405);
  });

  it('03 — every route is absent when Google is not configured', async () => {
    const plain = createIdentityBackend({ clock, log: createLogger(recorder.sink) });
    const bare = createAuthRouter({
      backend: plain,
      log: createLogger(recorder.sink),
      accessTokens: issuer,
    });

    // 404, not 500 and not 503: an unconfigured feature should look the same
    // as one that does not exist, and say the same thing to everyone.
    expect(
      (await bare(new Request(`${ORIGIN}${DEFAULT_PATHS.startPath}`, { method: 'POST' }))).status,
    ).toBe(404);
    expect(
      (await bare(new Request(`${ORIGIN}${DEFAULT_PATHS.exchangePath}`, { method: 'POST' })))
        .status,
    ).toBe(404);
  });

  it('04 — refuses a malformed or oversized body', async () => {
    const malformed = await router(
      new Request(`${ORIGIN}${DEFAULT_PATHS.exchangePath}`, {
        method: 'POST',
        body: '{not json',
      }),
    );
    expect(malformed.status).toBe(400);

    const oversized = await router(
      new Request(`${ORIGIN}${DEFAULT_PATHS.exchangePath}`, {
        method: 'POST',
        body: JSON.stringify({ challengeId: 'x'.repeat(MAX_BODY_BYTES + 10) }),
      }),
    );
    expect(oversized.status).toBe(400);
  });

  it('05 — refuses an exchange missing either half', async () => {
    for (const body of [
      {},
      { challengeId: 'chl_1' },
      { exchangeCode: 'code' },
      { challengeId: '', exchangeCode: 'code' },
      { challengeId: 'chl_1', exchangeCode: 42 },
    ]) {
      expect((await post(DEFAULT_PATHS.exchangePath, body)).status).toBe(400);
    }
  });

  /* ------------------------------- flow -------------------------------- */

  it('06 — a whole sign-in works over HTTP and returns a session', async () => {
    const { startResponse, redirect, exchange } = await signIn();

    expect(startResponse.status).toBe(200);
    expect(redirect.status).toBe(303);
    expect(exchange.status).toBe(200);

    const body = (await exchange.json()) as Record<string, unknown>;
    expect(typeof body.abaUserId).toBe('string');
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.deviceRegistered).toBe(true);
  });

  it('07 — the access token verifies, names the session, and carries no profile', async () => {
    const { exchange } = await signIn();
    const body = (await exchange.json()) as { accessToken: string; abaUserId: string };

    const claims = await issuer.verify(body.accessToken, clock.now());
    expect(claims?.sub).toBe(body.abaUserId);
    expect(typeof claims?.sid).toBe('string');

    // No email, no Google subject, no device id, no refresh token.
    const decoded = JSON.stringify(claims);
    expect(Object.keys(claims ?? {}).sort()).toEqual(['exp', 'iat', 'sid', 'sub']);
    expect(decoded).not.toContain('@');
  });

  it('08 — the start response carries no state, nonce or verifier', async () => {
    const { startResponse, started } = await signIn();
    const raw = JSON.stringify(started);

    expect(Object.keys(started).sort()).toEqual(['authorizationUrl', 'challengeId']);
    // The authorization URL necessarily carries state and nonce — Google needs
    // them — but the response body has no field of its own for either, and
    // the PKCE verifier appears nowhere at all.
    expect(startResponse.status).toBe(200);
    const challenge = new URL(started.authorizationUrl).searchParams.get('code_challenge');
    expect(challenge).not.toBeNull();
    expect(raw).not.toContain('code_verifier');
  });

  it('09 — no bearer token ever reaches a URL', async () => {
    const { started, landing, exchange } = await signIn();
    const body = (await exchange.json()) as Record<string, string>;

    const urls = [started.authorizationUrl, landing.toString()];
    for (const url of urls) {
      expect(url).not.toContain(body.accessToken!);
      expect(url).not.toContain(body.refreshToken!);
      expect(url).not.toContain(body.abaUserId!);
    }
    // The one value that is in a URL is the single-use exchange artifact.
    expect(landing.searchParams.get('code')).not.toBeNull();
  });

  it('10 — the landing page is static, scriptless and reflects nothing', async () => {
    const response = await get(`${DEFAULT_PATHS.callbackPath}?challenge=chl_1&code=abc123`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).not.toContain('<script');
    // Nothing from the query string is echoed into the document.
    expect(html).not.toContain('chl_1');
    expect(html).not.toContain('abc123');
  });

  /* ------------------------------ headers ------------------------------ */

  it('11 — every response is uncacheable and sends no referrer', async () => {
    const responses = [
      await post(DEFAULT_PATHS.startPath, {}),
      await get(DEFAULT_PATHS.callbackPath),
      await get('/nope'),
      await post(DEFAULT_PATHS.exchangePath, { challengeId: 'a', exchangeCode: 'b' }),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      // The callback URL carries the exchange artifact; a Referer header is
      // how a value in a URL escapes the page it was meant for.
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('12 — no CORS header is sent, so no web page can call these routes', async () => {
    const response = await post(DEFAULT_PATHS.startPath, {});
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  /* ------------------------------ device ------------------------------- */

  it('13 — the device is registered against the account that signed in', async () => {
    const { exchange } = await signIn();
    const body = (await exchange.json()) as { abaUserId: string; deviceRegistered: boolean };

    expect(body.deviceRegistered).toBe(true);
    const row = await backend.store.getDevice(body.abaUserId, DEVICE);
    expect(row?.device_id).toBe(DEVICE);
    expect(row?.retired_at).toBeNull();
  });

  it('14 — a sign-in with no device id still succeeds and says so', async () => {
    const { exchange } = await signIn(null);
    const body = (await exchange.json()) as { deviceRegistered: boolean };

    // Authentication succeeded; a device association is not what authorised
    // it. Reporting false is the truth rather than a silent true.
    expect(exchange.status).toBe(200);
    expect(body.deviceRegistered).toBe(false);
  });

  it('15 — a malformed device id is refused without failing the sign-in', async () => {
    for (const bad of [
      '7c9e6679-7425-40de-944b-e07fc1f90ae7', // a bare UUID: the old client's shape
      'dev_not-a-uuid',
      '12', // a tab id
      'chrome-extension://abcdefghijklmnop',
    ]) {
      const { exchange } = await signIn(bad);
      const body = (await exchange.json()) as { deviceRegistered: boolean };
      expect(exchange.status, bad).toBe(200);
      expect(body.deviceRegistered, bad).toBe(false);
    }
  });

  it('16 — signing in twice on one machine produces one device, not two', async () => {
    const first = await signIn();
    const second = await signIn();

    const a = (await first.exchange.json()) as { abaUserId: string };
    const b = (await second.exchange.json()) as { abaUserId: string };
    expect(b.abaUserId).toBe(a.abaUserId);

    const devices = await backend.store.listDevices(a.abaUserId);
    expect(devices).toHaveLength(1);
  });

  /* ------------------------------ logging ------------------------------ */

  it('17 — no secret is logged anywhere in a whole sign-in', async () => {
    const { started, landing, exchange } = await signIn();
    const body = (await exchange.json()) as Record<string, string>;
    const logs = JSON.stringify(recorder.records);

    const state = new URL(started.authorizationUrl).searchParams.get('state');
    const nonce = new URL(started.authorizationUrl).searchParams.get('nonce');
    for (const secret of [
      body.accessToken,
      body.refreshToken,
      landing.searchParams.get('code'),
      state,
      nonce,
      'google-auth-code',
    ]) {
      expect(logs, String(secret)).not.toContain(secret);
    }
  });
});
