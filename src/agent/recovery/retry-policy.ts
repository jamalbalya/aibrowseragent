/**
 * Retry policy (specification section 73).
 *
 * Only transient failures are retried, and only with bounded exponential
 * backoff plus jitter. Anything with an unknown side effect, a policy decision
 * behind it, or an invalid input is never retried.
 */
import { type ErrorCode, isRetryableCode } from '@/types/result';

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Multiplier applied per attempt. */
  readonly factor: number;
  /**
   * The longest a provider may tell us to wait and still be waited for.
   *
   * Server guidance is honoured, not obeyed. A task has a budget — ten minutes
   * by default — and sleeping most of it to make one more attempt spends the
   * person's time to arrive at the same place. Past this ceiling the honest
   * answer is to stop and say how long the provider asked for, which is
   * something they can act on.
   */
  readonly maxServerDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 8000,
  factor: 2,
  maxServerDelayMs: 60_000,
};

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * @param attempt 1-based count of attempts already made.
 * @param random Injectable source of jitter, for deterministic tests.
 */
export function decideRetry(
  code: ErrorCode,
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  return decideRetryFor({ code, retryable: isRetryableCode(code) }, attempt, policy, random);
}

/**
 * Retry decision for a failure that has already been classified.
 *
 * Two provider failures can share a code and differ on whether waiting will
 * help: a 503 and a reply that did not parse both surface as `MODEL_ERROR`,
 * and only the first is worth another attempt. The code alone cannot separate
 * them, so a caller that has a classification passes it and it is honoured.
 *
 * This is the join between provider-specific error mapping and the one retry
 * policy: an adapter normalises its failure into a category, the category
 * decides `retryable`, and the backoff below is unchanged for everyone.
 */
export function decideRetryFor(
  classification: {
    readonly code: ErrorCode;
    readonly retryable: boolean;
    /**
     * What the provider said to wait, in milliseconds, if it said anything.
     *
     * **This used not to be read.** `delayFromRetryAfter` parsed the header,
     * `providerFailure` recorded it, and the comment below this interface
     * claimed it overrode our backoff — while the only thing that reached this
     * function was a code and a boolean. So a provider saying *"retry in 47
     * seconds"* got an 8-second exponential backoff, another 429, and a task
     * that burned its three attempts in about fifteen seconds and failed.
     *
     * Live free-tier accounts rate-limit constantly, which is how the gap
     * became visible: every provider run in this session hit a 429.
     */
    readonly retryAfterMs?: number;
  },
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  const { code } = classification;
  if (!classification.retryable) {
    return { shouldRetry: false, delayMs: 0, reason: `${code} is not a transient failure.` };
  }
  if (attempt >= policy.maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: `Retry limit reached (${policy.maxAttempts} attempts).`,
    };
  }

  // Server guidance wins where there is any, because it is the one party that
  // knows when the limit lifts. No jitter on it: the provider named a time,
  // and smearing it is how a client arrives early and is refused again.
  const stated = classification.retryAfterMs;
  if (stated !== undefined && Number.isFinite(stated) && stated >= 0) {
    if (stated > policy.maxServerDelayMs) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason:
          `${code}; the provider asked to wait ${Math.ceil(stated / 1000)}s, which is longer ` +
          `than this task will hold for.`,
      };
    }
    return {
      shouldRetry: true,
      delayMs: Math.round(stated),
      reason:
        `${code}; waiting the ${Math.ceil(stated / 1000)}s the provider asked for ` +
        `(attempt ${attempt + 1} of ${policy.maxAttempts}).`,
    };
  }

  const exponential = policy.baseDelayMs * policy.factor ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Full jitter: spreads retries so concurrent tasks do not synchronise.
  const delayMs = Math.round(capped * (0.5 + random() * 0.5));

  return {
    shouldRetry: true,
    delayMs,
    reason: `${code} is transient; retrying attempt ${attempt + 1} of ${policy.maxAttempts}.`,
  };
}

/** Rate-limit responses carry server guidance that overrides our backoff. */
export function delayFromRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
