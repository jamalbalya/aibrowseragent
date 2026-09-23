/**
 * Authentication identities: resolution, attachment and removal.
 *
 * This is where the approved account-linking policy lives as code. The four
 * rules it enforces, each stated as the thing it makes impossible:
 *
 *  - **Resolution never links.** `resolveIdentity` returns an existing owner
 *    or reports that there is none. It never attaches an identity to an
 *    account that happens to share an email address.
 *  - **Attachment needs two proofs.** `attachIdentity` takes a `Principal` —
 *    obtainable only from a verified session on the target account — and a
 *    `VerifiedIdentity`, which the caller can only produce by completing that
 *    identity's own flow. Neither alone reaches this method.
 *  - **An identity never moves.** `aba_user_id` is write-once in the schema,
 *    so reassignment is not an update the store will perform. When an
 *    identity is already attached elsewhere, the answer is `IDENTITY_IN_USE`
 *    and nothing is written (AUTH-23).
 *  - **The last identity cannot be removed.** Unlinking is refused when it
 *    would leave the account with no verified way to sign in (AUTH-25).
 *
 * The external flows — Google's authorization code exchange, the email OTP —
 * are **not** here. They produce a `VerifiedIdentity`; this module consumes
 * one. That boundary is what lets the linking rules be complete and tested
 * while those integrations do not yet exist.
 */
import { fail, ok, type Result } from '../domain/errors';
import { newAuthIdentityId } from '../domain/ids';
import type { Clock } from '../domain/clock';
import type { AuthIdentityKind } from '../db/schema';
import { ConstraintViolation, type AuthIdentityRow, type Store } from '../db/store';
import type { Principal } from '../domain/authorization';
import type { ServerLogger } from '../logging';

/**
 * Proof that someone controls an external identity.
 *
 * Produced **only** by a completed authentication flow. The type is the
 * contract: a caller that has not run such a flow has no way to make one, so
 * "ownership was proved by a matching email string" is not a mistake the
 * service can be talked into — the string alone does not have this type
 * (AUTH-27).
 */
export interface VerifiedIdentity {
  readonly kind: AuthIdentityKind;
  /** The provider's stable subject, where the kind has one. */
  readonly subject: string | null;
  /** The address, already normalised by `normaliseEmail`. */
  readonly email: string | null;
  /**
   * Always `true` in practice: an unverified assertion is not a proof and
   * must not reach this module. The field exists so the refusal is explicit
   * and testable rather than assumed (AUTH-18).
   */
  readonly emailVerified: boolean;
}

/**
 * Canonicalises an address for comparison: **the domain folds, the local part
 * does not.**
 *
 * Only transformations that are true for every mail system are applied, and
 * exactly two are: surrounding whitespace is not part of an address, and the
 * domain is a DNS name, which is case-insensitive by definition. Everything
 * left of the last `@` is carried through byte for byte.
 *
 * **Why the local part is not folded.** RFC 5321 §2.4 makes it case-sensitive
 * and reserves its interpretation to the destination host, so folding it is a
 * guess about somebody else's mail server. Almost every provider does fold —
 * but "almost every" is what makes it provider-specific rather than
 * universal, and the two failure modes are not symmetric:
 *
 *  - folding a domain that distinguishes `Alice@x` from `alice@x` **merges two
 *    people into one account**, which is unrecoverable and is the failure this
 *    design refuses everywhere else;
 *  - not folding, on the overwhelmingly common case-insensitive host, **splits
 *    one person into two accounts** — visible, annoying, and repairable by the
 *    explicit link flow (§20).
 *
 * Not merging is the safe failure, so the same rule that keeps dots and
 * `+tags` intact keeps case intact: no dot stripping, no `+tag` removal, no
 * case folding below the `@`. The local part is opaque.
 *
 * **This is canonicalisation, not validation.** It never rejects and never
 * removes anything a caller might have meant; `isUsable` does the refusing,
 * and the two are kept apart so that "what an address means" cannot quietly
 * become "what we were willing to accept".
 */
