/**
 * Session families: creation, rotation, verification and revocation.
 *
 * The lifetimes are the approved ones and are not re-decided here: access
 * ~15 minutes, refresh ~30 days rolling (IDENTITY_AUTH_ARCHITECTURE §6.1).
 *
 * Three properties carry the security of this module:
 *
 *  - **The refresh token is never stored.** Only a one-way digest is, so a
 *    stolen database yields nothing presentable (`token.ts`).
 *  - **Rotation is single-use.** Every refresh issues a new token and marks
 *    the presented row `rotated_at`. A row that already has one, presented
 *    again, is a *reuse* signal rather than a stale-token error.
 *  - **Reuse revokes the family.** Reuse means the token was captured, so the
 *    attacker and the user both hold one; revoking only the presented row
 *    would leave the thief's working (AUTH-16).
 *
 * Session fixation is prevented structurally: a session is only ever created
 * by `createSession`, which mints its own id and family id and accepts
 * neither from a caller. There is no path that adopts a client-supplied
 * identifier.
 */
import { fail, ok, type Result } from '../domain/errors';
import { newSessionFamilyId, newSessionId } from '../domain/ids';
import { principalFromSession, type Principal } from '../domain/authorization';
import { newRefreshToken, type TokenDigest } from './token';
import type { Clock } from '../domain/clock';
import { CURRENT_DIGEST_VERSION } from '../db/schema';
import type { SessionRow, Store } from '../db/store';
import type { ServerLogger } from '../logging';

/** Approved lifetimes (§6.1). Overridable for tests, never widened silently. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a caller receives when a session is created or rotated.
 *
 * `refreshToken` is the only place the raw token exists after generation. It
 * is returned once and is not recoverable afterwards, because the row holds a
 * digest.
 */
export interface IssuedSession {
  readonly sessionId: string;
  readonly abaUserId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: number;
  /**
   * When an access token issued now would expire.
   *
   * The access token itself is **not** minted here. It is a signed assertion,
   * and signing needs a key that `config.ts` requires to be injected — which
   * is transport and deployment work, not domain work. What this records is
   * the lifetime the transport must honour.
   */
  readonly accessExpiresAt: number;
}

export interface SessionServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly digest: TokenDigest;
  readonly log: ServerLogger;
  readonly accessTtlMs?: number;
  readonly refreshTtlMs?: number;
}

