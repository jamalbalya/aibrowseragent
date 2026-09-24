/**
 * TEST-SECURITY-043 — the extension's half of Google sign-in.
 *
 * Drives `GoogleSignIn` and `AuthController` against a stub backend and a
 * stub tab-watcher, so the client protocol is exercised without a server and
 * without a browser. What is being tested is what the extension does with
 * what it receives — including the cases where what it receives is hostile.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import { SessionStore } from '@/identity/session-store';
import { IdentityProfileStore } from '@/identity/identity-profile';
import { AuthController } from '@/identity/auth-controller';
import { GoogleSignIn, CALLBACK_PATH } from '@/identity/google-sign-in';
import { IdentityTransport } from '@/identity/identity-transport';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';

const ORIGIN = 'https://api.example.test';
const NOW = 1_800_000_000_000;

/**
 * The URL of a fetch call, without stringifying a `Request`.
 *
 * `String(input)` looks harmless and yields `[object Request]` for the one
 * case that matters, so the union is narrowed rather than coerced.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * A backend that answers start and exchange.
 *
 * Installed over `globalThis.fetch`, because `IdentityTransport` supplies no
 * transport implementation of its own — by design, so that it names no
 * network primitive and the three-holder invariant stays three. A test may
 * replace the global; the module may not.
 */
function backend(overrides: {
  start?: unknown;
  startStatus?: number;
  exchange?: unknown;
  exchangeStatus?: number;
}): { seen: string[] } {
  const seen: string[] = [];
  const stub: typeof fetch = (input) => {
    const url = urlOf(input);
    seen.push(url);
    const isStart = url.endsWith('/v1/auth/start');
    const body = isStart
      ? (overrides.start ?? {
          challengeId: 'chl_1',
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
        })
      : (overrides.exchange ?? {
          abaUserId: 'usr_11111111111111111111111111111111',
          accessToken: 'access-token-value',
          accessExpiresAt: NOW + 900_000,
          refreshToken: 'refresh-token-value',
          refreshExpiresAt: NOW + 2_592_000_000,
          email: 'person@example.com',
        });
    const status = isStart ? (overrides.startStatus ?? 200) : (overrides.exchangeStatus ?? 200);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  globalThis.fetch = stub;
  return { seen };
}

/** A tab watcher that returns whatever the test says the redirect was. */
function authFlow(outcome: AuthFlowOutcome): AuthFlowPort & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    run(request) {
      opened.push(request.authorizationUrl);
      return Promise.resolve(outcome);
    },
  };
}

function callbackUrl(challenge = 'chl_1', code = 'exchange-code-value'): string {
  return `${ORIGIN}${CALLBACK_PATH}?challenge=${challenge}&code=${code}`;
}

describe('GoogleSignIn', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const signInWith = (flow: ReturnType<typeof authFlow>): GoogleSignIn =>
    new GoogleSignIn({
      config: { backendOrigin: ORIGIN },
      transport: new IdentityTransport({ backendOrigin: ORIGIN }),
      authFlow: flow,
    });

  it('completes and returns a session', async () => {
    backend({});
    const flow = authFlow({ kind: 'callback', url: callbackUrl() });

    const result = await signInWith(flow).signIn(new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.abaUserId).toBe('usr_11111111111111111111111111111111');
    expect(result.refreshToken).toBe('refresh-token-value');
    expect(flow.opened[0]).toContain('accounts.google.com');
  });

  it('refuses an authorization URL that is not https', async () => {
    backend({ start: { challengeId: 'chl_1', authorizationUrl: 'javascript:alert(1)' } });
    const result = await signInWith(authFlow({ kind: 'callback', url: callbackUrl() })).signIn(
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('START_FAILED');
  });

  it('refuses a callback whose challenge is not the one it started', async () => {
    backend({});
    const result = await signInWith(
      authFlow({ kind: 'callback', url: callbackUrl('chl_somebody_else') }),
    ).signIn(new AbortController().signal);
    expect(!result.ok && result.failure).toBe('CALLBACK_INVALID');
  });

  it('refuses a callback from another origin', async () => {
    backend({});
    const result = await signInWith(
      authFlow({
        kind: 'callback',
        url: `https://attacker.test${CALLBACK_PATH}?challenge=chl_1&code=x`,
      }),
    ).signIn(new AbortController().signal);
    expect(!result.ok && result.failure).toBe('CALLBACK_INVALID');
  });

  it('reports a cancelled flow as cancelled, not as an error', async () => {
    backend({});
    const result = await signInWith(
      authFlow({ kind: 'cancelled', reason: 'the tab was closed' }),
    ).signIn(new AbortController().signal);
    expect(!result.ok && result.failure).toBe('CANCELLED');
  });

  it('refuses an exchange response missing any required field', async () => {
    for (const partial of [
      { accessToken: 'a', refreshToken: 'r', accessExpiresAt: 1, refreshExpiresAt: 2 },
      { abaUserId: 'u', refreshToken: 'r', accessExpiresAt: 1, refreshExpiresAt: 2 },
      { abaUserId: 'u', accessToken: 'a', accessExpiresAt: 1, refreshExpiresAt: 2 },
      {},
    ]) {
      backend({ exchange: partial });
      const result = await signInWith(authFlow({ kind: 'callback', url: callbackUrl() })).signIn(
        new AbortController().signal,
      );
      expect(!result.ok && result.failure).toBe('EXCHANGE_FAILED');
    }
  });

  it('never sends the exchange code anywhere but the exchange endpoint', async () => {
    const recorder = backend({});
    await signInWith(authFlow({ kind: 'callback', url: callbackUrl() })).signIn(
      new AbortController().signal,
    );

    expect(recorder.seen).toEqual([`${ORIGIN}/v1/auth/start`, `${ORIGIN}/v1/auth/exchange`]);
    for (const url of recorder.seen) expect(url).not.toContain('exchange-code-value');
  });
});

