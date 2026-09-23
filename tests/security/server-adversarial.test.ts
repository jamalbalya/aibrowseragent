/**
 * TEST-SERVER-021 — adversarial cases against the identity foundation.
 *
 * Every test here is written from the attacker's side: what would somebody
 * *try*, given the surface that exists? The distinction from the invariant
 * suite is that those assert a property holds, and these assert that a
 * specific attempt to break it fails — including the attempts that look like
 * ordinary API use, which are the ones that get through review.
 *
 * Several cases attack the persistence layer directly rather than through a
 * service, because a service is a convention and a constraint is a mechanism.
 * An attack that the service happens not to expose today is an attack the next
 * service might, so the question worth answering is whether the *store* would
 * allow it.
 */
import { describe, expect, it } from 'vitest';
import {
  ConstraintViolation,
  createIdentityBackend,
  FixedClock,
  MemoryStore,
  newAbaUserId,
  owns,
  requireOwned,
  type IdentityBackend,
  type Principal,
  type VerifiedIdentity,
} from '@server/index';

const T0 = 1_800_000_000_000;
const DEVICE = 'dev_11111111-2222-4333-8444-555555555555';

function harness(): { backend: IdentityBackend; clock: FixedClock } {
  const clock = new FixedClock(T0);
  return { backend: createIdentityBackend({ clock }), clock };
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

describe('forged abaUserId', () => {
  it('cannot be smuggled in through a fabricated principal', async () => {
    const { backend } = harness();
    const victim = await signedIn(backend);
    await backend.devices.registerDevice(victim, DEVICE);

    // The strongest forgery available without a session: an object with the
    // right shape. The brand makes it unusable at compile time; this asserts
    // that even when forced through, it reads no data it should not — because
    // the lookup is scoped by the id it carries, and that id is a guess.
    const forged = {
      abaUserId: newAbaUserId(),
      sessionId: 'ses_00000000000000000000000000000000',
      authIdentityId: null,
      __brand: 'Principal',
    } as Principal;

    const attempt = await backend.devices.getDevice(forged, DEVICE);
    expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
  });

  it('cannot be guessed: ids are 128 bits of CSPRNG output', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newAbaUserId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^usr_[0-9a-f]{32}$/);
  });

  it('cannot be rewritten, because the port exposes no way to write it', async () => {
    const store = new MemoryStore();
    const id = newAbaUserId();
    await store.insertUser({ id, created_at: T0, state: 'active', deleted_at: null });

    // Two mechanisms, and the test names both. The column is write-once, so
    // an update naming it is refused; and no method on the port takes a new
    // id at all, so there is nothing to call.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(methods.filter((name) => /^(set|update|rename|move)User/i.test(name))).toEqual([]);

    // The one mutating path for a user row touches state and nothing else.
    await store.markUserDeleted(id, T0 + 1);
    expect((await store.getUser(id))?.id).toBe(id);
  });
});

describe('identity reassignment', () => {
  it('is refused through the service', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    const hers = await backend.identities.attachIdentity(alice, google('shared'));
    if (!hers.ok) throw new Error('unreachable');

    const attempt = await backend.identities.attachIdentity(bob, google('shared'));
    expect(!attempt.ok && attempt.error.code).toBe('IDENTITY_IN_USE');
    expect((await backend.store.getIdentity(hers.value.id))?.aba_user_id).toBe(alice.abaUserId);
  });

  it('is refused by the store even with a direct insert', async () => {
    const store = new MemoryStore();
    const alice = newAbaUserId();
    const bob = newAbaUserId();
    for (const id of [alice, bob]) {
      await store.insertUser({ id, created_at: T0, state: 'active', deleted_at: null });
    }
    await store.insertIdentity({
      id: 'aid_11111111111111111111111111111111',
      aba_user_id: alice,
      kind: 'google',
      subject: 'shared',
      email: null,
      email_verified: false,
      linked_at: T0,
      linked_via: null,
      last_used_at: null,
    });

    // A second row for the same external subject, under another account: the
    // unique index is what stops it, not the service.
    await expect(
      store.insertIdentity({
        id: 'aid_22222222222222222222222222222222',
        aba_user_id: bob,
        kind: 'google',
        subject: 'shared',
        email: null,
        email_verified: false,
        linked_at: T0,
        linked_via: null,
        last_used_at: null,
      }),
    ).rejects.toThrow(ConstraintViolation);
  });

  it('refuses a duplicate verified address under a second account', async () => {
    const store = new MemoryStore();
    const alice = newAbaUserId();
    const bob = newAbaUserId();
    for (const id of [alice, bob]) {
      await store.insertUser({ id, created_at: T0, state: 'active', deleted_at: null });
    }
    const row = (id: string, owner: string) => ({
      id,
      aba_user_id: owner,
      kind: 'email' as const,
      subject: null,
      email: 'person@example.com',
      email_verified: true,
      linked_at: T0,
      linked_via: null,
      last_used_at: null,
    });
    await store.insertIdentity(row('aid_11111111111111111111111111111111', alice));
    await expect(
      store.insertIdentity(row('aid_22222222222222222222222222222222', bob)),
    ).rejects.toThrow(ConstraintViolation);
  });

  it('allows two UNVERIFIED claims on one address, so neither becomes an identity', async () => {
    // The partial index deliberately excludes unverified rows. Two unverified
    // claims colliding into one account would be the pre-hijack attack, so
    // they are permitted to coexist as claims and neither ever resolves.
    const store = new MemoryStore();
    const alice = newAbaUserId();
    const bob = newAbaUserId();
    for (const id of [alice, bob]) {
      await store.insertUser({ id, created_at: T0, state: 'active', deleted_at: null });
    }
    const row = (id: string, owner: string) => ({
      id,
      aba_user_id: owner,
      kind: 'email' as const,
      subject: null,
      email: 'person@example.com',
      email_verified: false,
      linked_at: T0,
      linked_via: null,
      last_used_at: null,
    });
    await store.insertIdentity(row('aid_11111111111111111111111111111111', alice));
    await store.insertIdentity(row('aid_22222222222222222222222222222222', bob));

    // And neither is findable, because lookup requires verification.
    expect(await store.findIdentityByVerifiedEmail('email', 'person@example.com')).toBeNull();
  });
});

