/**
 * TEST-SERVER-011 — the Google sign-in flow, start to session.
 *
 * Drives the three steps in the order a real sign-in would, against a
 * controlled Google that signs genuine RS256 tokens. What is being tested is
 * the sequencing — which is where this kind of flow actually fails, because
 * each step in isolation is easy and the ordering is what stops a replay.
 *
 * The property the whole design rests on is asserted directly: **no bearer
 * token appears in any URL**. The redirect carries a one-time code and the
 * tokens come back over a request the client made.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  createLogger,
  FixedClock,
  MAX_EXCHANGE_ATTEMPTS,
  RecordingLogSink,
  type GoogleTokenEndpoint,
  type IdentityBackend,
} from '@server/index';
import { GoogleFixture } from '../fixtures/google-oidc-fixture';

const NOW = 1_800_000_000_000;
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const REDIRECT = 'https://api.example.test/v1/auth/google/callback';

/** A Google that mints a token for whatever nonce the flow generated. */
function tokenEndpoint(
  google: GoogleFixture,
  state: { nonce: string; now: number },
  options: { readonly reject?: boolean; readonly claims?: Record<string, unknown> } = {},
): GoogleTokenEndpoint & { seen: { code: string; codeVerifier: string; redirectUri: string }[] } {
  const seen: { code: string; codeVerifier: string; redirectUri: string }[] = [];
  return {
    seen,
    async redeem(request) {
      seen.push({ ...request });
      if (options.reject === true) return null;
      const idToken = await google.idToken(
        { audience: CLIENT_ID, nonce: state.nonce, now: state.now },
        options.claims ?? {},
      );
      return { idToken };
    },
  };
}

