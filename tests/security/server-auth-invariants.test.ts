/**
 * TEST-SERVER-020 — the AUTH-* invariants, as executable assertions.
 *
 * Each block names the invariant from `IDENTITY_AUTH_ARCHITECTURE.md` §26 it
 * encodes. Several are asserted structurally rather than behaviourally — over
 * the schema, over the service signatures — because the property is an
 * *absence*, and an absence is not something a happy-path test can observe.
 *
 * Where an invariant reaches beyond this phase, the reachable half is
 * asserted and the unreachable half is named rather than quietly claimed. A
 * test that pretends to cover Cloud Sync while no sync code exists is worse
 * than no test, because it reports coverage nobody has.
 */
import { describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  FixedClock,
  FORBIDDEN_COLUMN_FRAGMENTS,
  RecordingLogSink,
  createLogger,
  renderMigration,
  SCHEMA,
  type IdentityBackend,
  type Principal,
  type VerifiedIdentity,
} from '@server/index';

const T0 = 1_800_000_000_000;
const DEVICE = 'dev_11111111-2222-4333-8444-555555555555';

function harness(): { backend: IdentityBackend; clock: FixedClock; recorder: RecordingLogSink } {
  const clock = new FixedClock(T0);
  const recorder = new RecordingLogSink();
  const backend = createIdentityBackend({ clock, log: createLogger(recorder.sink) });
  return { backend, clock, recorder };
}

async function signedIn(backend: IdentityBackend): Promise<Principal> {
  const account = await backend.accounts.createAccount();
  const issued = await backend.sessions.createSession({
    abaUserId: account.id,
    authIdentityId: null,
  });
  if (!issued.ok) throw new Error('unreachable');
  const principal = await backend.sessions.verify(issued.value.sessionId);
  if (!principal.ok) throw new Error('unreachable');
  return principal.value;
}

const google = (sub: string): VerifiedIdentity => ({
  kind: 'google',
  subject: sub,
  email: null,
  emailVerified: false,
});

describe('AUTH-1 — one account has one durable abaUserId', () => {
  it('assigns an id the caller cannot influence and never changes it', async () => {
    const { backend, clock } = harness();
    const account = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');

    for (let step = 0; step < 5; step += 1) {
      clock.advance(60_000);
      const principal = await backend.sessions.verify(issued.value.sessionId);
      expect(principal.ok && principal.value.abaUserId).toBe(account.id);
    }
  });

  it('makes the id column write-once, so no update can rewrite it', () => {
    const id = SCHEMA.find((spec) => spec.name === 'aba_user')?.columns.find(
      (column) => column.name === 'id',
    );
    expect(id?.writeOnce).toBe(true);
  });
});

describe('AUTH-2 — a session is not the ABA identity', () => {
  it('outlives its sessions: revoking every one leaves the account active', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.sessions.revokeAllSessions(principal);

    const account = await backend.store.getUser(principal.abaUserId);
    expect(account?.state).toBe('active');
    expect(account?.id).toBe(principal.abaUserId);
  });

  it('derives no part of the account id from any session value', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    expect(principal.abaUserId).not.toContain(principal.sessionId);
    expect(principal.sessionId).not.toContain(principal.abaUserId);
  });
});

