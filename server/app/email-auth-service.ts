/**
 * Email OTP sign-in: start, and verify.
 *
 * Two steps, against the Google flow's three, because there is no external
 * authorization server and therefore no redirect to come back from. The proof
 * of control is the code, and the code goes to the mailbox.
 *
 * ## What it reuses, and why nothing is duplicated
 *
 * There is exactly one authentication architecture in this backend, and this
 * is a second **method** inside it rather than a second copy of it. Account
 * creation is `AccountService`, identity resolution and attachment is
 * `IdentityService` (including the linking rules and the `IDENTITY_IN_USE`
 * refusal), sessions, rotation, reuse detection and revocation are
 * `SessionService`, device association is `DeviceService`, and authorization
 * is `Principal`. None of it is reimplemented here; this module supplies a
 * `VerifiedIdentity` and lets the existing machinery do the rest — the same
 * contract `identity-service.ts` was written against before either external
 * flow existed.
 *
 * ## The email policy is the ratified one, unchanged
 *
 * Addresses are canonicalised by `normaliseEmail` — local part preserved
 * byte for byte, domain lowercased, surrounding whitespace trimmed, interior
 * whitespace refused — and by nothing else. There is no dot stripping, no
 * `+tag` removal, no provider-specific rewriting and no Unicode
 * normalisation, because each of those is a guess about somebody else's mail
 * server and the failure mode of guessing wrong is merging two people into
 * one account.
 *
 * An email identity is `kind: 'email'`, `subject: null`. It therefore occupies
 * the subjectless branch of `auth_identity_email_key`, which is what makes
 * "one account per verified address" a constraint rather than a convention.
 * It never resolves a `google` row carrying the same address, and a `google`
 * assertion never resolves one of these: a shared string is not a proof of
 * either (AUTH-27).
 *
 * ## Unicode and IDN are open, so non-ASCII addresses are refused
 *
 * Whether `é` and its decomposed form are one address, and whether a
 * punycode domain and its Unicode spelling are one domain, are **open**
 * questions this phase was told not to settle. Accepting such an address now
 * would settle them by default — whatever bytes arrived would become the
 * stored identity, and any later normalisation rule would then either merge
 * two existing accounts or split one.
 *
 * So `start` refuses a non-ASCII address. Refusing is reversible and merging
 * is not, which is the same asymmetry that decided the local-part rule. This
 * is a stated limitation of the current build, not a decision about the
 * policy, and it is reported as one.
 *
 * ## Enumeration
 *
 * `start` performs **no account lookup at all**. It does not ask whether the
 * address is known, because it does not need to: an account is created at
 * verification, once control has been proved. There is therefore no
 * account-dependent branch, no account-dependent work and no account-
 * dependent response — which is a stronger statement than "the responses look
 * the same", and it is the one this module makes. It is not a claim about
 * wall-clock indistinguishability under load, which nothing here measures.
 */
import { fail, ok, type Result } from '../domain/errors';
import { newOtpChallengeId, isDeviceId } from '../domain/ids';
import { newOtpCode, isOtpShape } from './otp';
import { normaliseEmail, type IdentityService } from './identity-service';
import { otpMessage, type EmailDelivery } from './email-delivery';
import type { MemoryRateLimiter, RateLimitRule } from './rate-limiter';
import type { OtpChallengeStore } from './otp-challenge-store';
import type { Clock } from '../domain/clock';
import type { Store } from '../db/store';
import type { AccountService } from './account-service';
import type { IssuedSession, SessionService } from './session-service';
import type { DeviceService } from './device-service';
import type { ServerLogger } from '../logging';

/** How long a code is good for. Ten minutes, from the phase specification. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** Verification attempts before the challenge dies. Five, likewise. */
export const MAX_OTP_ATTEMPTS = 5;

/** Live challenges held at once. A bound on what an unauthenticated caller may allocate. */
export const OTP_CHALLENGE_CAPACITY = 10_000;

