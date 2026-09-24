/**
 * The one-time code itself: how it is minted, and how it is compared.
 *
 * Six decimal digits, and the smallness of that space is the whole reason
 * every other control in this feature exists. 10^6 is not a secret anybody
 * would call strong — it is made strong by being **single-use,
 * TTL-bounded, attempt-bounded and rate-limited**, and by never existing
 * anywhere it could be attacked offline. Those are properties of the flow,
 * not of the number, and removing any one of them removes the security.
 *
 * ## Why there is no OTP digest anywhere in this codebase
 *
 * `token.ts` stores a one-way digest in place of a refresh token, and
 * anticipated that this phase might want Argon2id for the same job. It does
 * not, because the job is different. A digest defends a **stolen database**:
 * the attacker has the rows and must not be able to present a credential. A
 * SHA-256 of a six-digit code defends nothing — the whole space is a million
 * candidates and falls in under a second — and Argon2id would only make that
 * expensive rather than impossible.
 *
 * The answer is therefore not a better hash but a stronger classification: an
 * OTP is never written to a database at all. It exists in process memory, on
 * one challenge, for at most ten minutes, and is destroyed the moment it is
 * used or missed too often. There is no row to steal, so there is nothing for
 * a digest to protect, and adding one would be security theatre that also
 * added a dependency.
 *
 * ## What is deliberately absent
 *
 * No alphabet option, no length option, no "friendly" digits. A configurable
 * OTP is an OTP somebody can configure down.
 */
import { timingSafeEqual } from './token';

/** Exactly this many decimal digits. Not a range, and not configurable. */
export const OTP_DIGITS = 6;

/** The size of the code space. Stated so tests can assert against it. */
export const OTP_SPACE = 10 ** OTP_DIGITS;

/** Six ASCII decimal digits and nothing else. No spaces, no separators. */
const OTP_SHAPE = /^[0-9]{6}$/;

/**
 * A new code, uniform over `[0, 10^6)`.
 *
 * **Rejection sampling, not modulo.** `randomUint32() % 1_000_000` is biased:
 * 2^32 is not a multiple of 10^6, so the first 967,296 values are reachable
 * by one more 32-bit draw than the rest, and an attacker guessing in the
 * biased region has a measurably better than 1-in-a-million chance. The bias
 * is small; the fix is three lines; there is no reason to accept it.
 *
 * The loop is bounded in practice rather than in theory — it retries only for
 * draws in the final incomplete block, which is about 0.02% of the space, so
 * it terminates immediately with overwhelming probability.
 */
export function newOtpCode(): string {
  // The largest multiple of OTP_SPACE that fits in 2^32. Draws at or above
  // this are the incomplete final block and are discarded.
  const ceiling = Math.floor(0x1_0000_0000 / OTP_SPACE) * OTP_SPACE;
  const buffer = new Uint32Array(1);
  let draw = 0;
  do {
    crypto.getRandomValues(buffer);
    draw = buffer[0] ?? 0;
  } while (draw >= ceiling);
  return String(draw % OTP_SPACE).padStart(OTP_DIGITS, '0');
}

/** Is this the shape of a code this module mints? */
export function isOtpShape(value: unknown): value is string {
  return typeof value === 'string' && OTP_SHAPE.test(value);
}

/**
 * Compares a presented code against the issued one, in constant time.
 *
 * An early-exit `===` leaks a prefix, and a prefix oracle turns a million
 * guesses into sixty. The comparison is therefore `timingSafeEqual`, and the
 * shape check runs **first** so that a malformed presentation is refused on
 * its shape rather than on a length comparison inside the equality.
 */
export function otpMatches(presented: string, issued: string): boolean {
  if (!isOtpShape(presented) || !isOtpShape(issued)) return false;
  return timingSafeEqual(presented, issued);
}
