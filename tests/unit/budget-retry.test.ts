/**
 * TEST-AGENT-002 — Resource budgets and retry policy (REQ-AGENT-002).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, checkBudget } from '@/agent/budget/budget';
import {
  DEFAULT_RETRY_POLICY,
  decideRetry,
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
      { maxAttempts: 20, baseDelayMs: 1000, maxDelayMs: 5000, factor: 10 },
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