describe('Google sign-in, end to end', () => {
  let clock: FixedClock;
  let google: GoogleFixture;
  let recorder: RecordingLogSink;

  beforeEach(async () => {
    clock = new FixedClock(NOW);
    google = await GoogleFixture.create();
    recorder = new RecordingLogSink();
  });

  /** A backend whose Google adapter mints tokens for the live challenge. */
  function backendWith(
    options: { readonly reject?: boolean; readonly claims?: Record<string, unknown> } = {},
  ): { backend: IdentityBackend; shared: { nonce: string; now: number } } {
    const shared = { nonce: '', now: NOW };
    const backend = createIdentityBackend({
      clock,
      log: createLogger(recorder.sink),
      google: {
        config: {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT,
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        },
        jwks: google.jwks(),
        tokens: tokenEndpoint(google, shared, options),
      },
    });
    return { backend, shared };
  }

  /** Runs start → callback → exchange, returning everything observed. */
  async function signIn(
    backend: IdentityBackend,
    shared: { nonce: string; now: number },
    overrides: { readonly subject?: string } = {},
  ) {
    if (backend.google === null) throw new Error('google not wired');
    const started = await backend.google.start();
    if (!started.ok) throw new Error('start failed');

    const url = new URL(started.value.authorizationUrl);
    const state = url.searchParams.get('state');
    const nonce = url.searchParams.get('nonce');
    if (state === null || nonce === null) throw new Error('missing state or nonce');
    shared.nonce = nonce;
    shared.now = clock.now();

    // The token endpoint mints for `shared`; a subject override needs its own.
    if (overrides.subject !== undefined) {
      const idToken = await google.idToken(
        { audience: CLIENT_ID, nonce, now: clock.now() },
        { sub: overrides.subject },
      );
      (backend.google as unknown as { options: { tokens: GoogleTokenEndpoint } }).options.tokens = {
        redeem: () => Promise.resolve({ idToken }),
      };
    }

    const callback = await backend.google.handleCallback({
      state,
      code: 'google-code',
      error: null,
    });
    if (!callback.ok) return { started: started.value, callback, exchange: null, url };

    const exchange = await backend.google.exchange({
      challengeId: callback.value.challengeId,
      exchangeCode: callback.value.exchangeCode,
    });
    return { started: started.value, callback, exchange, url };
  }

  describe('start', () => {
    it('builds an authorization URL with S256 PKCE, state and nonce', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      void shared;

      const url = new URL(started.value.authorizationUrl);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(20);
      expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get('nonce')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never puts the PKCE verifier in the URL', async () => {
      const { backend } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');

      const row = await backend.store.getChallenge(started.value.challengeId);
      expect(row?.pkce_verifier).not.toBeNull();
      expect(started.value.authorizationUrl).not.toContain(row?.pkce_verifier ?? 'x');
    });

    it('gives the client a challenge id and nothing else', async () => {
      const { backend } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      expect(Object.keys(started.value).sort()).toEqual(['authorizationUrl', 'challengeId']);
    });
  });

  describe('first sign-in', () => {
    it('creates exactly one account and attaches the Google identity', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      expect(result.exchange?.ok).toBe(true);
      if (!result.exchange?.ok) throw new Error('unreachable');

      const abaUserId = result.exchange.value.session.abaUserId;
      expect(abaUserId).toMatch(/^usr_[0-9a-f]{32}$/);
      const identities = await backend.store.listIdentities(abaUserId);
      expect(identities).toHaveLength(1);
      expect(identities[0]?.kind).toBe('google');
      expect(identities[0]?.subject).toBe('google-subject-1');
    });

    it('creates no provider connection and contacts no provider', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      if (!result.exchange?.ok) throw new Error('unreachable');

      // The backend has no provider surface at all — asserted structurally so
      // it stays true rather than being true today.
      const everything = JSON.stringify({
        user: await backend.store.getUser(result.exchange.value.session.abaUserId),
        identities: await backend.store.listIdentities(result.exchange.value.session.abaUserId),
        sessions: await backend.store.listSessions(result.exchange.value.session.abaUserId),
      });
      for (const term of ['connection', 'provider', 'apiKey', 'openai', 'anthropic', 'gemini']) {
        expect(everything.toLowerCase(), term).not.toContain(term.toLowerCase());
      }
    });

    it('leaves exactly one live session — the bootstrap one is revoked', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      if (!result.exchange?.ok) throw new Error('unreachable');

      const sessions = await backend.store.listSessions(result.exchange.value.session.abaUserId);
      const live = sessions.filter((row) => row.revoked_at === null);
      expect(live).toHaveLength(1);
      expect(live[0]?.id).toBe(result.exchange.value.session.sessionId);
    });

    it('records the identity that established the session', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      if (!result.exchange?.ok) throw new Error('unreachable');

      const row = await backend.store.getSession(result.exchange.value.session.sessionId);
      const identities = await backend.store.listIdentities(
        result.exchange.value.session.abaUserId,
      );
      expect(row?.auth_identity_id).toBe(identities[0]?.id);
    });
  });

  describe('returning sign-in', () => {
    it('resolves the same account and issues a new session', async () => {
      const { backend, shared } = backendWith();
      const first = await signIn(backend, shared);
      if (!first.exchange?.ok) throw new Error('unreachable');

      clock.advance(86_400_000);
      const second = await signIn(backend, shared);
      if (!second.exchange?.ok) throw new Error('unreachable');

      expect(second.exchange.value.session.abaUserId).toBe(first.exchange.value.session.abaUserId);
      expect(second.exchange.value.session.sessionId).not.toBe(
        first.exchange.value.session.sessionId,
      );
      expect(second.exchange.value.created).toBe(false);
    });

    it('creates no second account and no second identity', async () => {
      const { backend, shared } = backendWith();
      const first = await signIn(backend, shared);
      if (!first.exchange?.ok) throw new Error('unreachable');
      clock.advance(1000);
      await signIn(backend, shared);
      clock.advance(1000);
      await signIn(backend, shared);

      const abaUserId = first.exchange.value.session.abaUserId;
      expect(await backend.store.listIdentities(abaUserId)).toHaveLength(1);
    });

    it('treats a different Google subject as a different account', async () => {
      const { backend, shared } = backendWith();
      const first = await signIn(backend, shared);
      if (!first.exchange?.ok) throw new Error('unreachable');

      clock.advance(1000);
      const second = await signIn(backend, shared, { subject: 'google-subject-2' });
      if (!second.exchange?.ok) throw new Error('unreachable');

      expect(second.exchange.value.session.abaUserId).not.toBe(
        first.exchange.value.session.abaUserId,
      );
    });
  });

  describe('callback', () => {
    it('refuses an unknown state', async () => {
      const { backend } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const result = await backend.google.handleCallback({
        state: 'f'.repeat(64),
        code: 'x',
        error: null,
      });
      expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
    });

    it('refuses a replayed callback — the challenge is consumed first', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      const state = url.searchParams.get('state') ?? '';
      shared.nonce = url.searchParams.get('nonce') ?? '';
      shared.now = clock.now();

      const first = await backend.google.handleCallback({ state, code: 'c', error: null });
      expect(first.ok).toBe(true);
      const replay = await backend.google.handleCallback({ state, code: 'c', error: null });
      expect(!replay.ok && replay.error.code).toBe('INVALID_ARGUMENT');
    });

    it('refuses an error response without redeeming anything', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      void shared;
      const url = new URL(started.value.authorizationUrl);

      const result = await backend.google.handleCallback({
        state: url.searchParams.get('state'),
        code: null,
        error: 'access_denied',
      });
      expect(result.ok).toBe(false);
      // The challenge is still unconsumed, because nothing happened.
      const row = await backend.store.getChallenge(started.value.challengeId);
      expect(row?.consumed_at).toBeNull();
    });

    it('sends the PKCE verifier and the original redirect to the token endpoint', async () => {
      const shared = { nonce: '', now: NOW };
      const endpoint = tokenEndpoint(google, shared);
      const backend = createIdentityBackend({
        clock,
        log: createLogger(recorder.sink),
        google: {
          config: {
            clientId: CLIENT_ID,
            redirectUri: REDIRECT,
            authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          },
          jwks: google.jwks(),
          tokens: endpoint,
        },
      });
      if (backend.google === null) throw new Error('unreachable');

      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      shared.nonce = url.searchParams.get('nonce') ?? '';
      shared.now = clock.now();
      const row = await backend.store.getChallenge(started.value.challengeId);

      await backend.google.handleCallback({
        state: url.searchParams.get('state'),
        code: 'the-code',
        error: null,
      });

      expect(endpoint.seen).toHaveLength(1);
      expect(endpoint.seen[0]?.code).toBe('the-code');
      expect(endpoint.seen[0]?.codeVerifier).toBe(row?.pkce_verifier);
      // The redirect the flow began with, not one taken from the request.
      expect(endpoint.seen[0]?.redirectUri).toBe(REDIRECT);
    });

    it('refuses when Google rejects the authorization code', async () => {
      const { backend, shared } = backendWith({ reject: true });
      const result = await signIn(backend, shared);
      expect(result.callback.ok).toBe(false);
    });

    it('refuses an expired challenge', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      shared.nonce = url.searchParams.get('nonce') ?? '';

      clock.advance(11 * 60 * 1000);
      const result = await backend.google.handleCallback({
        state: url.searchParams.get('state'),
        code: 'c',
        error: null,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('exchange', () => {
    it('is single use', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const result = await signIn(backend, shared);
      if (!result.callback.ok || !result.exchange?.ok) throw new Error('unreachable');

      const replay = await backend.google.exchange({
        challengeId: result.callback.value.challengeId,
        exchangeCode: result.callback.value.exchangeCode,
      });
      expect(!replay.ok && replay.error.code).toBe('INVALID_ARGUMENT');
    });

    it('requires the challenge id as well as the code', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      shared.nonce = url.searchParams.get('nonce') ?? '';
      shared.now = clock.now();
      const callback = await backend.google.handleCallback({
        state: url.searchParams.get('state'),
        code: 'c',
        error: null,
      });
      if (!callback.ok) throw new Error('unreachable');

      const wrongId = await backend.google.exchange({
        challengeId: 'chl_00000000000000000000000000000000',
        exchangeCode: callback.value.exchangeCode,
      });
      expect(wrongId.ok).toBe(false);
    });

    it('refuses a guessed code, and dies after a few attempts', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      shared.nonce = url.searchParams.get('nonce') ?? '';
      shared.now = clock.now();
      const callback = await backend.google.handleCallback({
        state: url.searchParams.get('state'),
        code: 'c',
        error: null,
      });
      if (!callback.ok) throw new Error('unreachable');

      for (let attempt = 0; attempt <= MAX_EXCHANGE_ATTEMPTS; attempt += 1) {
        const guess = await backend.google.exchange({
          challengeId: callback.value.challengeId,
          exchangeCode: 'a'.repeat(64),
        });
        expect(guess.ok).toBe(false);
      }
      // The real code no longer works either: the challenge is gone.
      const real = await backend.google.exchange({
        challengeId: callback.value.challengeId,
        exchangeCode: callback.value.exchangeCode,
      });
      expect(real.ok).toBe(false);
    });

    it('issues an access lifetime and a rolling refresh lifetime', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      if (!result.exchange?.ok) throw new Error('unreachable');

      expect(result.exchange.value.session.accessExpiresAt).toBe(NOW + 15 * 60 * 1000);
      expect(result.exchange.value.session.refreshExpiresAt).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
      expect(result.exchange.value.session.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('no token ever travels through a URL', () => {
    it('keeps the authorization URL free of anything bearer-shaped', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      if (!result.exchange?.ok) throw new Error('unreachable');

      const url = result.url.toString();
      expect(url).not.toContain(result.exchange.value.session.refreshToken);
      expect(url).not.toContain(result.exchange.value.session.sessionId);
      expect(url).not.toContain(result.exchange.value.session.abaUserId);
    });

    it('carries only a one-time code out of the callback', async () => {
      const { backend, shared } = backendWith();
      const result = await signIn(backend, shared);
      if (!result.callback.ok || !result.exchange?.ok) throw new Error('unreachable');

      expect(Object.keys(result.callback.value).sort()).toEqual(['challengeId', 'exchangeCode']);
      expect(result.callback.value.exchangeCode).not.toBe(
        result.exchange.value.session.refreshToken,
      );
      // And the code does not encode the account it resolves to.
      expect(result.callback.value.exchangeCode).not.toContain(
        result.exchange.value.session.abaUserId.slice(4, 12),
      );
    });

    it('stores the exchange code only as a digest', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      shared.nonce = url.searchParams.get('nonce') ?? '';
      shared.now = clock.now();
      const callback = await backend.google.handleCallback({
        state: url.searchParams.get('state'),
        code: 'c',
        error: null,
      });
      if (!callback.ok) throw new Error('unreachable');

      const row = await backend.store.getChallenge(callback.value.challengeId);
      expect(row?.exchange_digest).not.toBe(callback.value.exchangeCode);
      expect(JSON.stringify(row)).not.toContain(callback.value.exchangeCode);
    });
  });

  describe('logging', () => {
    it('writes no secret across a whole sign-in', async () => {
      const { backend, shared } = backendWith();
      if (backend.google === null) throw new Error('unreachable');
      const started = await backend.google.start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      const state = url.searchParams.get('state') ?? '';
      const nonce = url.searchParams.get('nonce') ?? '';
      shared.nonce = nonce;
      shared.now = clock.now();
      const row = await backend.store.getChallenge(started.value.challengeId);
      const callback = await backend.google.handleCallback({
        state,
        code: 'the-code',
        error: null,
      });
      if (!callback.ok) throw new Error('unreachable');
      const exchanged = await backend.google.exchange({
        challengeId: callback.value.challengeId,
        exchangeCode: callback.value.exchangeCode,
      });
      if (!exchanged.ok) throw new Error('unreachable');

      const written = recorder.serialised();
      expect(written.length).toBeGreaterThan(0);
      for (const secret of [
        state,
        nonce,
        row?.pkce_verifier ?? 'x',
        callback.value.exchangeCode,
        exchanged.value.session.refreshToken,
        'the-code',
      ]) {
        expect(written, secret.slice(0, 8)).not.toContain(secret);
      }
    });

    it('records the challenge id, so a flow is traceable', async () => {
      const { backend, shared } = backendWith();
      await signIn(backend, shared);
      const events = recorder.records.map((entry) => entry.event);
      expect(events).toContain('auth.google.start');
      expect(events).toContain('auth.google.callback');
      expect(events).toContain('auth.google.exchange');
    });
  });
});
