/**
 * Where an in-flight email OTP lives: **process memory, and nowhere else.**
 *
 * ## Why this is not a table
 *
 * Every other piece of authentication state in this backend is a row in
 * `schema.ts`, enforced by `MemoryStore` and rendered into DDL by `sql.ts`.
 * An OTP challenge deliberately is not, and the reason is the size of the
 * secret it holds.
 *
 * A refresh token is 256 bits of CSPRNG output, so storing its digest is a
 * real defence: an attacker holding the database cannot recover the token. A
 * six-digit code has a million candidates. Any representation of it that
 * reaches durable storage — the code, a hash of the code, a digest with a
 * salt — falls to a search that finishes before the page loads. There is no
 * hash that fixes this, which is why `token.ts`'s note about introducing
 * Argon2id for this phase was **not** acted on: the primitive was never the
 * problem.
 *
 * So the code is classified TRANSIENT and the classification is enforced
 * structurally rather than by care: there is no table, no column, no
 * migration, no `Store` method and no serialisation anywhere in this module.
 * A process restart loses every open challenge, and that is the correct
 * behaviour — the user asks for a new code, which costs one email.
 *
 * ## Atomicity
 *
 * `attempt` is the only operation that can complete a sign-in, and it must be
 * atomic: two requests presenting one valid code must produce **at most one**
 * success. It achieves that by doing all of its reading, counting and
 * removal in a single synchronous block with no `await` inside it. JavaScript
 * runs that block to completion before any other task, so the second caller
 * necessarily observes the challenge already gone.
 *
 * That is a genuine guarantee for a single-process, in-memory store, and it
 * is **not** a guarantee across processes. A multi-instance deployment would
 * need a shared store with a compare-and-set, exactly as
 * `Store.claimSessionRotation` documents for sessions. This module says so
 * rather than implying more than it does.
 *
 * ## Memory is bounded
 *
 * An unauthenticated endpoint that allocates per request is a denial-of-
 * service primitive. `capacity` caps the number of live challenges; expired
 * ones are pruned first, and when the store is genuinely full it **refuses**
 * rather than evicting, because evicting would let an attacker flush a
 * victim's in-flight sign-in by starting a thousand of their own.
 */
import { otpMatches } from './otp';

/** What a challenge is for. A link and a sign-in are not interchangeable. */
export type OtpPurpose = 'sign_in' | 'link';

/** One in-flight email flow. Never leaves the process. */
export interface OtpChallenge {
  readonly id: string;
  /** The address, already canonical per `normaliseEmail`. */
  readonly email: string;
  /**
   * Sign-in or link.
   *
   * Carried on the challenge rather than decided at redemption, because the
   * authorization for the two differs: a sign-in creates an account, a link
   * attaches to one that is already authenticated. A redemption path that
   * accepted either would let a proof obtained for one purpose be spent on
   * the other.
   */
  readonly purpose: OtpPurpose;
  /** The account a link attaches to. Non-null only for a link. */
  readonly abaUserId: string | null;
  /**
   * The code. **Read only by `attempt`**, which is why nothing else on this
   * interface returns a whole challenge to a caller.
   */
  readonly code: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Verification attempts made so far. Bounded by `maxAttempts`. */
  readonly attempts: number;
}

/** What a caller may know about a challenge without holding its code. */
export interface OtpChallengeView {
  readonly id: string;
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly abaUserId: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
}

export type OtpAttemptOutcome =
  /** No such challenge: never existed, already spent, expired away, or purged. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'mismatch'; readonly remainingAttempts: number }
  /** The one success. The challenge is already gone when this returns. */
  | { readonly kind: 'verified'; readonly challenge: OtpChallengeView };

export type OtpIssueOutcome =
  | { readonly kind: 'issued'; readonly challenge: OtpChallengeView }
  /** The store is at capacity with live challenges. Fails closed. */
  | { readonly kind: 'at_capacity' };

/**
 * The transient store, as a port.
 *
 * A port rather than a concrete class so that a deployment which genuinely
 * needs cross-process challenges can supply one — with the same atomicity
 * contract — without any caller changing. It is **not** a port so that a
 * durable implementation can be slotted in: a durable implementation would
 * violate the classification this module exists to enforce, and the interface
 * says so here rather than discovering it in review.
 */
