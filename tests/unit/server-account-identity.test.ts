/**
 * TEST-SERVER-002 — accounts and authentication identities.
 *
 * The behaviour under test is the approved account-linking policy expressed
 * as code: multiple verified identities may belong to one account, an
 * identity resolves to at most one account, and an identity attached
 * elsewhere is refused rather than moved.
 *
 * The `abaUserId` assertions are the other half. A client that could choose
 * its own account id could name somebody else's, so the property worth
 * testing is not that a supplied id is rejected — it is that there is no
 * parameter in which to supply one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  FixedClock,
  normaliseEmail,
  type IdentityBackend,
  type Principal,
  type VerifiedIdentity,
} from '@server/index';

const T0 = 1_800_000_000_000;

function google(subject: string, email: string | null = null): VerifiedIdentity {
  return { kind: 'google', subject, email, emailVerified: email !== null };
}

function emailIdentity(address: string): VerifiedIdentity {
  return { kind: 'email', subject: null, email: normaliseEmail(address), emailVerified: true };
}

describe('accounts and identities', () => {
  let clock: FixedClock;
  let backend: IdentityBackend;

  /** An account plus a principal for it, the way a real sign-in would. */
  async function signedIn(): Promise<{ principal: Principal; abaUserId: string }> {
    const account = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('fixture could not create a session');
    const verified = await backend.sessions.verify(issued.value.sessionId);
    if (!verified.ok) throw new Error('fixture could not verify its own session');
    return { principal: verified.value, abaUserId: account.id };
  }

  beforeEach(() => {
    clock = new FixedClock(T0);
    backend = createIdentityBackend({ clock });
  });

  describe('abaUserId', () => {
    it('is assigned by the server and is opaque', async () => {
      const account = await backend.accounts.createAccount();
      expect(account.id).toMatch(/^usr_[0-9a-f]{32}$/);
      expect(account.state).toBe('active');
      expect(account.deleted_at).toBeNull();
    });

    it('is different for every account', async () => {
      const ids = new Set<string>();
      for (let index = 0; index < 50; index += 1) {
        ids.add((await backend.accounts.createAccount()).id);
      }
      expect(ids.size).toBe(50);
    });

    it('is stable across every read', async () => {
      const { principal, abaUserId } = await signedIn();
      clock.advance(60_000);
      const first = await backend.accounts.getAccount(principal);
      clock.advance(60_000);
      const second = await backend.accounts.getAccount(principal);
      expect(first.ok && first.value.id).toBe(abaUserId);
      expect(second.ok && second.value.id).toBe(abaUserId);
    });

    it('cannot be chosen by a caller — createAccount takes no argument', () => {
      // The compile-time fact, asserted at runtime so the property is visible
      // in the report rather than only in the type checker.
      expect(backend.accounts.createAccount.length).toBe(0);
    });

    it('is not derived from anything the caller supplies', async () => {
      const account = await backend.accounts.createAccount();
      const issued = await backend.sessions.createSession({
        abaUserId: account.id,
        authIdentityId: null,
      });
      if (!issued.ok) throw new Error('unreachable');
      const verified = await backend.sessions.verify(issued.value.sessionId);
      if (!verified.ok) throw new Error('unreachable');

      const address = 'person@example.com';
      await backend.identities.attachIdentity(verified.value, emailIdentity(address));
      const reread = await backend.store.getUser(account.id);
      // Neither the address nor any device value appears in the id.
      expect(reread?.id).toBe(account.id);
      expect(reread?.id).not.toContain('person');
      expect(reread?.id).not.toContain('example');
    });
  });

  describe('identity resolution', () => {
    it('reports an unknown identity rather than creating one', async () => {
      const resolved = await backend.identities.resolveIdentity(google('sub-1'));
      expect(resolved.ok && resolved.value.kind).toBe('unknown');
    });

    it('resolves a known subject back to the same account', async () => {
      const { principal, abaUserId } = await signedIn();
      await backend.identities.attachIdentity(principal, google('sub-1'));

      const resolved = await backend.identities.resolveIdentity(google('sub-1'));
      expect(resolved.ok && resolved.value.kind).toBe('existing');
      expect(resolved.ok && resolved.value.kind === 'existing' && resolved.value.abaUserId).toBe(
        abaUserId,
      );
    });

    it('matches a subject before an email, so an address change moves nothing', async () => {
      const { principal, abaUserId } = await signedIn();
      await backend.identities.attachIdentity(principal, google('sub-1', 'old@example.com'));

      // Same Google account, new address.
      const resolved = await backend.identities.resolveIdentity(google('sub-1', 'new@example.com'));
      expect(resolved.ok && resolved.value.kind === 'existing' && resolved.value.abaUserId).toBe(
        abaUserId,
      );
    });

    it('never matches an unverified address', async () => {
      const { principal } = await signedIn();
      await backend.identities.attachIdentity(principal, emailIdentity('person@example.com'));

      const unverified: VerifiedIdentity = {
        kind: 'email',
        subject: null,
        email: 'person@example.com',
        emailVerified: false,
      };
      const resolved = await backend.identities.resolveIdentity(unverified);
      expect(resolved.ok).toBe(false);
      expect(!resolved.ok && resolved.error.code).toBe('INVALID_ARGUMENT');
    });

    it('refuses an assertion that identifies nobody', async () => {
      const empty: VerifiedIdentity = {
        kind: 'email',
        subject: null,
        email: null,
        emailVerified: false,
      };
      const resolved = await backend.identities.resolveIdentity(empty);
      expect(!resolved.ok && resolved.error.code).toBe('INVALID_ARGUMENT');
    });

    it('refuses an address that was not normalised', async () => {
      const mixed: VerifiedIdentity = {
        kind: 'email',
        subject: null,
        email: 'Person@Example.COM',
        emailVerified: true,
      };
      expect(!(await backend.identities.resolveIdentity(mixed)).ok).toBe(true);
    });
  });

  describe('normaliseEmail', () => {
    it('folds the domain, trims the ends, and leaves the local part alone', () => {
      // The domain is a DNS name and is case-insensitive by definition. The
      // local part is not: RFC 5321 reserves its interpretation to the
      // destination host, so folding it would be a guess about somebody
      // else's mail server — and a wrong guess merges two people.
      expect(normaliseEmail('  Person@Example.COM ')).toBe('Person@example.com');
      expect(normaliseEmail('PERSON@example.com')).not.toBe(normaliseEmail('person@example.com'));
      // A quoted local part may contain an `@`; the domain is what follows
      // the last one.
      expect(normaliseEmail('"a@b"@Example.COM')).toBe('"a@b"@example.com');
    });

    it('leaves dots and plus-tags alone, because stripping them merges people', () => {
      expect(normaliseEmail('a.b+work@example.com')).toBe('a.b+work@example.com');
      expect(normaliseEmail('a.b@example.com')).not.toBe(normaliseEmail('ab@example.com'));
    });
  });

  describe('linking', () => {
    it('holds a Google identity and an email identity on one account', async () => {
      const { principal, abaUserId } = await signedIn();
      const first = await backend.identities.attachIdentity(principal, google('sub-1'));
      const second = await backend.identities.attachIdentity(
        principal,
        emailIdentity('person@example.com'),
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const identities = await backend.identities.listIdentities(principal);
      expect(identities).toHaveLength(2);
      expect(identities.every((row) => row.aba_user_id === abaUserId)).toBe(true);
      expect(new Set(identities.map((row) => row.kind))).toEqual(new Set(['google', 'email']));
    });

    it('resolves both identities to the same account', async () => {
      const { principal, abaUserId } = await signedIn();
      await backend.identities.attachIdentity(principal, google('sub-1'));
      await backend.identities.attachIdentity(principal, emailIdentity('person@example.com'));

      for (const assertion of [google('sub-1'), emailIdentity('person@example.com')]) {
        const resolved = await backend.identities.resolveIdentity(assertion);
        expect(resolved.ok && resolved.value.kind === 'existing' && resolved.value.abaUserId).toBe(
          abaUserId,
        );
      }
    });

    it('records the session that performed the link', async () => {
      const { principal } = await signedIn();
      const linked = await backend.identities.attachIdentity(principal, google('sub-1'));
      expect(linked.ok && linked.value.linked_via).toBe(principal.sessionId);
      expect(linked.ok && linked.value.linked_at).toBe(T0);
    });

    it('is a no-op success when the identity is already on this account', async () => {
      const { principal } = await signedIn();
      const first = await backend.identities.attachIdentity(principal, google('sub-1'));
      const again = await backend.identities.attachIdentity(principal, google('sub-1'));

      if (!first.ok || !again.ok) throw new Error('unreachable');
      expect(again.value.id).toBe(first.value.id);
      expect(await backend.identities.listIdentities(principal)).toHaveLength(1);
    });

    it('refuses an identity attached to another account, and names no account', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      await backend.identities.attachIdentity(alice.principal, google('shared-sub'));

      const attempt = await backend.identities.attachIdentity(bob.principal, google('shared-sub'));
      expect(attempt.ok).toBe(false);
      expect(!attempt.ok && attempt.error.code).toBe('IDENTITY_IN_USE');
      // The message says an account holds it, never which one.
      expect(!attempt.ok && attempt.error.message).not.toContain(alice.abaUserId);
    });

    it('writes nothing when a link is refused', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      const original = await backend.identities.attachIdentity(
        alice.principal,
        google('shared-sub'),
      );
      if (!original.ok) throw new Error('unreachable');

      await backend.identities.attachIdentity(bob.principal, google('shared-sub'));

      expect(await backend.identities.listIdentities(bob.principal)).toEqual([]);
      const unchanged = await backend.store.getIdentity(original.value.id);
      expect(unchanged).toEqual(original.value);
    });

    it('refuses linking onto a deleted account', async () => {
      const { principal } = await signedIn();
      await backend.identities.attachIdentity(principal, google('sub-1'));
      await backend.accounts.markAccountDeleted(principal);

      const attempt = await backend.identities.attachIdentity(
        principal,
        emailIdentity('person@example.com'),
      );
      expect(!attempt.ok && attempt.error.code).toBe('ACCOUNT_DELETED');
    });
  });

  describe('unlinking', () => {
    it('removes one of two identities', async () => {
      const { principal } = await signedIn();
      const first = await backend.identities.attachIdentity(principal, google('sub-1'));
      await backend.identities.attachIdentity(principal, emailIdentity('person@example.com'));
      if (!first.ok) throw new Error('unreachable');

      const removed = await backend.identities.detachIdentity(principal, first.value.id);
      expect(removed.ok).toBe(true);
      expect(await backend.identities.listIdentities(principal)).toHaveLength(1);
    });

    it('refuses to remove the last verified identity', async () => {
      const { principal } = await signedIn();
      const only = await backend.identities.attachIdentity(principal, google('sub-1'));
      if (!only.ok) throw new Error('unreachable');

      const attempt = await backend.identities.detachIdentity(principal, only.value.id);
      expect(!attempt.ok && attempt.error.code).toBe('LAST_IDENTITY');
      expect(await backend.identities.listIdentities(principal)).toHaveLength(1);
    });

    it('reports another account’s identity as not found, not as forbidden', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      const hers = await backend.identities.attachIdentity(alice.principal, google('sub-1'));
      if (!hers.ok) throw new Error('unreachable');

      const attempt = await backend.identities.detachIdentity(bob.principal, hers.value.id);
      expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
      // And it is still there.
      expect(await backend.store.getIdentity(hers.value.id)).not.toBeNull();
    });

    it('does not delete the account', async () => {
      const { principal, abaUserId } = await signedIn();
      const first = await backend.identities.attachIdentity(principal, google('sub-1'));
      await backend.identities.attachIdentity(principal, emailIdentity('person@example.com'));
      if (!first.ok) throw new Error('unreachable');

      await backend.identities.detachIdentity(principal, first.value.id);
      const account = await backend.store.getUser(abaUserId);
      expect(account?.state).toBe('active');
      expect(account?.deleted_at).toBeNull();
    });
  });
});