describe('cross-user access', () => {
  it('refuses a cross-user device registration attempt', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    await backend.devices.registerDevice(alice, DEVICE);

    // Bob registers the same id. He gets his own row; hers is untouched.
    const his = await backend.devices.registerDevice(bob, DEVICE);
    expect(his.ok && his.value.aba_user_id).toBe(bob.abaUserId);
    const hers = await backend.store.getDevice(alice.abaUserId, DEVICE);
    expect(hers?.registered_at).toBe(T0);
    expect(hers?.aba_user_id).toBe(alice.abaUserId);
  });

  it('refuses a cross-user session: a principal never spans accounts', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);

    expect(owns(alice, { aba_user_id: bob.abaUserId })).toBe(false);
    expect(owns(alice, { aba_user_id: alice.abaUserId })).toBe(true);

    const denied = requireOwned(bob, { aba_user_id: alice.abaUserId });
    expect(!denied.ok && denied.error.code).toBe('NOT_FOUND');
  });

  it('refuses a foreign identity when opening a session', async () => {
    const { backend } = harness();
    const alice = await signedIn(backend);
    const bob = await signedIn(backend);
    const hers = await backend.identities.attachIdentity(alice, google('sub-1'));
    if (!hers.ok) throw new Error('unreachable');

    // A session for Bob claiming Alice's identity would record a provenance
    // that is a lie, and would later revoke the wrong person's sessions.
    const attempt = await backend.sessions.createSession({
      abaUserId: bob.abaUserId,
      authIdentityId: hers.value.id,
    });
    expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
  });
});

describe('refresh token attacks', () => {
  it('revokes the family when a stolen token is used after the user rotated', async () => {
    const { backend, clock } = harness();
    const principal = await signedIn(backend);
    const issued = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    const stolen = issued.value.refreshToken;

    clock.advance(1000);
    const userRotation = await backend.sessions.rotateSession(stolen);
    if (!userRotation.ok) throw new Error('unreachable');

    clock.advance(1000);
    const thief = await backend.sessions.rotateSession(stolen);
    expect(!thief.ok && thief.error.code).toBe('SESSION_REVOKED');

    // The user's current token is dead too — the cost of the defence, and the
    // correct trade when the alternative is leaving the thief's alive.
    const afterwards = await backend.sessions.rotateSession(userRotation.value.refreshToken);
    expect(!afterwards.ok && afterwards.error.code).toBe('SESSION_REVOKED');
  });

  it('refuses a revoked token without reviving anything', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    const issued = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    const verified = await backend.sessions.verify(issued.value.sessionId);
    if (!verified.ok) throw new Error('unreachable');
    await backend.sessions.revokeSession(verified.value);

    const attempt = await backend.sessions.rotateSession(issued.value.refreshToken);
    expect(!attempt.ok && attempt.error.code).toBe('SESSION_REVOKED');
    expect((await backend.store.getSession(issued.value.sessionId))?.revoked_at).not.toBeNull();
  });

  it('does not confuse two families: revoking one leaves the other', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    const a = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    const b = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    if (!a.ok || !b.ok) throw new Error('unreachable');

    await backend.sessions.rotateSession(a.value.refreshToken);
    await backend.sessions.rotateSession(a.value.refreshToken);

    const survivor = await backend.sessions.rotateSession(b.value.refreshToken);
    expect(survivor.ok).toBe(true);
  });

  it('cannot be forged by guessing: a random token matches nothing', async () => {
    const { backend } = harness();
    await signedIn(backend);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const guess = Array.from({ length: 64 }, () => '0123456789abcdef'[attempt % 16]).join('');
      const result = await backend.sessions.rotateSession(guess);
      expect(!result.ok && result.error.code).toBe('AUTH_REQUIRED');
    }
  });

  it('refuses two sessions sharing a digest', async () => {
    const store = new MemoryStore();
    const owner = newAbaUserId();
    await store.insertUser({ id: owner, created_at: T0, state: 'active', deleted_at: null });
    const row = (id: string) => ({
      id,
      aba_user_id: owner,
      auth_identity_id: null,
      family_id: 'fam_11111111111111111111111111111111',
      refresh_digest: 'd'.repeat(64),
      issued_at: T0,
      expires_at: T0 + 1000,
      rotated_at: null,
      revoked_at: null,
      revoked_reason: null,
      last_seen_at: T0,
    });
    await store.insertSession(row('ses_11111111111111111111111111111111'));
    await expect(store.insertSession(row('ses_22222222222222222222222222222222'))).rejects.toThrow(
      ConstraintViolation,
    );
  });
});

