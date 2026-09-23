/**
 * TEST-SECURITY-052 — the client half of the session lifecycle.
 *
 * The single-flight property is the reason this file exists, and it is worth
 * saying why it is a *security* test rather than a performance one.
 *
 * The server enforces that a refresh token is single-use, atomically: two
 * concurrent presentations produce at most one successor and the loser is
 * treated as reuse, which revokes the whole family. That is correct — and it
 * means a client that fires two refreshes at once signs its own user out. An
 * MV3 extension is exactly where that happens: the panel, a running task and
 * a scheduled check can all notice a stale access token in the same
 * millisecond.
 *
 * So the client must collapse the concurrency before the request. These cases
 * assert that N callers produce one request and one successor, and that every
 * caller sees the same state afterwards.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import { SessionStore } from '@/identity/session-store';
import { SessionClient } from '@/identity/session-client';
import { IDENTITY_PATHS } from '@/identity/identity-config';
import type { IdentityRequest, IdentityResponse } from '@/identity/identity-transport';

const NOW = 1_800_000_000_000;

/** A transport that records what was sent and answers from a script. */
function transport(
  reply: (request: IdentityRequest, call: number) => IdentityResponse | Promise<IdentityResponse>,
): { send: (r: IdentityRequest) => Promise<IdentityResponse>; seen: IdentityRequest[] } {
  const seen: IdentityRequest[] = [];
  return {
    seen,
    async send(request: IdentityRequest): Promise<IdentityResponse> {
      seen.push(request);
      return reply(request, seen.length);
    },
  };
}

/** A successful refresh body, with a distinct successor token per call. */
const rotated = (call: number): IdentityResponse => ({
  status: 200,
  body: {
    abaUserId: 'usr_11111111111111111111111111111111',
    accessToken: `access-${call}`,
    accessExpiresAt: NOW + 900_000,
    refreshToken: `refresh-${call}`,
    refreshExpiresAt: NOW + 2_592_000_000,
  },
});

describe('client refresh', () => {
  let sessions: SessionStore;

  beforeEach(async () => {
    sessions = new SessionStore(new MemoryStorageArea(), new MemoryStorageArea());
    await sessions.write({
      abaUserId: 'usr_11111111111111111111111111111111',
      refreshToken: 'refresh-0',
      refreshExpiresAt: NOW + 2_592_000_000,
      lastContactAt: NOW,
    });
  });

  const clientWith = (
    reply: Parameters<typeof transport>[0],
  ): { client: SessionClient; seen: IdentityRequest[] } => {
    const port = transport(reply);
    return {
      seen: port.seen,
      client: new SessionClient({
        transport: port as unknown as ConstructorParameters<typeof SessionClient>[0]['transport'],
        sessions,
        now: () => NOW,
      }),
    };
  };

  it('01 — two concurrent callers produce one request and one successor', async () => {
    const { client, seen } = clientWith((_, call) => rotated(call));

    const [a, b] = await Promise.all([client.refresh(), client.refresh()]);

    // One request. Two would have spent the token twice and, on a server that
    // enforces single use, revoked the family.
    expect(seen).toHaveLength(1);
    expect(a).toEqual(b);
    expect((await sessions.read())?.refreshToken).toBe('refresh-1');
  });

  it('02 — many concurrent callers still produce one request', async () => {
    const { client, seen } = clientWith((_, call) => rotated(call));

    const results = await Promise.all(Array.from({ length: 16 }, () => client.refresh()));

    expect(seen).toHaveLength(1);
    // Every caller sees the same authenticated state, not sixteen answers.
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it('03 — a later refresh starts a new flight rather than reusing the old answer', async () => {
    const { client, seen } = clientWith((_, call) => rotated(call));

    await client.refresh();
    await client.refresh();

    // The in-flight promise is cleared when it settles, so the second call is
    // a real refresh and stores the second successor.
    expect(seen).toHaveLength(2);
    expect(seen[1]?.body.refreshToken).toBe('refresh-1');
    expect((await sessions.read())?.refreshToken).toBe('refresh-2');
  });

  it('04 — the successor replaces the predecessor atomically for later readers', async () => {
    const { client } = clientWith((_, call) => rotated(call));

    await client.refresh();

    const stored = await sessions.read();
    const access = await sessions.readAccess();
    expect(stored?.refreshToken).toBe('refresh-1');
    expect(access?.token).toBe('access-1');
    // The spent token is gone: refreshing with it again would be a reuse
    // signal, which is the one outcome worth never storing.
    expect(stored?.refreshToken).not.toBe('refresh-0');
  });

  it('05 — the request carries the token and nothing else', async () => {
    const { client, seen } = clientWith((_, call) => rotated(call));

    await client.refresh();

    expect(seen[0]?.path).toBe(IDENTITY_PATHS.refresh);
    // No account id, no device id, no email — nothing that could be offered
    // as authority, and nothing for the server to be tempted to read.
    expect(Object.keys(seen[0]?.body ?? {})).toEqual(['refreshToken']);
    expect(seen[0]?.bearer).toBeUndefined();
  });

  it('06 — a 401 clears the session and reports revocation', async () => {
    const { client } = clientWith(() => ({ status: 401, body: { error: 'invalid_request' } }));

    const result = await client.refresh();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('REVOKED');
    expect(await sessions.read()).toBeNull();
  });

  it('07 — an outage does not sign anybody out', async () => {
    const { client } = clientWith(() => {
      throw new Error('the network is down');
    });

    const result = await client.refresh();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure).toBe('UNREACHABLE');
    // The session is not dead, it is unreachable. Clearing it here would sign
    // a user out over a flaky connection.
    expect((await sessions.read())?.refreshToken).toBe('refresh-0');
  });

  it('08 — a 500 is an outage, not a revocation', async () => {
    const { client } = clientWith(() => ({ status: 500, body: {} }));

    const result = await client.refresh();

    expect(result.ok === false && result.failure).toBe('UNREACHABLE');
    expect((await sessions.read())?.refreshToken).toBe('refresh-0');
  });

  it('09 — concurrent callers all see the same failure', async () => {
    const { client, seen } = clientWith(() => ({ status: 401, body: {} }));

    const results = await Promise.all([client.refresh(), client.refresh(), client.refresh()]);

    expect(seen).toHaveLength(1);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await sessions.read()).toBeNull();
  });

  it('10 — a response naming another account is discarded, not adopted', async () => {
    const { client } = clientWith(() => ({
      status: 200,
      body: {
        abaUserId: 'usr_ffffffffffffffffffffffffffffffff',
        accessToken: 'a',
        accessExpiresAt: NOW + 900_000,
        refreshToken: 'r',
        refreshExpiresAt: NOW + 2_592_000_000,
      },
    }));

    const result = await client.refresh();

    // A refresh must not move this installation to a different account.
    expect(result.ok).toBe(false);
    expect((await sessions.read())?.abaUserId).toBe('usr_11111111111111111111111111111111');
  });

  it('11 — a malformed success body is treated as an outage, not a session', async () => {
    for (const body of [{}, { abaUserId: 'u' }, { accessToken: 'a', refreshToken: 'r' }]) {
      const { client } = clientWith(() => ({ status: 200, body }));
      const result = await client.refresh();
      expect(result.ok).toBe(false);
      // Nothing half-written: the stored session is still the original.
      expect((await sessions.read())?.refreshToken).toBe('refresh-0');
    }
  });

  it('12 — refreshing with no stored session is a refusal, not a request', async () => {
    await sessions.clear();
    const { client, seen } = clientWith((_, call) => rotated(call));

    const result = await client.refresh();

    expect(result.ok === false && result.failure).toBe('NO_SESSION');
    expect(seen).toHaveLength(0);
  });
});