export function normaliseEmail(value: string): string {
  const trimmed = value.trim();
  // The **last** `@`: a quoted local part may legally contain one, and the
  // domain is what follows the final separator.
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, at)}${trimmed.slice(at).toLowerCase()}`;
}

/**
 * Interior whitespace is **refused, not removed**.
 *
 * A space inside an address is either a typo or a quoted local part, and the
 * two are indistinguishable from here. Stripping it would silently turn one
 * address into a different one and then send a proof of control to whichever
 * mailbox the edited version reaches — so this is validation, and the answer
 * is no rather than a guess.
 */
const INTERIOR_WHITESPACE = /\s/u;

/** What `resolveIdentity` found. */
export type IdentityResolution =
  | { readonly kind: 'existing'; readonly abaUserId: string; readonly identity: AuthIdentityRow }
  | { readonly kind: 'unknown' };

export interface IdentityServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly log: ServerLogger;
}

export class IdentityService {
  constructor(private readonly options: IdentityServiceOptions) {}

  /**
   * Finds the account an identity already resolves to.
   *
   * Subject first, then verified email — the order from
   * IDENTITY_AUTH_ARCHITECTURE §4.3. Matching on email first would move an
   * account whenever an address was reassigned; matching on an *unverified*
   * address at all is the pre-hijack attack.
   *
   * Returns `unknown` rather than creating anything. Whether a miss becomes a
   * new account is the caller's decision, and separating the two is what
   * keeps resolution from silently linking.
   */
  async resolveIdentity(verified: VerifiedIdentity): Promise<Result<IdentityResolution>> {
    if (!this.isUsable(verified)) return fail('INVALID_ARGUMENT');

    // A kind has exactly one authoritative identifier, and resolution uses
    // that one and no other.
    //
    // Where the kind has a subject, the subject **is** the identity and the
    // address is metadata that happens to travel with it. Falling back to the
    // address when the subject misses is the account-ownership defect this
    // rule exists to close: a domain can reassign a verified address to a
    // different person, who arrives with a new subject and the old address,
    // and an email fallback hands them the previous owner's account.
    //
    // Subject-first ordering does not help, because ordering only decides
    // which of two matches wins — it does nothing when the subject has no
    // match at all, which is exactly the reassignment case.
    //
    // Where the kind has no subject the verified address is the authority,
    // and the lookup is still scoped to that kind: an `email` assertion never
    // resolves a `google` row that carries the same address, and vice versa.
    // The two are different proofs of different things, and a shared string
    // is not a proof of either (AUTH-27).
    if (verified.subject !== null) {
      const bySubject = await this.options.store.findIdentityBySubject(
        verified.kind,
        verified.subject,
      );
      return bySubject
        ? ok({ kind: 'existing', abaUserId: bySubject.aba_user_id, identity: bySubject })
        : ok({ kind: 'unknown' });
    }

    if (verified.email !== null && verified.emailVerified) {
      const byEmail = await this.options.store.findIdentityByVerifiedEmail(
        verified.kind,
        verified.email,
      );
      if (byEmail) {
        return ok({ kind: 'existing', abaUserId: byEmail.aba_user_id, identity: byEmail });
      }
    }

    return ok({ kind: 'unknown' });
  }

  /**
   * Attaches a verified identity to the principal's account.
   *
   * Used both for the first identity on a new account and for a later link;
   * the rules are identical, which is why there is one method. Idempotent
   * when the identity is already on **this** account, so a retried link is
   * not an error a person has to interpret.
   */
  async attachIdentity(
    principal: Principal,
    verified: VerifiedIdentity,
  ): Promise<Result<AuthIdentityRow>> {
    if (!this.isUsable(verified)) return fail('INVALID_ARGUMENT');

    const account = await this.options.store.getUser(principal.abaUserId);
    if (account === null) return fail('NOT_FOUND');
    if (account.state === 'deleted') return fail('ACCOUNT_DELETED');

    const resolved = await this.resolveIdentity(verified);
    if (!resolved.ok) return fail(resolved.error.code);

    if (resolved.value.kind === 'existing') {
      if (resolved.value.abaUserId === principal.abaUserId) {
        // Already ours. A no-op success, not an error.
        return ok(resolved.value.identity);
      }
      // Attached to another account. Refuse, write nothing, and say nothing
      // about which account holds it (AUTH-28).
      this.options.log.warn('identity.link.refused', {
        abaUserId: principal.abaUserId,
        reason: 'identity_in_use',
      });
      return fail('IDENTITY_IN_USE');
    }

    const row: AuthIdentityRow = {
      id: newAuthIdentityId(),
      aba_user_id: principal.abaUserId,
      kind: verified.kind,
      subject: verified.subject,
      email: verified.email,
      email_verified: verified.emailVerified,
      linked_at: this.options.clock.now(),
      linked_via: principal.sessionId,
      last_used_at: null,
    };
    try {
      await this.options.store.insertIdentity(row);
    } catch (error) {
      // A uniqueness constraint refused the row, so somebody already holds
      // this identifier and resolution did not see them.
      //
      // That gap is reachable for a subject-bearing kind, because resolution
      // matches on the subject while the table also holds `(kind, email)`
      // unique: two Google subjects that carry the same verified address —
      // which a domain reassignment produces — resolve as unknown and then
      // collide on insert. Refusing is the conservative answer, and it is the
      // same refusal §20.4.1 already specifies: it names no account and says
      // nothing about which field collided (AUTH-28).
      //
      // It is caught rather than pre-checked because only the write is
      // atomic: a check first would be a race, and a race here would let two
      // concurrent links both believe they had won.
      if (!(error instanceof ConstraintViolation)) throw error;
      this.options.log.warn('identity.link.refused', {
        abaUserId: principal.abaUserId,
        reason: 'identity_in_use',
      });
      return fail('IDENTITY_IN_USE');
    }
    this.options.log.info('identity.linked', {
      abaUserId: principal.abaUserId,
      identityId: row.id,
      kind: row.kind,
    });
    return ok(row);
  }

  async listIdentities(principal: Principal): Promise<AuthIdentityRow[]> {
    return this.options.store.listIdentities(principal.abaUserId);
  }

  /**
   * Removes an identity from the principal's account.
   *
   * Two refusals, and both matter:
   *
   *  - an identity that is not on this account is `NOT_FOUND`, identically to
   *    one that does not exist, so unlinking cannot be used to discover whose
   *    an identity is;
   *  - the **last** verified identity cannot be removed, because the account
   *    and its ciphertext would then be unreachable by anybody, permanently.
   *
   * Sessions established through the removed identity are revoked: removing a
   * route in must remove the access it granted, or unlinking a compromised
   * identity would leave its sessions running. Sessions from a remaining
   * identity are untouched.
   *
   * Nothing else changes. No work, no device row, no other identity, and not
   * the account — unlinking is not deletion (AUTH-26).
   */
  async detachIdentity(
    principal: Principal,
    identityId: string,
  ): Promise<Result<{ readonly revokedSessions: number }>> {
    const identity = await this.options.store.getIdentity(identityId);
    if (identity === null || identity.aba_user_id !== principal.abaUserId) return fail('NOT_FOUND');

    const remaining = (await this.options.store.listIdentities(principal.abaUserId)).filter(
      (row) => row.id !== identityId && this.isVerified(row),
    );
    if (remaining.length === 0) return fail('LAST_IDENTITY');

    const at = this.options.clock.now();
    // Revoke **before** deleting, and the order is load-bearing rather than
    // stylistic. `session.auth_identity_id` is `ON DELETE SET NULL`, so
    // removing the identity first clears the very column the revocation
    // selects on, and the sessions it established would survive unrevoked —
    // the opposite of what unlinking a compromised identity is for.
    const revokedSessions = await this.options.store.revokeForIdentity(
      identityId,
      at,
      'identity_unlinked',
    );
    await this.options.store.deleteIdentity(identityId);
    this.options.log.info('identity.unlinked', {
      abaUserId: principal.abaUserId,
      identityId,
      sessionsRevoked: revokedSessions,
    });
    return ok({ revokedSessions });
  }

  /** A row that can actually be signed in with. */
  private isVerified(row: AuthIdentityRow): boolean {
    if (row.subject !== null) return true;
    return row.email !== null && row.email_verified;
  }

  /** An assertion that could not identify anybody is refused before any write. */
  private isUsable(verified: VerifiedIdentity): boolean {
    if (verified.subject === null && verified.email === null) return false;
    if (verified.email !== null) {
      if (!verified.emailVerified) return false;
      // Already canonical. A caller that has not applied `normaliseEmail` is
      // handing over an address this service would store under a different
      // key than it compares with.
      if (verified.email !== normaliseEmail(verified.email)) return false;
      if (verified.email.length === 0) return false;
      // Validation, deliberately after canonicalisation: `normaliseEmail`
      // trims the ends, so anything left is interior and is refused.
      if (INTERIOR_WHITESPACE.test(verified.email)) return false;
    }
    if (verified.subject !== null && verified.subject.length === 0) return false;
    return true;
  }
}