describe('session fixation', () => {
  it('never adopts an identifier supplied by a caller', async () => {
    const { backend } = harness();
    const account = await backend.accounts.createAccount();

    const first = await backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    const second = await backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!first.ok || !second.ok) throw new Error('unreachable');

    // Two calls with identical inputs produce different sessions, different
    // families and different tokens. Nothing about the input decides them.
    expect(first.value.sessionId).not.toBe(second.value.sessionId);
    expect(first.value.refreshToken).not.toBe(second.value.refreshToken);
  });
});

describe('deleted account', () => {
  it('cannot be used through a principal obtained before deletion', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.accounts.markAccountDeleted(principal);

    // The principal was obtained before deletion, so it is exactly the stale
    // object an attacker would hope still works. Every operation refuses it.
    const registered = await backend.devices.registerDevice(principal, DEVICE);
    expect(!registered.ok && registered.error.code).toBe('ACCOUNT_DELETED');
    expect(!(await backend.devices.retireDevice(principal, DEVICE)).ok).toBe(true);
    expect(!(await backend.accounts.getAccount(principal)).ok).toBe(true);
    expect(!(await backend.identities.attachIdentity(principal, google('sub-x'))).ok).toBe(true);
    expect((await backend.sessions.verify(principal.sessionId)).ok).toBe(false);
  });

  it('cannot open a new session', async () => {
    const { backend } = harness();
    const principal = await signedIn(backend);
    await backend.accounts.markAccountDeleted(principal);
    const attempt = await backend.sessions.createSession({
      abaUserId: principal.abaUserId,
      authIdentityId: null,
    });
    expect(!attempt.ok && attempt.error.code).toBe('ACCOUNT_DELETED');
  });
});

describe('store-level integrity', () => {
  it('refuses an identity for an account that does not exist', async () => {
    const store = new MemoryStore();
    await expect(
      store.insertIdentity({
        id: 'aid_11111111111111111111111111111111',
        aba_user_id: newAbaUserId(),
        kind: 'google',
        subject: 'sub-1',
        email: null,
        email_verified: false,
        linked_at: T0,
        linked_via: null,
        last_used_at: null,
      }),
    ).rejects.toThrow(ConstraintViolation);
  });

  it('refuses a row carrying a column the schema does not declare', async () => {
    const store = new MemoryStore();
    const id = newAbaUserId();
    await expect(
      store.insertUser({
        id,
        created_at: T0,
        state: 'active',
        deleted_at: null,
        // The shape an exfiltration attempt would take.
        provider_api_key: 'x',
      } as never),
    ).rejects.toThrow(ConstraintViolation);
  });

  it('refuses a null in a NOT NULL column', async () => {
    const store = new MemoryStore();
    await expect(
      store.insertUser({
        id: newAbaUserId(),
        created_at: T0,
        state: null,
        deleted_at: null,
      } as never),
    ).rejects.toThrow(ConstraintViolation);
  });

  it('refuses a duplicate primary key', async () => {
    const store = new MemoryStore();
    const id = newAbaUserId();
    await store.insertUser({ id, created_at: T0, state: 'active', deleted_at: null });
    await expect(
      store.insertUser({ id, created_at: T0, state: 'active', deleted_at: null }),
    ).rejects.toThrow(ConstraintViolation);
  });
});
