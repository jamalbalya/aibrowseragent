/**
 * TEST-SECURITY-061 — the canonical email contract, as behaviour.
 *
 * Every case here is a **finalised** decision from the email identity gate.
 * The ones the gate left open — Unicode normalisation, IDN, confusables — have
 * no tests, deliberately: a test for an undecided rule would freeze whichever
 * behaviour the code happens to have today into a contract nobody chose.
 *
 * The case that matters most is 06. The schema said the stored address must
 * equal `lower(email)` while the canonicaliser deliberately preserves
 * local-part case, so an address with a capital letter before the `@` passed
 * every application check and would have been refused by the database at
 * sign-in. Nothing caught it because CHECK constraints were rendered into DDL
 * and enforced nowhere under test.
 */
import { describe, expect, it } from 'vitest';
import { normaliseEmail } from '@/../server/app/identity-service';
import { domainOf, SCHEMA } from '@/../server/db/schema';
import { MemoryStore } from '@/../server/db/memory-store';

const table = (name: string) => {
  const found = SCHEMA.find((entry) => entry.name === name);
  if (!found) throw new Error(`no table ${name}`);
  return found;
};

describe('TEST-SECURITY-061 — canonical form', () => {
  it('01 — the domain folds and the local part does not', () => {
    // RFC 5321 §2.4 reserves the local part to the destination host, so
    // folding it is a guess about somebody else's mail server. The two
    // failure modes are not symmetric: folding a host that distinguishes
    // them **merges two people into one account**, which is unrecoverable;
    // not folding **splits one person into two**, which is visible and
    // repairable by the explicit link flow.
    expect(normaliseEmail('Alice.Smith@Example.COM')).toBe('Alice.Smith@example.com');
    expect(normaliseEmail('ALICE@EXAMPLE.COM')).toBe('ALICE@example.com');
    expect(normaliseEmail('  bob@example.com  ')).toBe('bob@example.com');
  });

  it('02 — no provider-specific alias rule is applied', () => {
    // Dots and `+tags` mean different things at different hosts, and a rule
    // that is right for one provider merges distinct addresses at another.
    expect(normaliseEmail('a.b.c@example.com')).toBe('a.b.c@example.com');
    expect(normaliseEmail('user+tag@example.com')).toBe('user+tag@example.com');
    // Including at the provider people assume the rule comes from.
    expect(normaliseEmail('first.last+news@gmail.com')).toBe('first.last+news@gmail.com');
  });

  it('03 — the split is on the last @, because a quoted local part may hold one', () => {
    expect(normaliseEmail('"odd@name"@Example.COM')).toBe('"odd@name"@example.com');
  });

  it('04 — canonicalisation never rejects; it is not validation', () => {
    // Kept apart on purpose, so "what an address means" cannot quietly become
    // "what we were willing to accept".
    for (const input of ['', '@', 'no-at-sign', 'trailing@']) {
      expect(() => normaliseEmail(input)).not.toThrow();
    }
  });

  it('05 — interior whitespace is refused rather than removed', () => {
    // A space inside an address is either a typo or a quoted local part, and
    // the two are indistinguishable from here. Stripping it would silently
    // turn one address into a different one and then send a proof of control
    // to whichever mailbox the edited version reaches.
    const canonical = normaliseEmail('  al ice@example.com  ');
    expect(canonical).toBe('al ice@example.com');
    expect(canonical).toContain(' ');
  });
});

describe('TEST-SECURITY-061 — the schema agrees with the canonicaliser', () => {
  const check = () => {
    const found = table('auth_identity').checks.find((entry) =>
      entry.name.startsWith('auth_identity_email'),
    );
    if (!found?.holds) throw new Error('the email check has no JavaScript twin');
    return found;
  };

  it('06 — every canonical address satisfies the stored-form check', () => {
    // The defect this case exists for: the check required the **whole**
    // address to be lowercase, which no address with a capital before the
    // `@` can satisfy — so a Google account with such an address would have
    // been refused by the database after passing every application check.
    const { holds } = check();
    for (const raw of [
      'Alice.Smith@Example.COM',
      'ALICE@EXAMPLE.COM',
      'bob@example.com',
      '"odd@name"@EXAMPLE.com',
      'user+tag@Example.Com',
    ]) {
      const canonical = normaliseEmail(raw);
      expect(holds?.({ email: canonical }), canonical).toBe(true);
    }
    expect(holds?.({ email: null })).toBe(true);
  });

  it('07 — an unfolded domain is still refused, so the check is not vacuous', () => {
    const { holds } = check();
    expect(holds?.({ email: 'alice@Example.com' })).toBe(false);
    expect(holds?.({ email: 'Alice@EXAMPLE.COM' })).toBe(false);
    // And the local part's case is genuinely not the check's business.
    expect(holds?.({ email: 'Alice@example.com' })).toBe(true);
  });

  it('08 — the rendered SQL and the JavaScript twin split on the same @', () => {
    // Both take everything after the **last** separator. A `split_part`-style
    // expression would take the second field and disagree with the
    // canonicaliser on a quoted local part.
    expect(check().expression).toContain("regexp_replace(email, '^.*@', '')");
    expect(domainOf('"odd@name"@example.com')).toBe('example.com');
    expect(domainOf(normaliseEmail('"odd@name"@EXAMPLE.com'))).toBe('example.com');
  });

  it('09 — the store enforces the check, not only the renderer', async () => {
    // The gap that let the contradiction live: checks were rendered into DDL
    // and enforced nowhere a test could see.
    const store = new MemoryStore();
    await store.insertUser({ id: 'usr_1', created_at: 0, state: 'active', deleted_at: null });

    const row = {
      id: 'ident_1',
      aba_user_id: 'usr_1',
      kind: 'email' as const,
      subject: null,
      email: 'alice@NOT-FOLDED.com',
      email_verified: true,
      linked_at: 0,
      linked_via: null,
      last_used_at: null,
    };
    await expect(store.insertIdentity(row)).rejects.toThrow();

    // The canonical form of the same address is accepted.
    await store.insertIdentity({ ...row, email: normaliseEmail('Alice@NOT-FOLDED.com') });
  });
});