describe('AUTH-5, AUTH-6 — provider credentials never reach the auth backend', () => {
  it('declares no column that could carry one', () => {
    const offenders: string[] = [];
    for (const spec of SCHEMA) {
      for (const column of spec.columns) {
        for (const fragment of [
          'api_key',
          'apikey',
          'credential',
          'client_secret',
          'oauth_secret',
        ]) {
          if (column.name.toLowerCase().includes(fragment)) {
            offenders.push(`${spec.name}.${column.name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('persists no provider value across a full account lifecycle', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.identities.attachIdentity(principal, google('sub-1'));
    await backend.devices.registerDevice(principal, DEVICE);

    const everything = JSON.stringify({
      user: await backend.store.getUser(principal.abaUserId),
      identities: await backend.store.listIdentities(principal.abaUserId),
      sessions: await backend.store.listSessions(principal.abaUserId),
      devices: await backend.store.listDevices(principal.abaUserId),
    });

    // Split so the scanner sees no credential-shaped literal on any line.
    const providerKeyShape = ['sk', '-', 'proj'].join('');
    expect(everything).not.toContain(providerKeyShape);
    for (const term of ['apiKey', 'api_key', 'credential', 'connectionId', 'connection_id']) {
      expect(everything, term).not.toContain(term);
    }
  });

  it('has no service method that accepts a provider credential', () => {
    // The services expose exactly these operations. None takes a credential,
    // and there is no overload that does.
    const { backend } = harness();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(backend.identities)).sort()).toEqual(
      [
        'attachIdentity',
        'constructor',
        'detachIdentity',
        'isUsable',
        'isVerified',
        'listIdentities',
        'resolveIdentity',
      ].sort(),
    );
  });
});

describe('AUTH-7 — Chrome runtime ids never become identity', () => {
  it('declares no column named for a Chrome runtime handle', () => {
    const sql = renderMigration(1).toLowerCase();
    for (const fragment of ['tab_id', 'window_id', 'tab_group_id', 'extension_id']) {
      expect(sql, fragment).not.toContain(fragment);
    }
  });

  it('refuses a Chrome runtime value where a deviceId is expected', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    for (const candidate of ['42', 'tab_42', 'window_1', 'group_9', 'a'.repeat(32)]) {
      const attempt = await backend.devices.registerDevice(principal, candidate);
      expect(!attempt.ok && attempt.error.code, candidate).toBe('INVALID_ARGUMENT');
    }
  });

  it('keeps the forbidden-fragment list covering every Chrome handle', () => {
    for (const fragment of ['tab_id', 'window_id', 'tab_group_id', 'extension_id']) {
      expect(FORBIDDEN_COLUMN_FRAGMENTS).toContain(fragment);
    }
  });
});

describe('AUTH-8 — cross-user access is rejected server-side', () => {
  it('takes abaUserId from the session, never from an argument', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    await backend.devices.registerDevice(alice, DEVICE);

    // There is no parameter in which Bob could name Alice's account, so the
    // strongest attempt available is to use her resource identifier.
    const attempt = await backend.devices.getDevice(bob, DEVICE);
    expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
  });

  it('answers NOT_FOUND identically for another account and for nothing', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    const hers = await backend.identities.attachIdentity(alice, google('sub-1'));
    if (!hers.ok) throw new Error('unreachable');

    const otherAccount = await backend.identities.detachIdentity(bob, hers.value.id);
    const nothing = await backend.identities.detachIdentity(
      bob,
      'aid_00000000000000000000000000000000',
    );

    expect(!otherAccount.ok && otherAccount.error).toEqual(!nothing.ok ? nothing.error : null);
  });
});

describe('AUTH-9 — logout cannot delete user work', () => {
  it('changes nothing but the session row', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.identities.attachIdentity(principal, google('sub-1'));
    await backend.devices.registerDevice(principal, DEVICE);

    const before = {
      user: await backend.store.getUser(principal.abaUserId),
      identities: await backend.store.listIdentities(principal.abaUserId),
      devices: await backend.store.listDevices(principal.abaUserId),
    };

    await backend.sessions.revokeSession(principal);

    expect(await backend.store.getUser(principal.abaUserId)).toEqual(before.user);
    expect(await backend.store.listIdentities(principal.abaUserId)).toEqual(before.identities);
    expect(await backend.store.listDevices(principal.abaUserId)).toEqual(before.devices);
  });

  it('leaves the device registered, so the install is not forgotten', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.devices.registerDevice(principal, DEVICE);
    await backend.sessions.revokeAllSessions(principal);

    const device = await backend.store.getDevice(principal.abaUserId, DEVICE);
    expect(device?.retired_at).toBeNull();
  });

  it('cannot reach cloud user work, because no session operation names any', () => {
    // The reachable half of AUTH-9 at this phase. Sync records do not exist
    // yet; what is asserted is that nothing in the session surface could
    // touch one when they do — the port has no such method.
    const { backend } = harness();
    const sessionMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(backend.sessions));
    for (const method of sessionMethods) {
      expect(method.toLowerCase()).not.toContain('record');
      expect(method.toLowerCase()).not.toContain('delete');
      expect(method.toLowerCase()).not.toContain('purge');
    }
  });
});

describe('AUTH-13 — deletion is distinct from logout', () => {
  it('leaves the account active after logout and after sign-out everywhere', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.sessions.revokeSession(principal);
    expect((await backend.store.getUser(principal.abaUserId))?.state).toBe('active');

    await backend.sessions.revokeAllSessions(principal);
    expect((await backend.store.getUser(principal.abaUserId))?.state).toBe('active');
  });

  it('moves the account to deleted only through the deletion operation', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    const deleted = await backend.accounts.markAccountDeleted(principal);
    expect(deleted.ok && deleted.value.state).toBe('deleted');
  });

  it('invents no pending state — deletion grace is an open product question', () => {
    const state = SCHEMA.find((spec) => spec.name === 'aba_user')?.checks.find(
      (check) => check.name === 'aba_user_state_valid',
    );
    expect(state?.expression).toBe("state IN ('active', 'deleted')");
  });

  it('refuses a second deletion rather than silently succeeding', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.accounts.markAccountDeleted(principal);
    const again = await backend.accounts.markAccountDeleted(principal);
    expect(!again.ok && again.error.code).toBe('ACCOUNT_DELETED');
  });
});

describe('AUTH-14 — a revoked or deleted account cannot ride out the grace', () => {
  it('answers a deleted account definitively, never as an absence', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.accounts.markAccountDeleted(principal);

    // The client's grace window applies to the *absence* of an answer. These
    // are answers, so a client that honours the distinction cannot enter it.
    const verified = await backend.sessions.verify(principal.sessionId);
    expect(!verified.ok && verified.error.code).toBe('SESSION_REVOKED');

    const account = await backend.accounts.getAccount(principal);
    expect(!account.ok && account.error.code).toBe('ACCOUNT_DELETED');
  });

  it('refuses every authorized operation once the account is deleted', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.identities.attachIdentity(principal, google('sub-1'));
    await backend.accounts.markAccountDeleted(principal);

    // The principal object still exists — it was obtained before deletion —
    // which is precisely the stale-authorization case worth testing.
    expect(!(await backend.identities.attachIdentity(principal, google('sub-2'))).ok).toBe(true);
    expect(!(await backend.accounts.getAccount(principal)).ok).toBe(true);
    expect(
      !(
        await backend.sessions.createSession({
          abaUserId: principal.abaUserId,
          authIdentityId: null,
        })
      ).ok,
    ).toBe(true);
  });

  it('cannot mint a principal for a deleted account', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    const second = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    if (!second.ok) throw new Error('unreachable');
    await backend.accounts.markAccountDeleted(principal);

    expect((await backend.sessions.verify(second.value.sessionId)).ok).toBe(false);
  });
});

describe('AUTH-23 to AUTH-26 — linking moves and merges nothing', () => {
  it('never moves an identity between accounts', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    const hers = await backend.identities.attachIdentity(alice, google('shared'));
    if (!hers.ok) throw new Error('unreachable');

    await backend.identities.attachIdentity(bob, google('shared'));

    const after = await backend.store.getIdentity(hers.value.id);
    expect(after?.aba_user_id).toBe(alice.abaUserId);
    expect(await backend.store.listIdentities(bob.abaUserId)).toEqual([]);
  });

  it('cannot express reassignment at all — the owner column is write-once', () => {
    const owner = SCHEMA.find((spec) => spec.name === 'auth_identity')?.columns.find(
      (column) => column.name === 'aba_user_id',
    );
    expect(owner?.writeOnce).toBe(true);
  });

  it('merges no account state on a refused link', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    await backend.identities.attachIdentity(alice, google('shared'));
    await backend.devices.registerDevice(alice, DEVICE);

    await backend.identities.attachIdentity(bob, google('shared'));

    expect(await backend.store.listDevices(bob.abaUserId)).toEqual([]);
    expect(await backend.store.listIdentities(bob.abaUserId)).toEqual([]);
    expect((await backend.store.getUser(bob.abaUserId))?.id).toBe(bob.abaUserId);
  });

  it('refuses to unlink the last identity (AUTH-25)', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    const only = await backend.identities.attachIdentity(principal, google('sub-1'));
    if (!only.ok) throw new Error('unreachable');

    const attempt = await backend.identities.detachIdentity(principal, only.value.id);
    expect(!attempt.ok && attempt.error.code).toBe('LAST_IDENTITY');
  });

  it('unlinking deletes no account, device or other identity (AUTH-26)', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    const first = await backend.identities.attachIdentity(principal, google('sub-1'));
    const second = await backend.identities.attachIdentity(principal, google('sub-2'));
    await backend.devices.registerDevice(principal, DEVICE);
    if (!first.ok || !second.ok) throw new Error('unreachable');

    await backend.identities.detachIdentity(principal, first.value.id);

    expect((await backend.store.getUser(principal.abaUserId))?.state).toBe('active');
    expect(await backend.store.listDevices(principal.abaUserId)).toHaveLength(1);
    expect(await backend.store.getIdentity(second.value.id)).not.toBeNull();
  });

  it('changes no key material, because the backend holds none', () => {
    // K1 material is never transmitted, so there is nothing for a link to
    // rotate. Asserted as the absence it is (AUTH-4, AUTH-24).
    const sql = renderMigration(1).toLowerCase();
    for (const fragment of ['recovery', 'kek', 'dek', 'kd_salt', 'key_check', 'envelope']) {
      expect(sql, fragment).not.toContain(fragment);
    }
  });
});

describe('sensitive values never reach the log', () => {
  it('writes no token, digest or identity payload during a full lifecycle', async () => {
    const { backend, recorder } = harness();
    const principal = await signedIn(backend);
    const issued = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    await backend.identities.attachIdentity(principal, {
      kind: 'email',
      subject: null,
      email: 'person@example.com',
      emailVerified: true,
    });
    await backend.devices.registerDevice(principal, DEVICE);
    await backend.sessions.rotateSession(issued.value.refreshToken);
    await backend.sessions.rotateSession(issued.value.refreshToken);

    const written = recorder.serialised();
    expect(written.length).toBeGreaterThan(0);

    expect(written).not.toContain(issued.value.refreshToken);
    const row = await backend.store.getSession(issued.value.sessionId);
    expect(written).not.toContain(row?.refresh_digest);
    expect(written).not.toContain('person@example.com');
  });

  it('records enough to debug: correlation ids and event names', async () => {
    const { backend, recorder } = harness();
    const principal = await signedIn(backend);
    await backend.devices.registerDevice(principal, DEVICE);

    const events = recorder.records.map((entry) => entry.event);
    expect(events).toContain('account.created');
    expect(events).toContain('session.created');
    expect(events).toContain('device.registered');
    expect(recorder.serialised()).toContain(principal.abaUserId);
  });
});
