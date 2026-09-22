/**
 * TEST-WORKFLOW-002 — record → store → review → replay, end to end over the
 * real dispatch path.
 *
 * The lifecycle is the security property: every stage before replay is inert,
 * and replay is an ordinary run through `SkillRunner` and `ToolRegistry`. This
 * suite walks the whole thing with the real registry, policy engine,
 * permission engine and egress gate underneath.
 */
import { describe, expect, it } from 'vitest';
import { buildWorkflowHarness } from '../fixtures/workflow-harness';
import { REPLAY_PROVIDER_ID } from '@/workflows/workflow-replay';
import type { TaintState } from '@/security/taint/taint-state';

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };
const SALT = 'ab'.repeat(32);

const TOOLS = [
  { name: 'fake.read', risk: 'R0' as const, returns: { title: 'A page' } },
  { name: 'fake.write', risk: 'R3' as const, returns: { written: true } },
];

function invocation(name: string, args: Record<string, unknown> = {}) {
  return {
    toolCallId: `tc_${name}_${Math.random().toString(16).slice(2)}`,
    taskId: 'task_skill_1',
    sessionId: 'session_skill',
    name,
    arguments: args,
    taintState: UNTAINTED,
    taintSalt: SALT,
    saltEpoch: 1,
    signal: new AbortController().signal,
  };
}

describe('a recorded workflow goes record → store → review → replay', () => {
  it('captures a two-step task, stores it, and replays both steps through dispatch', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });

    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    await harness.tools.dispatch(invocation('fake.write', { submit: true }));
    const captured = harness.recorder.stop();

    expect(captured?.definition.steps).toHaveLength(2);
    expect(captured?.definition.requiredTools).toEqual(['fake.read', 'fake.write']);

    const saved = await harness.store.save({
      name: 'Read then write',
      description: 'Two steps.',
      definition: captured!.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured!.taint,
    });

    // The store's risk is the highest any step reaches, not the recorder's
    // floor — a two-step workflow ending in a write is a write.
    expect(saved.risk).toBe('R3');
    expect(saved.tools).toEqual(['fake.read', 'fake.write']);

    // Nothing ran between stopping and now.
    expect(harness.seen).toHaveLength(2);

    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.status).toBe('completed');
    expect(outcome.ok && outcome.result.steps.map((step) => step.ran)).toEqual([
      'fake.read',
      'fake.write',
    ]);
    // Each step went through dispatch again, so each one was seen again.
    expect(harness.seen).toHaveLength(4);
  });

  it('records a replay as a task of its own, with no provider behind it', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    const captured = harness.recorder.stop()!;
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'One step.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
    });

    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok).toBe(true);

    const task = await harness.tasks.getTask(outcome.ok ? outcome.taskId : '');
    expect(task?.state).toBe('COMPLETED');
    // A replay consults no model, so claiming a provider would be a lie the
    // task record would then carry.
    expect(task?.providerId).toBe(REPLAY_PROVIDER_ID);
    // And it starts clean: it is a new task that has read nothing yet.
    expect(task?.taintState.kind).toBe('KNOWN_UNTAINTED');
  });

  it('asks for a slotted value at replay rather than replaying what was captured', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });

    // A tainted task, so the long argument becomes a slot rather than a
    // stored literal.
    harness.setTaint({
      kind: 'TAINTED',
      sources: [{ sourceType: 'page', sensitivity: 'internal' }],
    });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(
      invocation('fake.write', { body: 'text this task read from the page it had open' }),
    );
    const captured = harness.recorder.stop()!;

    expect(captured.definition.inputs).toHaveLength(1);
    const slot = captured.definition.inputs[0]!.name;
    expect(JSON.stringify(captured.definition)).not.toContain('read from the page');

    const saved = await harness.store.save({
      name: 'Write a body',
      description: 'One step, one slot.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
    });

    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: { [slot]: 'what the user typed this time' },
    });

    expect(outcome.ok && outcome.result.status).toBe('completed');
    const replayed = harness.seen.at(-1);
    expect(replayed?.args).toMatchObject({ body: 'what the user typed this time' });
  });

  it('refuses a replay whose required input was not supplied', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    harness.setTaint({
      kind: 'TAINTED',
      sources: [{ sourceType: 'page', sensitivity: 'internal' }],
    });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(
      invocation('fake.write', { body: 'text this task read from the page it had open' }),
    );
    const captured = harness.recorder.stop()!;
    const saved = await harness.store.save({
      name: 'Write a body',
      description: 'One step, one slot.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
    });

    const before = harness.seen.length;
    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('INPUTS_INVALID');
    // Refused before anything ran, not partway through.
    expect(harness.seen).toHaveLength(before);
  });

  it('deletes a workflow, and a deleted one cannot be replayed', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    const captured = harness.recorder.stop()!;
    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'One step.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
    });

    expect(await harness.store.list()).toHaveLength(1);
    await harness.store.remove(saved.workflowId);
    expect(await harness.store.list()).toHaveLength(0);

    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok === false && outcome.reason).toBe('NOT_FOUND');
  });

  it('stops a replay at the first refused step rather than carrying on', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('approve_once');

    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.write', { submit: true }));
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    const captured = harness.recorder.stop()!;
    const saved = await harness.store.save({
      name: 'Write then read',
      description: 'Two steps.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
    });

    harness.respondWith('deny');
    const before = harness.seen.length;
    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });

    expect(outcome.ok && outcome.result.status).toBe('failed');
    // The second step assumed the first one happened, so it does not run.
    expect(harness.seen).toHaveLength(before);
  });

  it('refuses a workflow with a gap, and says so before anything runs', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    const captured = harness.recorder.stop()!;

    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A recording with a gap.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
      droppedSteps: [{ afterStepId: 's1', tool: 'fake.write', reason: 'could not be described' }],
    });

    // Reviewing says why without running anything.
    const verdict = await harness.replayer.revalidate(saved.workflowId);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('INCOMPLETE_RECORDING');

    const before = harness.seen.length;
    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok).toBe(false);
    // And no task was created for a run that never started.
    expect(harness.seen).toHaveLength(before);
  });

  it('keeps a recording replayable when it captured everything', async () => {
    const harness = buildWorkflowHarness({ tools: TOOLS });
    harness.recorder.start('task_skill_1');
    await harness.tools.dispatch(invocation('fake.read', { url: 'https://example.test/' }));
    const captured = harness.recorder.stop()!;

    const saved = await harness.store.save({
      name: 'Read a page',
      description: 'A complete recording.',
      definition: captured.definition,
      recordedFromTaskId: 'task_skill_1',
      taintAtCapture: captured.taint,
      droppedSteps: [],
    });

    expect(saved.droppedSteps).toEqual([]);
    const outcome = await harness.replayer.replay({
      workflowId: saved.workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok && outcome.result.status).toBe('completed');
  });
});