/**
 * The limits.
 *
 * Small integers over a quarter of an hour, chosen so an honest person who
 * mistypes their address twice and asks for a resend is never stopped, and a
 * caller trying to mail somebody fifty times is stopped within seconds.
 */
export const OTP_LIMITS = {
  /** Codes sent to one address. The anti-mail-bomb limit. */
  startPerEmail: { limit: 5, windowMs: 15 * 60 * 1000 },
  /** Codes started by one caller, whatever address they name. */
  startPerSource: { limit: 20, windowMs: 15 * 60 * 1000 },
  /** Verifications attempted by one caller, across all challenges. */
  verifyPerSource: { limit: 50, windowMs: 15 * 60 * 1000 },
  /**
   * The resend floor: one code per address per thirty seconds.
   *
   * Separate from `startPerEmail` because it answers a different question.
   * The per-window limit bounds the total; this bounds the *rate*, so a
   * client whose retry loop misfires cannot spend the whole allowance in one
   * second and leave the person unable to sign in for fifteen minutes.
   */
  resendCooldown: { limit: 1, windowMs: 30 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

const BUCKET = {
  startEmail: 'otp.start.email',
  startSource: 'otp.start.source',
  verifySource: 'otp.verify.source',
  resend: 'otp.resend',
} as const;

/**
 * The longest address this accepts.
 *
 * 254 is the RFC 5321 ceiling on a path. It is a bound on memory rather than
 * a statement about validity: an address nobody can send to is not worth a
 * challenge, and an unbounded string on an unauthenticated route is not worth
 * accepting at all.
 */
const MAX_EMAIL_LENGTH = 254;

/** ASCII printable, excluding space. See the module note on Unicode. */
const ASCII_ONLY = /^[\x21-\x7e]+$/;

/**
 * Is this an address this build will send a code to?
 *
 * Shape only, and deliberately shallow: a full RFC 5322 grammar accepts
 * things no mail system routes and rejects things some do, and the real
 * validation is that a code arrives. What is checked is what would otherwise
 * become a stored identity that no proof could ever correspond to.
 */
export function isDeliverableEmail(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  if (!ASCII_ONLY.test(value)) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  // A domain with no dot is a local hostname, not a deliverable address, and
  // one with a leading or trailing dot is not a name at all.
  if (!domain.includes('.')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  // One `@` in the domain half would make the split ambiguous for anything
  // reading it later.
  if (domain.includes('@')) return false;
  return true;
}

/** Why a start did not produce a challenge. None of these names an account. */
export type EmailStartRefusal =
  /** The address is not one this build will send to. Says nothing about accounts. */
  | 'INVALID_EMAIL'
  | 'RATE_LIMITED'
  /** A code could not be handed to the mail transport. */
  | 'DELIVERY_FAILED'
  /** The transient store is full of live challenges. */
  | 'BUSY';

export type EmailStartOutcome =
  | {
      readonly kind: 'sent';
      readonly challengeId: string;
      readonly expiresAt: number;
      /** When another code may be requested for this address. */
      readonly resendAvailableAt: number;
    }
  | {
      readonly kind: 'refused';
      readonly reason: EmailStartRefusal;
      /** Set for `RATE_LIMITED`; `null` otherwise. */
      readonly retryAfterMs: number | null;
    };

/**
 * Why a verification did not produce a session.
 *
 * Every one of these is a fact about **the challenge the caller already
 * holds**, and none is a fact about any account. The challenge id is a
 * 128-bit opaque value this server minted and handed to exactly one client,
 * so telling that client its own code expired reveals nothing to anybody
 * else — and refusing to tell them would make the difference between "type
 * it again" and "ask for a new one" unguessable.
 *
 * `UNAVAILABLE` is the deliberate catch-all for the outcomes that *would*
 * reveal something: an address already held as an identity by another
 * account, and an account in the deleted state. Both are collapsed.
 */
export type EmailVerifyRefusal =
  'INVALID_CODE' | 'EXPIRED' | 'ATTEMPTS_EXHAUSTED' | 'RATE_LIMITED' | 'UNAVAILABLE';

export type EmailVerifyOutcome =
  | {
      readonly kind: 'verified';
      readonly session: IssuedSession;
      /** True when this sign-in created the account rather than returning to one. */
      readonly created: boolean;
      readonly deviceRegistered: boolean;
      /** The canonical address, for the client to display. */
      readonly email: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: EmailVerifyRefusal;
      /** Attempts left on this challenge, where that is meaningful. */
      readonly remainingAttempts: number | null;
      readonly retryAfterMs: number | null;
    };

export interface EmailAuthServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly log: ServerLogger;
  readonly challenges: OtpChallengeStore;
  readonly limiter: MemoryRateLimiter;
  readonly delivery: EmailDelivery;
  readonly accounts: AccountService;
  readonly identities: IdentityService;
  readonly sessions: SessionService;
  readonly devices: DeviceService;
  readonly ttlMs?: number;
}

export class EmailAuthService {
  private readonly ttl: number;

  constructor(private readonly options: EmailAuthServiceOptions) {
    this.ttl = options.ttlMs ?? OTP_TTL_MS;
  }

  /**
   * Mints a code and sends it.
   *
   * `source` is the deployment's notion of who is calling — whatever it uses
   * to tell one client from another. It is used for rate limiting and for
   * nothing else: it is never stored, never logged, never compared against an
   * account, and authorises nothing. A deployment that cannot distinguish
   * callers supplies a constant and gets one shared bucket, which is a weaker
   * limit and is its own decision to make.
   */
  async start(params: {
    readonly email: string;
    readonly source: string;
  }): Promise<Result<EmailStartOutcome>> {
    const raw = params.email.trim();
    const email = normaliseEmail(raw);
    if (!isDeliverableEmail(email)) {
      return ok({ kind: 'refused', reason: 'INVALID_EMAIL', retryAfterMs: null });
    }

    // Source first. A caller flooding many addresses is stopped before any of
    // those addresses has its own allowance touched, so one attacker cannot
    // lock a hundred strangers out by spending their per-address budget.
    const perSource = this.options.limiter.consume(
      BUCKET.startSource,
      params.source,
      OTP_LIMITS.startPerSource,
    );
    if (!perSource.allowed) return this.refuseStart('source', perSource.retryAfterMs);

    const cooldown = this.options.limiter.consume(BUCKET.resend, email, OTP_LIMITS.resendCooldown);
    if (!cooldown.allowed) return this.refuseStart('cooldown', cooldown.retryAfterMs);

    const perEmail = this.options.limiter.consume(
      BUCKET.startEmail,
      email,
      OTP_LIMITS.startPerEmail,
    );
    if (!perEmail.allowed) return this.refuseStart('email', perEmail.retryAfterMs);

    const now = this.options.clock.now();
    const code = newOtpCode();
    const id = newOtpChallengeId();

    // Issuing replaces every open challenge for this address, so the previous
    // code stops working the instant this one is minted.
    const issued = await this.options.challenges.issue({
      id,
      email,
      code,
      issuedAt: now,
      expiresAt: now + this.ttl,
      attempts: 0,
    });
    if (issued.kind === 'at_capacity') {
      this.options.log.warn('auth.email.start.refused', { reason: 'at_capacity' });
      return ok({ kind: 'refused', reason: 'BUSY', retryAfterMs: null });
    }

    const delivered = await this.deliver(email, code);
    if (!delivered) {
      // Nobody received this code, so nothing should be able to present it.
      await this.options.challenges.discard(id);
      this.options.log.warn('auth.email.delivery.failed', { emailDomain: domainOf(email) });
      return ok({ kind: 'refused', reason: 'DELIVERY_FAILED', retryAfterMs: null });
    }

    // The domain, never the address, and never the code: `LOGGABLE_FIELDS`
    // has no entry either could travel in.
    this.options.log.info('auth.email.start', {
      challengeId: id,
      emailDomain: domainOf(email),
    });
    return ok({
      kind: 'sent',
      challengeId: id,
      expiresAt: issued.challenge.expiresAt,
      resendAvailableAt: now + OTP_LIMITS.resendCooldown.windowMs,
    });
  }

  /**
   * Presents a code, and on a match establishes a session.
   *
   * The order is the security. The attempt is counted and the challenge
   * consumed **inside the store**, synchronously, before this method does any
   * further work — so two concurrent presentations of one valid code produce
   * at most one success, and a replay of a spent code finds nothing. Only
   * after that does an account come into existence.
   */
  async verify(params: {
    readonly challengeId: string;
    readonly code: string;
    readonly source: string;
    readonly deviceId?: string;
  }): Promise<Result<EmailVerifyOutcome>> {
    const perSource = this.options.limiter.consume(
      BUCKET.verifySource,
      params.source,
      OTP_LIMITS.verifyPerSource,
    );
    if (!perSource.allowed) {
      this.options.log.warn('auth.email.verify.refused', { reason: 'rate_limited' });
      return ok({
        kind: 'refused',
        reason: 'RATE_LIMITED',
        remainingAttempts: null,
        retryAfterMs: perSource.retryAfterMs,
      });
    }

    const now = this.options.clock.now();
    // A malformed code still reaches the store and still spends an attempt.
    // It can never match, so counting it costs an attacker rather than
    // saving them one — and the challenge id they would need in order to burn
    // somebody else's attempts is a value only that person's client holds.
    const attempt = await this.options.challenges.attempt(
      params.challengeId,
      isOtpShape(params.code) ? params.code : '',
      now,
    );

    switch (attempt.kind) {
      case 'unknown':
        // Never existed, already spent, already expired away. One answer for
        // all three: distinguishing them would say whether a challenge id was
        // ever real.
        this.options.log.warn('auth.email.verify.refused', { reason: 'unknown' });
        return this.refuseVerify('EXPIRED', null);
      case 'expired':
        this.options.log.warn('auth.email.verify.refused', { reason: 'expired' });
        return this.refuseVerify('EXPIRED', null);
      case 'exhausted':
        this.options.log.warn('auth.email.verify.refused', { reason: 'exhausted' });
        return this.refuseVerify('ATTEMPTS_EXHAUSTED', 0);
      case 'mismatch':
        this.options.log.warn('auth.email.verify.refused', { reason: 'mismatch' });
        return this.refuseVerify('INVALID_CODE', attempt.remainingAttempts);
      case 'verified':
        break;
    }

    const email = attempt.challenge.email;
    const resolved = await this.resolveAccount(email);
    if (!resolved.ok) {
      // An address held by another account, or an account in the deleted
      // state. Collapsed: either answer would be an oracle, and the challenge
      // is already spent so neither can be probed twice.
      this.options.log.warn('auth.email.verify.refused', { errorCode: resolved.error.code });
      return this.refuseVerify('UNAVAILABLE', null);
    }

    const issued = await this.options.sessions.createSession({
      abaUserId: resolved.value.abaUserId,
      authIdentityId: resolved.value.authIdentityId,
    });
    if (!issued.ok) return this.refuseVerify('UNAVAILABLE', null);

    const identity = await this.options.store.getIdentity(resolved.value.authIdentityId);
    const created = identity !== null && identity.last_used_at === null;
    if (identity !== null) await this.options.store.touchIdentity(identity.id, now);

    const deviceRegistered = await this.registerDevice(issued.value.sessionId, params.deviceId);

    // A completed sign-in clears the address's own cooldown and send budget:
    // the budget exists to stop unwanted mail, and mail that led to a
    // successful sign-in was wanted. The per-source verify counter is left
    // alone, because a success does not make the next thousand attempts
    // legitimate.
    this.options.limiter.reset(BUCKET.resend, email);
    this.options.limiter.reset(BUCKET.startEmail, email);

    this.options.log.info('auth.email.verify', {
      challengeId: attempt.challenge.id,
      abaUserId: issued.value.abaUserId,
      sessionId: issued.value.sessionId,
      emailDomain: domainOf(email),
    });
    return ok({
      kind: 'verified',
      session: issued.value,
      created,
      deviceRegistered,
      email,
    });
  }

  /** Removes challenges past their life. Codes do not outlive their purpose. */
  async sweep(): Promise<number> {
    return this.options.challenges.purgeExpired(this.options.clock.now());
  }

  /**
   * Finds or creates the account for a verified address.
   *
   * The mirror of `GoogleAuthService.resolveAccount`, and the differences are
   * the ones the kind requires: there is no subject, so the verified address
   * **is** the authority, and the lookup is scoped to `kind: 'email'` so a
   * Google row carrying the same address is not a match.
   *
   * Creation goes through `IdentityService.attachIdentity` rather than
   * writing a row, so the linking rules, the `IDENTITY_IN_USE` refusal and
   * the uniqueness race are all the tested ones.
   */
  private async resolveAccount(
    email: string,
  ): Promise<Result<{ readonly abaUserId: string; readonly authIdentityId: string }>> {
    const existing = await this.options.store.findIdentityByVerifiedEmail('email', email);
    if (existing !== null) {
      const account = await this.options.store.getUser(existing.aba_user_id);
      if (account === null) return fail('NOT_FOUND');
      if (account.state === 'deleted') return fail('ACCOUNT_DELETED');
      return ok({ abaUserId: account.id, authIdentityId: existing.id });
    }

    const account = await this.options.accounts.createAccount();
    const session = await this.options.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!session.ok) return fail(session.error.code);
    const principal = await this.options.sessions.verify(session.value.sessionId);
    if (!principal.ok) return fail(principal.error.code);

    const attached = await this.options.identities.attachIdentity(principal.value, {
      kind: 'email',
      subject: null,
      email,
      // The code proved control of this mailbox. That is precisely what
      // `emailVerified` asserts, and it is the only thing that may set it.
      emailVerified: true,
    });

    // The bootstrap session existed only to obtain a principal for the
    // attach, exactly as in the Google flow. Revoked whatever happened next.
    await this.options.store.revokeSession(
      principal.value.sessionId,
      this.options.clock.now(),
      'bootstrap',
    );

    if (!attached.ok) return fail(attached.error.code);
    return ok({ abaUserId: account.id, authIdentityId: attached.value.id });
  }

  /**
   * Associates this installation with the account, after the session exists.
   *
   * Identical in shape and in consequence to the Google flow's: through a
   * `Principal` minted from the new session, shape-checked only, and a
   * failure here never fails the sign-in.
   */
  private async registerDevice(sessionId: string, deviceId: string | undefined): Promise<boolean> {
    if (deviceId === undefined) return false;
    if (!isDeviceId(deviceId)) {
      this.options.log.warn('auth.device.rejected', { sessionId });
      return false;
    }
    const principal = await this.options.sessions.verify(sessionId);
    if (!principal.ok) return false;
    const registered = await this.options.devices.registerDevice(principal.value, deviceId);
    return registered.ok;
  }

  /** Hands the message to the transport. A throwing adapter is a failed send. */
  private async deliver(email: string, code: string): Promise<boolean> {
    try {
      return await this.options.delivery.send(
        otpMessage(email, code, Math.round(this.ttl / 60000)),
      );
    } catch {
      return false;
    }
  }

  private refuseStart(reason: string, retryAfterMs: number): Result<EmailStartOutcome> {
    this.options.log.warn('auth.email.start.refused', { reason });
    return ok({ kind: 'refused', reason: 'RATE_LIMITED', retryAfterMs });
  }

  private refuseVerify(
    reason: EmailVerifyRefusal,
    remainingAttempts: number | null,
  ): Result<EmailVerifyOutcome> {
    return ok({ kind: 'refused', reason, remainingAttempts, retryAfterMs: null });
  }
}

/** Everything after the last `@`. Loggable; the address is not. */
function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}
