/**
 * Shared egress fixtures.
 *
 * `passthroughTransport` exists so wire-translation tests can exercise the
 * adapter without the gate in the way. It is deliberately confined to tests
 * and is never exported from `src`: production has exactly two transports, a
 * guarded one and one that refuses.
 */
import { vi } from 'vitest';
import type { EgressContext, ProviderTransport } from '@/security/egress/provider-transport';
import { freshTaint, type TaintState } from '@/security/taint/taint-state';

export const TEST_SALT = 'ab'.repeat(32);

export function testEgressContext(overrides: Partial<EgressContext> = {}): EgressContext {
  return {
    taskId: 'task_test',
    taintState: freshTaint(),
    taintSalt: TEST_SALT,
    saltEpoch: 1,
    taintSignature: 'sig-clean',
    providerId: 'openai-compatible',
    modelId: 'test-model',
    ...overrides,
  };
}

export function taintedContext(state: TaintState, signature = 'sig-tainted'): EgressContext {
  return testEgressContext({ taintState: state, taintSignature: signature });
}

/** Hands every call straight to the supplied fetch, with no authorization. */
export function passthroughTransport(fetchImpl: typeof fetch): ProviderTransport {
  return {
    request: (url, init) => fetchImpl(url, init),
  };
}

/** A transport that records whether it was reached at all. */
export function recordingTransport(): ProviderTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    request: (url) => {
      calls.push(url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  };
}

/** A fetch that fails the test if it is ever called. */
export function forbiddenFetch(): typeof fetch {
  return vi.fn(() => {
    throw new Error('The network was reached without authorization.');
  });
}
