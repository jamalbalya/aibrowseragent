/**
 * Rate limiting, in memory, for the unauthenticated half of authentication.
 *
 * ## Why this exists at all
 *
 * A six-digit code is defended by three things, and two of them are here. The
 * per-challenge attempt cap stops a thousand guesses against one code; this
 * stops a thousand codes being minted so that each may be guessed once, and
 * it stops the same endpoint being used to mail a stranger a hundred
 * messages. Without it the OTP endpoints are a free email cannon aimed at
 * anybody whose address the caller knows, and the arithmetic on the code
 * space stops working.
 *
 * Shipping OTP without rate limiting and documenting that it will come later
 * is exactly the thing the phase specification forbids, and it is forbidden
 * for a good reason: the window in which it is missing is the window in which
 * the endpoint is abused.
 *
 * ## The shape: fixed windows, and why not a token bucket
 *
 * A fixed window counts events in `[start, start + windowMs)` and resets. It
 * admits a burst of up to `2 × limit` across a window boundary, which a
 * sliding window would not. That is accepted deliberately: the limits here
 * are small integers over minutes, the boundary burst is bounded and
 * harmless at that scale, and a fixed window is simple enough to be read and
 * trusted — which a rate limiter has to be, because a subtly wrong one fails
 * open and nobody notices.
 *
 * ## Failing closed
 *
 * The key space is bounded, because an attacker choosing keys is an attacker
 * allocating memory. When the map is full of **live** entries the limiter
 * refuses rather than evicting. Evicting the oldest would let anybody clear a
 * victim's counter by flooding the limiter with keys of their own, which
 * turns the defence into its own bypass.
 *
 * ## What it is not
 *
 * Per process, and it says so. A multi-instance deployment gets one limiter
 * per instance, so the effective limit is multiplied by the instance count.
 * That is a real deployment constraint, reported rather than hidden, and the
 * remedy is a shared counter — not a change here.
 */
import type { Clock } from '../domain/clock';

export interface RateLimitRule {
  /** Events permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
}

export type RateLimitOutcome =
  | { readonly allowed: true; readonly remaining: number }
  | {
      readonly allowed: false;
      /** How long until this key is permitted again. Never negative. */
      readonly retryAfterMs: number;
      /** True when the refusal came from the key cap rather than the rule. */
      readonly saturated: boolean;
    };

interface Window {
  startedAt: number;
  count: number;
  /**
   * The window this counter was opened under.
   *
   * Carried on the entry rather than taken from the rule being applied,
   * because pruning is global and the rules are not. An earlier draft pruned
   * every counter older than the *current* call's window, which meant a
   * bucket with a thirty-second window swept away the fifteen-minute
   * counters belonging to another — so anybody could clear their own start
   * allowance by hammering the short-windowed bucket. Each entry now expires
   * on its own terms.
   */
  windowMs: number;
}

export interface RateLimiterOptions {
  readonly clock: Clock;
  /** Maximum distinct keys held across all buckets. */
  readonly capacity: number;
}

/**
 * A counter per `(bucket, key)`.
 *
 * `bucket` names the thing being limited — starting a sign-in, verifying a
 * code — and `key` names who or what is being counted. Keeping them separate
 * means one caller's start budget is not spent by their verify attempts, and
 * that a key cannot be crafted to collide across buckets.
 */
export class MemoryRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly options: RateLimiterOptions) {}

  /**
   * Counts one event and says whether it is permitted.
   *
   * Consuming and asking are the same call on purpose. A separate `check`
   * then `consume` is a race, and a race in a rate limiter is a way past it.
   */
  consume(bucket: string, key: string, rule: RateLimitRule): RateLimitOutcome {
    const now = this.options.clock.now();
    const composite = `${bucket}\u0000${key}`;

    const existing = this.windows.get(composite);
    if (existing !== undefined && now - existing.startedAt < rule.windowMs) {
      if (existing.count >= rule.limit) {
        return {
          allowed: false,
          retryAfterMs: Math.max(0, existing.startedAt + rule.windowMs - now),
          saturated: false,
        };
      }
      existing.count += 1;
      return { allowed: true, remaining: rule.limit - existing.count };
    }

    if (existing === undefined) {
      this.prune(now);
      if (this.windows.size >= this.options.capacity) {
        // Full of live counters. Refuse: the alternative is evicting
        // somebody else's counter on demand, which is the bypass.
        return { allowed: false, retryAfterMs: rule.windowMs, saturated: true };
      }
    }

    this.windows.set(composite, { startedAt: now, count: 1, windowMs: rule.windowMs });
    return { allowed: true, remaining: rule.limit - 1 };
  }

  /**
   * Reports without counting.
   *
   * Used for the resend cooldown, where the question "how long until the next
   * one is allowed?" has to be answerable without spending the allowance to
   * ask it.
   */
  peek(bucket: string, key: string, rule: RateLimitRule): RateLimitOutcome {
    const now = this.options.clock.now();
    const existing = this.windows.get(`${bucket}\u0000${key}`);
    if (existing === undefined || now - existing.startedAt >= rule.windowMs) {
      return { allowed: true, remaining: rule.limit };
    }
    if (existing.count >= rule.limit) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, existing.startedAt + rule.windowMs - now),
        saturated: false,
      };
    }
    return { allowed: true, remaining: rule.limit - existing.count };
  }

  /** Clears one counter. For the paths where success legitimately resets one. */
  reset(bucket: string, key: string): void {
    this.windows.delete(`${bucket}\u0000${key}`);
  }

  /** Live counters held. Exposed so a test can assert the cap actually caps. */
  size(): number {
    return this.windows.size;
  }

  /**
   * Drops counters whose own window has closed.
   *
   * Each entry is judged against the window it was opened under, never
   * against the window of the rule that happened to trigger the prune. See
   * `Window.windowMs` for the bypass that reasoning closes.
   */
  private prune(now: number): void {
    for (const [composite, window] of this.windows) {
      if (now - window.startedAt >= window.windowMs) this.windows.delete(composite);
    }
  }
}