export class SessionService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(private readonly options: SessionServiceOptions) {
    this.accessTtl = options.accessTtlMs ?? ACCESS_TTL_MS;
    this.refreshTtl = options.refreshTtlMs ?? REFRESH_TTL_MS;
  }

  /**
   * Starts a new session family for an account.
   *
   * Called after an authentication has already succeeded. It does not verify
   * anything about *how*: that is the external flow's job, and this method
   * taking a verified account id rather than a credential is what keeps the
   * two separable.
   */
  async createSession(input: {
    readonly abaUserId: string;
    readonly authIdentityId: string | null;
  }): Promise<Result<IssuedSession>> {
    const user = await this.options.store.getUser(input.abaUserId);
    if (user === null) return fail('NOT_FOUND');
    if (user.state === 'deleted') return fail('ACCOUNT_DELETED');

    if (input.authIdentityId !== null) {
      const identity = await this.options.store.getIdentity(input.authIdentityId);
      // An identity from another account would mint a session whose recorded
      // provenance is a lie, and whose unlink revocation would then fire for
      // the wrong person.
      if (identity === null || identity.aba_user_id !== input.abaUserId) return fail('NOT_FOUND');
    }

    const now = this.options.clock.now();
    const token = newRefreshToken();
    const row: SessionRow = {
      id: newSessionId(),
      aba_user_id: input.abaUserId,
      auth_identity_id: input.authIdentityId,
      family_id: newSessionFamilyId(),
      refresh_digest: await this.options.digest.compute(token),
      digest_version: CURRENT_DIGEST_VERSION,
      issued_at: now,
      expires_at: now + this.refreshTtl,
      rotated_at: null,
      revoked_at: null,
      revoked_reason: null,
      last_seen_at: now,
    };
    await this.options.store.insertSession(row);
    this.options.log.info('session.created', {
      abaUserId: row.aba_user_id,
      sessionId: row.id,
      familyId: row.family_id,
    });
    return ok(this.issued(row, token, now));
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * The failure branches are the interesting part:
   *
   *  - no row for the digest → `AUTH_REQUIRED`. Nothing is revealed about
   *    whether the token was ever valid.
   *  - the row is already rotated → **reuse**. The family is revoked and the
   *    caller gets `SESSION_REVOKED`.
   *  - the row is revoked → `SESSION_REVOKED`, without re-revoking.
   *  - expired → `AUTH_REQUIRED`.
   *  - the account is deleted → `ACCOUNT_DELETED`, which is an answer and so
   *    never an outage (AUTH-14).
   *  - **the rotation claim is lost** → also reuse, for the same reason and
   *    with the same consequence. See the claim below.
   *
   * Single-use is enforced by an atomic claim rather than by the check above,
   * because a check that is not the write cannot decide a race.
   */
  async rotateSession(refreshToken: string): Promise<Result<IssuedSession>> {
    const digest = await this.options.digest.compute(refreshToken);
    const current = await this.options.store.findSessionByDigest(digest);
    if (current === null) return fail('AUTH_REQUIRED');

    const now = this.options.clock.now();

    if (current.rotated_at !== null) {
      const revoked = await this.options.store.revokeFamily(
        current.family_id,
        now,
        'refresh_reuse',
      );
      this.options.log.warn('session.refresh.reuse', {
        abaUserId: current.aba_user_id,
        familyId: current.family_id,
        sessionsRevoked: revoked,
      });
      return fail('SESSION_REVOKED');
    }
    if (current.revoked_at !== null) return fail('SESSION_REVOKED');
    if (now >= current.expires_at) return fail('AUTH_REQUIRED');

    const user = await this.options.store.getUser(current.aba_user_id);
    if (user === null) return fail('NOT_FOUND');
    if (user.state === 'deleted') return fail('ACCOUNT_DELETED');

    // The claim, and the reason it comes before the successor exists.
    //
    // Everything above this line is a read. Two concurrent presentations of
    // one refresh token both reach here having seen `rotated_at` as null, so
    // a check is not enough: without an atomic claim both would mint a
    // successor and one single-use token would have produced two independently
    // valid sessions, neither detected as reuse. That is the property §6.3
    // exists to guarantee, so the claim is what decides, not the check.
    //
    // The loser is treated as reuse, because from here a genuine race and a
    // stolen token presented a moment behind the real one are the same
    // observation — and the safe reading of an ambiguous one is the hostile
    // reading. It costs an honest double-submit a re-authentication; it costs
    // a thief the whole family.
    //
    // The ordering trade is deliberate and is the reverse of what stood here
    // before. Claiming first means a failure between the claim and the insert
    // leaves the user with neither token, and they sign in again. Claiming
    // last meant a race left an attacker with a valid session. An availability
    // cost in a rare window beats a security hole in a common one.
    const claimed = await this.options.store.claimSessionRotation(current.id, now);
    if (!claimed) {
      const revoked = await this.options.store.revokeFamily(
        current.family_id,
        now,
        'refresh_reuse',
      );
      this.options.log.warn('session.refresh.reuse', {
        abaUserId: current.aba_user_id,
        familyId: current.family_id,
        sessionsRevoked: revoked,
      });
      return fail('SESSION_REVOKED');
    }

    const token = newRefreshToken();
    const next: SessionRow = {
      id: newSessionId(),
      aba_user_id: current.aba_user_id,
      auth_identity_id: current.auth_identity_id,
      // Same family: rotation continues a chain, it does not start one. That
      // is what lets a later reuse of any earlier member revoke the lot.
      family_id: current.family_id,
      refresh_digest: await this.options.digest.compute(token),
      digest_version: CURRENT_DIGEST_VERSION,
      issued_at: now,
      // Rolling: an actively used session does not expire, an idle one does.
      expires_at: now + this.refreshTtl,
      rotated_at: null,
      revoked_at: null,
      revoked_reason: null,
      last_seen_at: now,
    };
    await this.options.store.insertSession(next);

    // The second half of the race, which the claim alone does not close.
    //
    // The loser revokes the family, and it can do so *before* this successor
    // exists — in which case `revokeFamily` walked a set that did not include
    // it, and the winner would walk away with a session that survived the
    // revocation meant to stop exactly that. So the row we claimed is re-read:
    // if it was revoked while we were inserting, the revocation was aimed at
    // this family and this successor is part of it.
    //
    // Re-revoking is cheap and idempotent. Missing this is not.
    const claimedRow = await this.options.store.getSession(current.id);
    if (claimedRow !== null && claimedRow.revoked_at !== null) {
      const revoked = await this.options.store.revokeFamily(
        current.family_id,
        now,
        'refresh_reuse',
      );
      this.options.log.warn('session.refresh.reuse', {
        abaUserId: current.aba_user_id,
        familyId: current.family_id,
        sessionsRevoked: revoked,
      });
      return fail('SESSION_REVOKED');
    }

    this.options.log.info('session.rotated', {
      abaUserId: next.aba_user_id,
      sessionId: next.id,
      familyId: next.family_id,
    });
    return ok(this.issued(next, token, now));
  }

  /**
   * Turns a session id into a `Principal`, or refuses.
   *
   * This is the only route to a `Principal`, and therefore the only route to
   * any authorized operation. It re-reads the account every time: a session
   * row outlives the account it names by exactly as long as nobody checks.
   */
  async verify(sessionId: string): Promise<Result<Principal>> {
    const session = await this.options.store.getSession(sessionId);
    if (session === null) return fail('AUTH_REQUIRED');
    if (session.revoked_at !== null) return fail('SESSION_REVOKED');

    const now = this.options.clock.now();
    if (now >= session.expires_at) return fail('AUTH_REQUIRED');

    const user = await this.options.store.getUser(session.aba_user_id);
    if (user === null) return fail('NOT_FOUND');
    return principalFromSession(session, user);
  }

  /** Signs out one session. Deletes nothing (AUTH-9). */
  async revokeSession(principal: Principal): Promise<Result<void>> {
    await this.options.store.revokeSession(principal.sessionId, this.options.clock.now(), 'logout');
    this.options.log.info('session.revoked', {
      abaUserId: principal.abaUserId,
      sessionId: principal.sessionId,
    });
    return ok(undefined);
  }

  /** Signs out everywhere. Still deletes nothing. */
  async revokeAllSessions(principal: Principal): Promise<Result<{ readonly revoked: number }>> {
    const revoked = await this.options.store.revokeAllForUser(
      principal.abaUserId,
      this.options.clock.now(),
      'logout_all',
    );
    this.options.log.info('session.revoked.all', { abaUserId: principal.abaUserId, revoked });
    return ok({ revoked });
  }

  private issued(row: SessionRow, token: string, now: number): IssuedSession {
    return {
      sessionId: row.id,
      abaUserId: row.aba_user_id,
      refreshToken: token,
      refreshExpiresAt: row.expires_at,
      accessExpiresAt: now + this.accessTtl,
    };
  }
}