describe('client logout', () => {
  let sessions: SessionStore;

  beforeEach(async () => {
    sessions = new SessionStore(new MemoryStorageArea(), new MemoryStorageArea());
    await sessions.write({
      abaUserId: 'usr_11111111111111111111111111111111',
      refreshToken: 'refresh-0',
      refreshExpiresAt: NOW + 2_592_000_000,
      lastContactAt: NOW,
    });
    await sessions.writeAccess({ token: 'access-0', expiresAt: NOW + 900_000 });
  });

  const clientWith = (
    reply: Parameters<typeof transport>[0],
  ): { client: SessionClient; seen: IdentityRequest[] } => {
    const port = transport(reply);
    return {
      seen: port.seen,
      client: new SessionClient({
        transport: port as unknown as ConstructorParameters<typeof SessionClient>[0]['transport'],
        sessions,
        now: () => NOW,
      }),
    };
  };

  it('13 — logout presents the access token as a bearer, not in the body', async () => {
    const { client, seen } = clientWith(() => ({ status: 200, body: { ok: true } }));

    await client.logout();

    expect(seen[0]?.path).toBe(IDENTITY_PATHS.logout);
    expect(seen[0]?.bearer).toBe('access-0');
    // A credential in a body reaches request logs and anything recording one.
    expect(Object.keys(seen[0]?.body ?? {})).toEqual([]);
  });

  it('14 — logout clears both halves of the session', async () => {
    const { client } = clientWith(() => ({ status: 200, body: { ok: true } }));

    const result = await client.logout();

    expect(result.serverRevoked).toBe(true);
    expect(await sessions.read()).toBeNull();
    expect(await sessions.readAccess()).toBeNull();
  });

  it('15 — a user who pressed sign out is signed out even when the backend is down', async () => {
    const { client } = clientWith(() => {
      throw new Error('unreachable');
    });

    const result = await client.logout();

    // The server session lapses on its own, and the refresh token that could
    // have extended it has been discarded here.
    expect(result.serverRevoked).toBe(false);
    expect(await sessions.read()).toBeNull();
  });

  it('16 — a refused logout still clears locally', async () => {
    const { client } = clientWith(() => ({ status: 401, body: {} }));

    const result = await client.logout();

    expect(result.serverRevoked).toBe(false);
    expect(await sessions.read()).toBeNull();
  });

  it('17 — logging out with no access token still clears and sends nothing', async () => {
    await sessions.clearAccess();
    const { client, seen } = clientWith(() => ({ status: 200, body: {} }));

    await client.logout();

    expect(seen).toHaveLength(0);
    expect(await sessions.read()).toBeNull();
  });

  it('18 — a refresh in flight when logout lands still ends signed out', async () => {
    let resolveRefresh: (value: IdentityResponse) => void = () => undefined;
    const pending = new Promise<IdentityResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    const { client } = clientWith((request) =>
      request.path === IDENTITY_PATHS.refresh ? pending : { status: 200, body: { ok: true } },
    );

    const refreshing = client.refresh();
    const loggedOut = client.logout();
    // The logout lands first; the refresh answers afterwards.
    await loggedOut;
    resolveRefresh(rotated(1));
    await refreshing;

    // The refresh must not write a session back after the user signed out.
    // Its successor names a server session that logout revoked, so storing it
    // would leave the extension looking signed in with a token that is dead —
    // and the next refresh would present it and trip reuse detection.
    expect(await sessions.read()).toBeNull();
    expect(await sessions.readAccess()).toBeNull();
  });
});
