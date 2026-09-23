/**
 * TEST-SECURITY-053 — a refresh rotates a chain and populates nothing.
 *
 * The final report for the session lifecycle phase named this as the one
 * target in its mutation list that was covered structurally rather than
 * directly: "refresh creating a new ABA account" rested on the route having
 * no parameter for an account and `rotateSession` copying `aba_user_id` from
 * the row it rotated. Both are true, and neither is a measurement — they are
 * readings of the source, and a reading cannot fail when the source changes
 * under it.
 *
 * What makes these cases different is where they look. A refresh that quietly
 * created a second account would still return the caller's own `abaUserId`,
 * because it would hand back the session it just minted; every assertion that
 * inspects the *response* would pass. So these inspect the **store**, through
 * a census that counts rows at the port they must pass through to exist.
 *
 * Not a mutation suite and not an executable mutant: this is an ordinary
 * behavioural regression test, and it is described as one.
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
import {
  censusStore,
  creationSurface,
  CREATING_METHODS,
  type CensusStore,
} from '../fixtures/census-store';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://api.example.test';
const KEY = 'k'.repeat(64);
const DEVICE = 'dev_11111111-2222-3333-4444-555555555555';

describe('a refresh creates no account, identity or device', () => {
  let clock: FixedClock;
  let census: CensusStore;
  let backend: IdentityBackend;
  let router: AuthRouter;
  let issuer: AccessTokenIssuer;

  beforeEach(async () => {
    clock = new FixedClock(NOW);
    census = censusStore();
    issuer = await createAccessTokenIssuer(KEY);
    const recorder = new RecordingLogSink();
    backend = createIdentityBackend({
      store: census.store,
      clock,
      log: createLogger(recorder.sink),
    });
    router = createAuthRouter({ backend, log: createLogger(recorder.sink), accessTokens: issuer });
  });

  /**
   * Account A, its Google identity, its device and a live session.
   *
   * Built through the services rather than by inserting rows, so the census
   * counts what a real sign-in would have produced.
   */
  async function accountA(): Promise<{
    abaUserId: string;
    authIdentityId: string;
    sessionId: string;
    refreshToken: string;
  }> {
    const user = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: user.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');

    const principal = await backend.sessions.verify(issued.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');

    const identity = await backend.identities.attachIdentity(principal.value, {
      kind: 'google',
      subject: 'google-subject-a',
      email: 'a@example.test',
      emailVerified: true,
    });
    if (!identity.ok) throw new Error('unreachable');

    const device = await backend.devices.registerDevice(principal.value, DEVICE);
    if (!device.ok) throw new Error('unreachable');

    return {
      abaUserId: user.id,
      authIdentityId: identity.value.id,
      sessionId: issued.value.sessionId,
      refreshToken: issued.value.refreshToken,
    };
  }

  it('01 — the census is total: the store creates no row kind it does not count', () => {
    // If a sixth `insert*` lands on the port, the cases below would keep
    // reporting zero for it while saying "nothing was created". This is the
    // assertion that turns that silent under-count into a failure.
    expect(creationSurface()).toEqual([...CREATING_METHODS]);
  });

  it('02 — a service-level refresh leaves account, identity and device counts unchanged', async () => {
    const a = await accountA();
    const before = census.census();
    expect(before).toEqual({ accounts: 1, identities: 1, devices: 1 });

    const rotated = await backend.sessions.rotateSession(a.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error('unreachable');

    // The population is byte-for-byte what it was. Nothing was added beside
    // the caller's account, which is the half a response-shaped assertion
    // cannot see.
    expect(census.census()).toEqual(before);
    expect(census.accountIds()).toEqual([a.abaUserId]);
    expect(census.identityIds()).toEqual([a.authIdentityId]);
  });

  it('03 — the account identity itself is unchanged, not merely the count', async () => {
    const a = await accountA();

    const rotated = await backend.sessions.rotateSession(a.refreshToken);
    if (!rotated.ok) throw new Error('unreachable');

    // Same account on the successor, and the identity row is the same row —
    // not a replacement carrying the same address.
    expect(rotated.value.abaUserId).toBe(a.abaUserId);
    const identities = await backend.store.listIdentities(a.abaUserId);
    expect(identities.map((row) => row.id)).toEqual([a.authIdentityId]);
    expect(identities[0]?.subject).toBe('google-subject-a');

    const devices = await backend.store.listDevices(a.abaUserId);
    expect(devices.map((row) => row.device_id)).toEqual([DEVICE]);
  });

  it('04 — the successor is valid and belongs to the original account', async () => {
    const a = await accountA();

    const rotated = await backend.sessions.rotateSession(a.refreshToken);
    if (!rotated.ok) throw new Error('unreachable');

    const principal = await backend.sessions.verify(rotated.value.sessionId);
    expect(principal.ok).toBe(true);
    if (!principal.ok) throw new Error('unreachable');
    expect(principal.value.abaUserId).toBe(a.abaUserId);
    // A successor, not the row that was rotated away.
    expect(rotated.value.sessionId).not.toBe(a.sessionId);
  });

  it('05 — the predecessor refresh token is no longer usable', async () => {
    const a = await accountA();
    await backend.sessions.rotateSession(a.refreshToken);

    const again = await backend.sessions.rotateSession(a.refreshToken);

    // Single use, and presenting it a second time is reuse rather than a
    // quiet refusal — which also revokes the successor minted above.
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.error.code).toBe('SESSION_REVOKED');
    // And still no account was created by any of it.
    expect(census.census()).toEqual({ accounts: 1, identities: 1, devices: 1 });
  });

  it('06 — a refresh over HTTP with a hostile body creates nothing', async () => {
    const a = await accountA();
    const before = census.census();

    // Case 03 of `server-session-http` already proves none of these is read
    // as authority. What it does not look at, and this does, is whether any
    // of them can cause a row to be created — an account named by an
    // `abaUserId` the store has never seen, an identity from a `sub` and an
    // `email`, a device from a `deviceId`.
    const response = await router(
      new Request(`${ORIGIN}${DEFAULT_PATHS.refreshPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          refreshToken: a.refreshToken,
          abaUserId: 'usr_ffffffffffffffffffffffffffffffff',
          sub: 'google-subject-attacker',
          email: 'attacker@example.test',
          emailVerified: true,
          deviceId: 'dev_99999999-9999-9999-9999-999999999999',
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { abaUserId: string };
    expect(body.abaUserId).toBe(a.abaUserId);

    expect(census.census()).toEqual(before);
    expect(census.accountIds()).toEqual([a.abaUserId]);
    expect(census.identityIds()).toEqual([a.authIdentityId]);
    // No second account exists, under the id the body tried to name or any
    // other: the census holds exactly one and it is the caller's.
    expect(await backend.store.getUser('usr_ffffffffffffffffffffffffffffffff')).toBeNull();
    expect(
      await backend.store.getDevice(a.abaUserId, 'dev_99999999-9999-9999-9999-999999999999'),
    ).toBeNull();
  });

  it('07 — repeated refreshes along one chain still populate nothing', async () => {
    const a = await accountA();
    let token = a.refreshToken;

    for (let index = 0; index < 5; index += 1) {
      const rotated = await backend.sessions.rotateSession(token);
      if (!rotated.ok) throw new Error('unreachable');
      expect(rotated.value.abaUserId).toBe(a.abaUserId);
      token = rotated.value.refreshToken;
    }

    // Five rotations, one account. A leak that created an account per
    // refresh would be invisible to any single-refresh assertion.
    expect(census.census()).toEqual({ accounts: 1, identities: 1, devices: 1 });
  });
});