export interface OtpChallengeStore {
  /**
   * Issues a challenge, replacing every open one for the same address.
   *
   * Replacement is the rule from the phase specification — "issuing a new OTP
   * invalidates the previous challenge" — and it lives here rather than in
   * the service so that it cannot be forgotten by a second call site. It also
   * closes an attack the obvious implementation has: if old challenges
   * survived, a resend loop would leave a growing set of simultaneously valid
   * codes for one address, and the attacker's chance of a blind guess would
   * grow with every resend.
   */
  issue(challenge: OtpChallenge): Promise<OtpIssueOutcome>;
  /** The public face of a challenge. Never returns the code. */
  peek(id: string): Promise<OtpChallengeView | null>;
  /** Atomic: counts the attempt, and consumes the challenge on a match. */
  attempt(id: string, code: string, now: number): Promise<OtpAttemptOutcome>;
  /** Drops a challenge outright — used when delivery failed. */
  discard(id: string): Promise<void>;
  /** Removes everything past its life. Returns how many went. */
  purgeExpired(now: number): Promise<number>;
  /** How many live challenges are held. For tests and for operational limits. */
  size(): number;
}

export interface MemoryOtpChallengeStoreOptions {
  /** Verification attempts before a challenge dies. */
  readonly maxAttempts: number;
  /** Maximum simultaneous live challenges. */
  readonly capacity: number;
}

/** Live challenges, keyed by id. The only place a code exists. */
export class MemoryOtpChallengeStore implements OtpChallengeStore {
  private readonly challenges = new Map<string, OtpChallenge>();

  constructor(private readonly options: MemoryOtpChallengeStoreOptions) {}

  issue(challenge: OtpChallenge): Promise<OtpIssueOutcome> {
    return run(() => {
      // Expired first: a store full of dead challenges is not a full store,
      // and pruning here means the sweep is an optimisation rather than a
      // correctness requirement.
      this.pruneExpired(challenge.issuedAt);
      // Then the address's own open challenges, whatever their state. This is
      // what makes the previous code stop working the instant a new one is
      // sent.
      for (const [id, existing] of this.challenges) {
        if (existing.email === challenge.email) this.challenges.delete(id);
      }
      if (this.challenges.size >= this.options.capacity) return { kind: 'at_capacity' };
      this.challenges.set(challenge.id, challenge);
      return { kind: 'issued', challenge: view(challenge) };
    });
  }

  peek(id: string): Promise<OtpChallengeView | null> {
    return run(() => {
      const found = this.challenges.get(id);
      return found === undefined ? null : view(found);
    });
  }

  /**
   * The critical section.
   *
   * Everything below runs synchronously, so nothing can interleave between
   * reading the challenge and removing it. Every terminal outcome removes the
   * challenge — a match, an expiry and an exhausted attempt count all leave
   * nothing behind, so a replay of any of them reads `unknown`.
   */
  attempt(id: string, code: string, now: number): Promise<OtpAttemptOutcome> {
    return run(() => {
      const challenge = this.challenges.get(id);
      if (challenge === undefined) return { kind: 'unknown' };

      if (challenge.expiresAt <= now) {
        this.challenges.delete(id);
        return { kind: 'expired' };
      }

      // The attempt is counted **before** the comparison, so a caller that
      // could somehow abandon the request mid-comparison has still spent it.
      const attempts = challenge.attempts + 1;
      if (attempts > this.options.maxAttempts) {
        this.challenges.delete(id);
        return { kind: 'exhausted' };
      }

      if (!otpMatches(code, challenge.code)) {
        const remaining = this.options.maxAttempts - attempts;
        if (remaining <= 0) {
          // The last attempt is spent and wrong: the challenge is finished
          // now rather than on a later request that would never succeed.
          this.challenges.delete(id);
          return { kind: 'exhausted' };
        }
        this.challenges.set(id, { ...challenge, attempts });
        return { kind: 'mismatch', remainingAttempts: remaining };
      }

      // Single use, and the removal is what makes it so. It happens before
      // this function returns, and therefore before any caller can await
      // anything, so a second presentation of the same code finds nothing.
      this.challenges.delete(id);
      return { kind: 'verified', challenge: view({ ...challenge, attempts }) };
    });
  }

  discard(id: string): Promise<void> {
    return run(() => {
      this.challenges.delete(id);
    });
  }

  purgeExpired(now: number): Promise<number> {
    return run(() => this.pruneExpired(now));
  }

  size(): number {
    return this.challenges.size;
  }

  private pruneExpired(now: number): number {
    let removed = 0;
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) {
        this.challenges.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/** The code is not on this type, and that is the point. */
function view(challenge: OtpChallenge): OtpChallengeView {
  return {
    id: challenge.id,
    email: challenge.email,
    purpose: challenge.purpose,
    abaUserId: challenge.abaUserId,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    attempts: challenge.attempts,
  };
}

/**
 * Presents a synchronous operation through the asynchronous port.
 *
 * The same reasoning as `MemoryStore.run`: the interface is async because a
 * cross-process implementation would be, and code written against it must
 * behave identically here. The body stays synchronous, which is what the
 * atomicity argument above rests on.
 */
function run<T>(operation: () => T): Promise<T> {
  return Promise.resolve(operation());
}
