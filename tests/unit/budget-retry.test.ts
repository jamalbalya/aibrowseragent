/**
 * TEST-AGENT-002 — Resource budgets and retry policy (REQ-AGENT-002).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, checkBudget } from '@/agent/budget/budget';
import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
  decideRetryFor,
  delayFromRetryAfter,
} from '@/agent/recovery/retry-policy';
import { emptyUsage } from '@/tasks/task-model';
import { ERROR_CODES, isRetryableCode } from '@/types/result';

describe('checkBudget', () => {
  it('reports headroom for fresh usage', () => {
    expect(checkBudget(emptyUsage(), DEFAULT_BUDGET).exhausted).toBe(false);
  });

  it('fires on each dimension independently', () => {
    const dimensions = [
      ['elapsedMs', DEFAULT_BUDGET.maxDurationMs, 'duration'],
      ['toolCalls', DEFAULT_BUDGET.maxToolCalls, 'toolCalls'],
      ['modelRequests', DEFAULT_BUDGET.maxModelRequests, 'modelRequests'],
      ['retries', DEFAULT_BUDGET.maxRetries, 'retries'],
      ['screenshots', DEFAULT_BUDGET.maxScreenshots, 'screenshots'],
      ['externalWrites', DEFAULT_BUDGET.maxExternalWrites, 'externalWrites'],
    ] as const;

    for (const [field, limit, dimension] of dimensions) {
      const check = checkBudget({ ...emptyUsage(), [field]: limit }, DEFAULT_BUDGET);
      expect(check.exhausted, field).toBe(true);
      expect(check.dimension).toBe(dimension);
    }
  });

  it('counts prompt and completion tokens together', () => {
    const half = DEFAULT_BUDGET.maxTotalTokens / 2;
    const check = checkBudget(
      { ...emptyUsage(), promptTokens: half, completionTokens: half },
      DEFAULT_BUDGET,
    );
    expect(check.exhausted).toBe(true);
    expect(check.dimension).toBe('tokens');
  });

  it('includes the limit in the message so the failure is actionable', () => {
    const check = checkBudget({ ...emptyUsage(), toolCalls: 60 }, DEFAULT_BUDGET);
    expect(check.detail).toContain('60');
  });
});

describe('decideRetry', () => {
  const fixedRandom = () => 0.5;

  it('retries transient failures with growing backoff', () => {
    const first = decideRetry('NETWORK_ERROR', 1, DEFAULT_RETRY_POLICY, fixedRandom);
    const second = decideRetry('NETWORK_ERROR', 2, DEFAULT_RETRY_POLICY, fixedRandom);
    expect(first.shouldRetry).toBe(true);
    expect(second.shouldRetry).toBe(true);
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
  });

  it('caps the delay at the configured maximum', () => {
    const decision = decideRetry(
      'NETWORK_ERROR',
      1,
      {
        maxAttempts: 20,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        factor: 10,
        maxServerDelayMs: 60_000,
      },
      () => 1,
    );
    expect(decision.delayMs).toBeLessThanOrEqual(5000);
  });

  it('applies jitter so concurrent tasks do not synchronise', () => {
    const low = decideRetry('NETWORK_ERROR', 1, DEFAULT_RETRY_POLICY, () => 0);
    const high = decideRetry('NETWORK_ERROR', 1, DEFAULT_RETRY_POLICY, () => 1);
    expect(low.delayMs).toBeLessThan(high.delayMs);
  });

  it('stops at the attempt limit', () => {
    const decision = decideRetry(
      'NETWORK_ERROR',
      DEFAULT_RETRY_POLICY.maxAttempts,
      DEFAULT_RETRY_POLICY,
      fixedRandom,
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain('limit');
  });

  it('never retries a decision, an auth failure, or an invalid input', () => {
    for (const code of [
      'PERMISSION_DENIED',
      'POLICY_BLOCKED',
      'AUTH_REQUIRED',
      'AUTH_EXPIRED',
      'INVALID_ARGUMENT',
      'USER_CANCELLED',
      'LOOP_DETECTED',
      'ORIGIN_CHANGED',
    ] as const) {
      expect(decideRetry(code, 1, DEFAULT_RETRY_POLICY, fixedRandom).shouldRetry, code).toBe(false);
    }
  });

  it('classifies every error code without throwing', () => {
    for (const code of ERROR_CODES) {
      expect(() => isRetryableCode(code)).not.toThrow();
      expect(typeof isRetryableCode(code)).toBe('boolean');
    }
  });
});

describe('delayFromRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(delayFromRetryAfter('30')).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const delay = delayFromRetryAfter(future);
    expect(delay).toBeGreaterThan(50_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });

  it('clamps a past date to zero rather than returning a negative delay', () => {
    expect(delayFromRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('returns null for an absent or unparseable header', () => {
    expect(delayFromRetryAfter(null)).toBeNull();
    expect(delayFromRetryAfter(undefined)).toBeNull();
    expect(delayFromRetryAfter('soon')).toBeNull();
  });
});

describe('server retry guidance', () => {
  /**
   * The gap this closes, found by running against real free-tier accounts:
   * `delayFromRetryAfter` parsed the header, `providerFailure` recorded it, and
   * the comment on the parser said it *"overrides our backoff"* — while the
   * only thing reaching `decideRetryFor` was a code and a boolean. A provider
   * saying "retry in 47 seconds" got an 8-second backoff, another 429, and a
   * task that spent its three attempts in about fifteen seconds and failed.
   */

  it('waits exactly as long as the provider asked, with no jitter', () => {
    const decision = decideRetryFor(
      { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 20_000 },
      1,
      DEFAULT_RETRY_POLICY,
      () => 0,
    );
    expect(decision.shouldRetry).toBe(true);
    // Not 400ms of exponential backoff, and not smeared by jitter: the
    // provider named a time, and arriving early is how a client is refused
    // again.
    expect(decision.delayMs).toBe(20_000);
    expect(decision.reason).toMatch(/20s the provider asked for/);
  });

  it('uses its own backoff when the provider said nothing', () => {
    // The control: the parsed header is optional, and most failures carry
    // none. Those must keep the jittered exponential behaviour.
    const low = decideRetryFor(
      { code: 'NETWORK_ERROR', retryable: true },
      1,
      DEFAULT_RETRY_POLICY,
      () => 0,
    );
    const high = decideRetryFor(
      { code: 'NETWORK_ERROR', retryable: true },
      1,
      DEFAULT_RETRY_POLICY,
      () => 1,
    );
    expect(low.delayMs).toBeLessThan(high.delayMs);
    expect(low.reason).toMatch(/is transient/);
  });

  it('stops rather than sleeping longer than the task will hold for', () => {
    // Honoured, not obeyed. A task has a ten-minute budget, and sleeping five
    // of them to make one more attempt spends the person's time to arrive at
    // the same place — so the honest answer is to stop and say how long the
    // provider wanted.
    const decision = decideRetryFor(
      { code: 'RATE_LIMITED', retryable: true, retryAfterMs: 15 * 60 * 1000 },
      1,
      DEFAULT_RETRY_POLICY,
      () => 0,
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.delayMs).toBe(0);
    expect(decision.reason).toMatch(/asked to wait 900s/);
    expect(decision.reason).toMatch(/longer than this task will hold for/);
  });

  it('honours the boundary in both directions', () => {
    const at = decideRetryFor(
      {
        code: 'RATE_LIMITED',
        retryable: true,
        retryAfterMs: DEFAULT_RETRY_POLICY.maxServerDelayMs,
      },
      1,
    );
    const over = decideRetryFor(
      {
        code: 'RATE_LIMITED',
        retryable: true,
        retryAfterMs: DEFAULT_RETRY_POLICY.maxServerDelayMs + 1,
      },
      1,
    );
    expect(at.shouldRetry).toBe(true);
    expect(over.shouldRetry).toBe(false);
  });

  it('does not let guidance resurrect a failure that is never retried', () => {
    // A `Retry-After` on a 403 is not an invitation. The retryable decision
    // comes first and guidance only shapes the wait.
    const decision = decideRetryFor(
      { code: 'PERMISSION_DENIED', retryable: false, retryAfterMs: 1000 },
      1,
    );
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toMatch(/not a transient failure/);
  });

  it('ignores guidance that is not a usable number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const decision = decideRetryFor(
        { code: 'RATE_LIMITED', retryable: true, retryAfterMs: bad },
        1,
        DEFAULT_RETRY_POLICY,
        () => 0,
      );
      expect(decision.shouldRetry, String(bad)).toBe(true);
      // Fell through to our own backoff rather than sleeping for NaN.
      expect(decision.reason, String(bad)).toMatch(/is transient/);
    }
  });
});
