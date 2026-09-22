/**
 * TEST-AUDIT-002 — observer fan-out, and the isolation between observers.
 *
 * Two observers now sit on `ToolRegistry.dispatch`: the workflow recorder
 * (P-022) and the audit adapter (P-038). Neither may depend on the other, and
 * neither may reach the call they are watching. The four cases the contract
 * names are asserted against the real registry.
 */
import { describe, expect, it } from 'vitest';
import { buildWorkflowHarness } from '../fixtures/workflow-harness';
import { createHarness } from '../fixtures/policy-harness';
import { fakeTool } from '../fixtures/skill-harness';
import type { DispatchObservation } from '@/tools/registry/tool-registry';
import type { TaintState } from '@/security/taint/taint-state';

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };

function invocation() {
  return {
    toolCallId: 'tc_1',
    taskId: 'task_1',
    sessionId: 'session_1',
    name: 'fake.read',
    arguments: { url: 'https://x.test/' },
    taintState: UNTAINTED,
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    signal: new AbortController().signal,
  };
}

function registryWith(observers: readonly ((o: DispatchObservation) => void)[]) {
  return createHarness([fakeTool({ name: 'fake.read', risk: 'R0', returns: { ok: true } })], {
    onDispatched: observers,
  }).registry;
}

describe('two observers on one hook', () => {
  it('1. runs both when both succeed', async () => {
    const seen: string[] = [];
    const registry = registryWith([() => seen.push('recorder'), () => seen.push('audit')]);

    await registry.dispatch(invocation());
    expect(seen).toEqual(['recorder', 'audit']);
  });

  it('2. keeps the recorder working when the audit observer throws', async () => {
    const seen: string[] = [];
    const registry = registryWith([
      () => seen.push('recorder'),
      () => {
        throw new Error('the audit observer is broken');
      },
    ]);

    const result = await registry.dispatch(invocation());
    expect(seen).toEqual(['recorder']);
    expect(result.envelope.status).toBe('success');
  });

  it('3. runs the audit observer when the workflow observer throws', async () => {
    const seen: string[] = [];
    const registry = registryWith([
      () => {
        throw new Error('the recorder is broken');
      },
      () => seen.push('audit'),
    ]);

    const result = await registry.dispatch(invocation());
    // Order is not a contract, but isolation is: the second observer ran.
    expect(seen).toEqual(['audit']);
    expect(result.envelope.status).toBe('success');
  });

  it('4. lets neither observer change the result', async () => {
    const registry = registryWith([
      (observation) => {
        // Frozen, so this throws in strict mode and changes nothing either
        // way. Caught here so the case is about the result, not the throw.
        try {
          (observation as unknown as { executed: boolean }).executed = false;
          (observation as unknown as { status: string }).status = 'error';
        } catch {
          // Expected: the observation is deeply frozen.
        }
      },
      () => {
        throw new Error('and a broken one beside it');
      },
    ]);

    const result = await registry.dispatch(invocation());
    expect(result.envelope.status).toBe('success');
    expect(result.executed).toBe(true);
  });

  it('5. still supports a single observer, so P-022 wiring is unchanged', async () => {
    const harness = buildWorkflowHarness({ tools: [{ name: 'fake.read', risk: 'R0' }] });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch({
      ...invocation(),
      taskId: 'task_skill_1',
      name: 'fake.read',
    });
    expect(harness.recorder.stop()?.definition.steps).toHaveLength(1);
  });
});
