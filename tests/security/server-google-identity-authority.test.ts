/**
 * TEST-SECURITY-054 — a Google subject is the only Google authentication authority.
 *
 * The rule these cases hold: **where an authentication kind has a subject,
 * the subject is the identity and the address is metadata.** A verified email
 * address is never a fallback for finding the account a Google subject
 * belongs to.
 *
 * The reason is account ownership rather than tidiness. A domain can reassign
 * a verified address: alice@corp leaves, the address is given to somebody
 * else, and that person arrives holding a *new* Google subject and the *old*
 * address. Under an email fallback the resolver hands them Alice's account.
 * Subject-first ordering does not help — ordering only decides which of two
 * matches wins, and there is no subject match at all in that scenario.
 *
 * These assert **account ownership**, not call structure: every case names
 * the account a resolution resolved to, or counts the accounts and identity
 * rows that exist afterwards. None of them inspects how the lookup was done.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  createLogger,
  FixedClock,
  RecordingLogSink,
  type IdentityBackend,
  type Principal,
  type VerifiedIdentity,
} from '@server/index';
import { censusStore, type CensusStore } from '../fixtures/census-store';

const NOW = 1_800_000_000_000;

const google = (subject: string, email: string | null = null): VerifiedIdentity => ({
  kind: 'google',
  subject,
  email,
  emailVerified: email !== null,
});

const emailIdentity = (email: string): VerifiedIdentity => ({
  kind: 'email',
  subject: null,
  email,
  emailVerified: true,
});

describe('google identity authority', () => {
  let backend: IdentityBackend;
  let census: CensusStore;

  beforeEach(() => {
    census = censusStore();
    backend = createIdentityBackend({
      store: census.store,
      clock: new FixedClock(NOW),
      log: createLogger(new RecordingLogSink().sink),
    });
  });

  /** A fresh account with a session, and the principal that owns it. */
  async function account(): Promise<{ abaUserId: string; principal: Principal }> {
    const user = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: user.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    const principal = await backend.sessions.verify(issued.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    return { abaUserId: user.id, principal: principal.value };
  }

  const ownerOf = async (assertion: VerifiedIdentity): Promise<string | null> => {
    const resolved = await backend.identities.resolveIdentity(assertion);
    if (!resolved.ok) throw new Error(`resolve refused: ${resolved.error.code}`);
    return resolved.value.kind === 'existing' ? resolved.value.abaUserId : null;
  };

  it('A — a known Google subject resolves to the account that owns it', async () => {
    const alice = await account();
    await backend.identities.attachIdentity(alice.principal, google('S_alice', 'alice@corp.test'));

    expect(await ownerOf(google('S_alice', 'alice@corp.test'))).toBe(alice.abaUserId);
    // And still, when the address it carries has since changed: the subject
    // is what identifies the Google account, so an address change moves
    // nothing.
    expect(await ownerOf(google('S_alice', 'moved@corp.test'))).toBe(alice.abaUserId);
  });

  it('B — an unknown subject carrying an existing Google identity’s address owns nothing', async () => {
    const alice = await account();
    await backend.identities.attachIdentity(alice.principal, google('S_alice', 'alice@corp.test'));

    // Alice leaves; the domain reassigns her address to Bob, who arrives with
    // a Google account of his own and therefore a different subject.
    const owner = await ownerOf(google('S_bob', 'alice@corp.test'));

    // Bob owns no account. Specifically, he does not own Alice's.
    expect(owner).toBeNull();
    expect(owner).not.toBe(alice.abaUserId);
    // Alice's account is untouched: one identity, still hers, still S_alice.
    const hers = await backend.store.listIdentities(alice.abaUserId);
    expect(hers).toHaveLength(1);
    expect(hers[0]?.subject).toBe('S_alice');
    expect(hers[0]?.aba_user_id).toBe(alice.abaUserId);
  });

  it('C — an unknown subject carrying an existing email identity’s address owns nothing', async () => {
    const owner = await account();
    await backend.identities.attachIdentity(owner.principal, emailIdentity('person@corp.test'));

    const resolvedTo = await ownerOf(google('S_stranger', 'person@corp.test'));

    // Different kinds are different proofs of different things, and a shared
    // string is not a proof of either.
    expect(resolvedTo).toBeNull();
    expect(resolvedTo).not.toBe(owner.abaUserId);
    const theirs = await backend.store.listIdentities(owner.abaUserId);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.kind).toBe('email');
  });

  it('D — an unknown Google subject signs in as a new account, not an existing one', async () => {
    const alice = await account();
    await backend.identities.attachIdentity(alice.principal, google('S_alice', 'alice@corp.test'));
    const before = census.census();

    // The account-creation rule: a miss creates, a hit returns. Bob misses,
    // so Bob gets an account of his own.
    expect(await ownerOf(google('S_bob', 'bob@corp.test'))).toBeNull();
    const bob = await account();
    const attached = await backend.identities.attachIdentity(
      bob.principal,
      google('S_bob', 'bob@corp.test'),
    );

    expect(attached.ok).toBe(true);
    expect(bob.abaUserId).not.toBe(alice.abaUserId);
    expect(await ownerOf(google('S_bob', 'bob@corp.test'))).toBe(bob.abaUserId);
    // Alice's account still resolves to Alice, and exactly one account and
    // one identity were added.
    expect(await ownerOf(google('S_alice', 'alice@corp.test'))).toBe(alice.abaUserId);
    expect(census.census()).toEqual({
      accounts: before.accounts + 1,
      identities: before.identities + 1,
      devices: before.devices,
    });
  });

  it('E — a shared address neither links nor blocks: the subject decides both', async () => {
    const alice = await account();
    const bob = await account();
    await backend.identities.attachIdentity(alice.principal, google('S_alice', 'shared@corp.test'));

    // Bob holds a session on his own account and completes a Google proof for
    // a different subject that happens to carry Alice's address. Both proofs
    // are real, and they are proofs about Bob — the address says nothing.
    const attempt = await backend.identities.attachIdentity(
      bob.principal,
      google('S_bob', 'shared@corp.test'),
    );

    // It succeeds, and it has to. S_bob is an identity nobody holds, so
    // refusing it would deny Bob an account over a value that authorises
    // nothing — which is what a uniqueness key on the address used to do.
    expect(attempt.ok).toBe(true);
    // Nothing merged and nothing moved: two accounts, one identity each,
    // each subject resolving only to its own owner.
    expect(await ownerOf(google('S_alice', 'shared@corp.test'))).toBe(alice.abaUserId);
    expect(await ownerOf(google('S_bob', 'shared@corp.test'))).toBe(bob.abaUserId);
    expect(await backend.store.listIdentities(alice.abaUserId)).toHaveLength(1);
    expect(await backend.store.listIdentities(bob.abaUserId)).toHaveLength(1);
    expect(census.census().accounts).toBe(2);
  });

  it('E2 — a subject already held elsewhere is still refused, naming nobody', async () => {
    const alice = await account();
    const bob = await account();
    await backend.identities.attachIdentity(alice.principal, google('S_alice', 'alice@corp.test'));

    // The other half of the rule. The address is not an identity, but the
    // subject is — and one external subject belongs to at most one account
    // (AUTH-23), enforced by the database rather than only by this service.
    const attempt = await backend.identities.attachIdentity(
      bob.principal,
      google('S_alice', 'someone.else@corp.test'),
    );

    expect(attempt.ok).toBe(false);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.error.code).toBe('IDENTITY_IN_USE');
    expect(JSON.stringify(attempt.error)).not.toContain(alice.abaUserId);
    expect(await backend.store.listIdentities(bob.abaUserId)).toHaveLength(0);
    // Still Alice's, and still pointing at her.
    expect(await ownerOf(google('S_alice', 'alice@corp.test'))).toBe(alice.abaUserId);
  });

  it('G — a second Google subject on the same account is attached, never silently dropped', async () => {
    const owner = await account();
    await backend.identities.attachIdentity(owner.principal, google('S_alice', 'shared@corp.test'));

    // The account holds S_alice. A link is completed for a *different* Google
    // subject that carries the same address — a second Google account on one
    // ABA account, which is precisely what Model B is for.
    //
    // This is the case that was silently broken twice over. Resolution used
    // to match the address, see the row already on this account and report
    // the idempotent no-op a re-link is supposed to produce: success, with
    // nothing written. Narrowing resolution to the subject then exposed a
    // uniqueness key over the address, which refused it outright. Neither
    // outcome attached S_bob, and signing in with it would have produced a
    // separate account either way.
    const attempt = await backend.identities.attachIdentity(
      owner.principal,
      google('S_bob', 'shared@corp.test'),
    );

    expect(attempt.ok).toBe(true);
    if (!attempt.ok) throw new Error('unreachable');
    expect(attempt.value.subject).toBe('S_bob');
    // Both rows are present and both resolve to this one account.
    const rows = await backend.store.listIdentities(owner.abaUserId);
    expect(rows.map((row) => row.subject).sort()).toEqual(['S_alice', 'S_bob']);
    expect(await ownerOf(google('S_alice', 'shared@corp.test'))).toBe(owner.abaUserId);
    expect(await ownerOf(google('S_bob', 'shared@corp.test'))).toBe(owner.abaUserId);
    // One account, two identities — a link, not a second account.
    expect(census.census()).toMatchObject({ accounts: 1, identities: 2 });
  });

  it('F — the same address on both kinds stays two accounts, each resolving to its own', async () => {
    const viaGoogle = await account();
    const viaEmail = await account();
    await backend.identities.attachIdentity(
      viaGoogle.principal,
      google('S_person', 'person@corp.test'),
    );
    await backend.identities.attachIdentity(viaEmail.principal, emailIdentity('person@corp.test'));

    // Per-kind uniqueness permits both rows. Each assertion resolves to its
    // own account and never to the other, in either direction.
    expect(await ownerOf(google('S_person', 'person@corp.test'))).toBe(viaGoogle.abaUserId);
    expect(await ownerOf(emailIdentity('person@corp.test'))).toBe(viaEmail.abaUserId);
    expect(viaGoogle.abaUserId).not.toBe(viaEmail.abaUserId);
  });
});