describe('AuthController', () => {
  const original = globalThis.fetch;
  let sessions: SessionStore;
  let profile: IdentityProfileStore;

  beforeEach(() => {
    sessions = new SessionStore(new MemoryStorageArea(), new MemoryStorageArea());
    profile = new IdentityProfileStore(new MemoryStorageArea());
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  function controller(flowUrl = callbackUrl()): AuthController {
    return new AuthController({
      sessions,
      profile,
      session: null,
      email: null,
      identities: null,
      google: new GoogleSignIn({
        config: { backendOrigin: ORIGIN },
        transport: new IdentityTransport({ backendOrigin: ORIGIN }),
        authFlow: authFlow({ kind: 'callback', url: flowUrl }),
      }),
      now: () => NOW,
    });
  }

  it('reports signed out before anyone signs in', async () => {
    backend({});
    const status = await controller().status();
    expect(status).toEqual({
      configured: true,
      state: 'signed_out',
      abaUserId: null,
      email: null,
    });
  });

  it('reports not configured when there is no backend origin', async () => {
    const status = await new AuthController({
      sessions,
      profile,
      google: null,
      session: null,
      email: null,
      identities: null,
      now: () => NOW,
    }).status();
    expect(status.configured).toBe(false);
    expect(status.state).toBe('signed_out');
  });

  it('stores the session and the profile on success', async () => {
    backend({});
    const result = await controller().signInWithGoogle(new AbortController().signal);
    expect(result.ok).toBe(true);

    const stored = await sessions.read();
    expect(stored?.abaUserId).toBe('usr_11111111111111111111111111111111');
    expect(stored?.refreshToken).toBe('refresh-token-value');
    expect((await sessions.readAccess())?.token).toBe('access-token-value');
    expect((await profile.get())?.abaUserId).toBe('usr_11111111111111111111111111111111');
  });

  it('reports signed in afterwards, with the address and no token', async () => {
    backend({});
    await controller().signInWithGoogle(new AbortController().signal);
    const status = await controller().status();

    expect(status.state).toBe('signed_in');
    expect(status.email).toBe('person@example.com');
    // The status carries an id and an address. Nothing else has a field.
    expect(Object.keys(status).sort()).toEqual(['abaUserId', 'configured', 'email', 'state']);
    expect(JSON.stringify(status)).not.toContain('refresh-token-value');
    expect(JSON.stringify(status)).not.toContain('access-token-value');
  });

  it('refuses a second, different user and stores no session for them', async () => {
    backend({});
    await controller().signInWithGoogle(new AbortController().signal);

    backend({
      exchange: {
        abaUserId: 'usr_22222222222222222222222222222222',
        accessToken: 'other-access',
        accessExpiresAt: NOW + 900_000,
        refreshToken: 'other-refresh',
        refreshExpiresAt: NOW + 2_592_000_000,
        email: 'someone@example.com',
      },
    });
    const result = await controller().signInWithGoogle(new AbortController().signal);

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('DIFFERENT_USER');
    // The first user's session survives, and the second's was never written.
    expect((await sessions.read())?.abaUserId).toBe('usr_11111111111111111111111111111111');
    expect((await sessions.read())?.refreshToken).toBe('refresh-token-value');
  });

  it('returns to the same account on a second sign-in', async () => {
    backend({});
    const first = await controller().signInWithGoogle(new AbortController().signal);
    const second = await controller().signInWithGoogle(new AbortController().signal);
    expect(second.abaUserId).toBe(first.abaUserId);
    expect((await profile.get())?.authMethods).toEqual(['google']);
  });

  it('signs out without touching the identity profile', async () => {
    backend({});
    await controller().signInWithGoogle(new AbortController().signal);
    const before = await profile.get();

    await controller().signOut();

    expect(await sessions.read()).toBeNull();
    expect(await sessions.readAccess()).toBeNull();
    // The profile survives, so the sign-in screen can say who you were.
    expect(await profile.get()).toEqual(before);
    expect((await controller().status()).abaUserId).toBe(before?.abaUserId);
  });

  it('reports a safe failure code that says nothing about accounts', async () => {
    backend({ exchangeStatus: 401 });
    const result = await controller().signInWithGoogle(new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('EXCHANGE_FAILED');
    expect(result.abaUserId).toBeNull();
    expect(result.email).toBeNull();
  });
});