describe('TEST-SECURITY-061 — uniqueness follows the authenticator', () => {
  const emailKey = () => {
    const found = table('auth_identity').unique.find(
      (entry) => entry.name === 'auth_identity_email_key',
    );
    if (!found) throw new Error('no email uniqueness key');
    return found;
  };

  it('10 — address uniqueness applies only where the address IS the identity', () => {
    // Google's authority is the subject. Where a subject exists the address
    // is metadata, and a uniqueness key over metadata denies service on a
    // value that authorises nothing: two distinct Google subjects can carry
    // one address — a domain reassigns it, and our copy of the old holder's
    // is never refreshed — and the second could then never sign in.
    expect(emailKey().requiresNull).toEqual(['subject']);
    expect(emailKey().requires).toEqual(['email', 'email_verified']);
  });

  it('11 — two Google subjects sharing one address both resolve', async () => {
    const store = new MemoryStore();
    await store.insertUser({ id: 'usr_1', created_at: 0, state: 'active', deleted_at: null });
    await store.insertUser({ id: 'usr_2', created_at: 0, state: 'active', deleted_at: null });

    const base = {
      kind: 'google' as const,
      email: 'shared@example.com',
      email_verified: true,
      linked_at: 0,
      linked_via: null,
      last_used_at: null,
    };
    await store.insertIdentity({ ...base, id: 'i1', aba_user_id: 'usr_1', subject: 'sub-A' });

    // Scenario D from the gate: the address was reassigned by the domain, and
    // our copy of the first holder's is stale. The second subject must still
    // be able to sign in.
    await store.insertIdentity({ ...base, id: 'i2', aba_user_id: 'usr_2', subject: 'sub-B' });

    expect((await store.findIdentityBySubject('google', 'sub-A'))?.aba_user_id).toBe('usr_1');
    expect((await store.findIdentityBySubject('google', 'sub-B'))?.aba_user_id).toBe('usr_2');
  });

  it('12 — two subjectless identities cannot share one address', async () => {
    const store = new MemoryStore();
    await store.insertUser({ id: 'usr_1', created_at: 0, state: 'active', deleted_at: null });
    await store.insertUser({ id: 'usr_2', created_at: 0, state: 'active', deleted_at: null });

    const base = {
      kind: 'email' as const,
      subject: null,
      email: 'one@example.com',
      email_verified: true,
      linked_at: 0,
      linked_via: null,
      last_used_at: null,
    };
    await store.insertIdentity({ ...base, id: 'i1', aba_user_id: 'usr_1' });

    // Here the address IS the identity, so one account per address.
    await expect(
      store.insertIdentity({ ...base, id: 'i2', aba_user_id: 'usr_2' }),
    ).rejects.toThrow();
  });

  it('13 — an unverified address is a claim and never occupies the key', async () => {
    const store = new MemoryStore();
    await store.insertUser({ id: 'usr_1', created_at: 0, state: 'active', deleted_at: null });
    await store.insertUser({ id: 'usr_2', created_at: 0, state: 'active', deleted_at: null });

    const base = {
      kind: 'email' as const,
      subject: null,
      email: 'claimed@example.com',
      linked_at: 0,
      linked_via: null,
      last_used_at: null,
    };
    await store.insertIdentity({ ...base, id: 'i1', aba_user_id: 'usr_1', email_verified: false });
    // An unverified row must not be able to reserve an address somebody else
    // can prove they control.
    await store.insertIdentity({ ...base, id: 'i2', aba_user_id: 'usr_2', email_verified: true });
  });
});
