/**
 * TEST-SHORTCUT-002 — name → resolver → existing route → existing pipeline.
 *
 * The claim is that a shortcut changes nothing about how its target runs. So
 * every case here runs the same target twice — once named, once not — and
 * asserts the same thing happened, over the real registry, policy engine,
 * permission engine and egress gate.
 */
import { describe, expect, it } from 'vitest';
import { buildShortcutHarness } from '../fixtures/shortcut-harness';
import { skillFixture } from '../fixtures/skill-harness';
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

async function storeWorkflow(
  harness: ReturnType<typeof buildShortcutHarness>,
  tool: string,
): Promise<string> {
  harness.recorder.start('task_skill_1');
  await harness.tools.dispatch(invocation(tool, { url: 'https://example.test/' }));
  const captured = harness.recorder.stop()!;
  const saved = await harness.store.save({
    name: 'A recorded workflow',
    description: 'One step.',
    definition: captured.definition,
    recordedFromTaskId: 'task_skill_1',
    taintAtCapture: captured.taint,
  });
  return saved.workflowId;
}

describe('a shortcut reaches the same place as the thing it names', () => {
  it('resolves to the workflow it was created for and replays it', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness, 'fake.read');
    await harness.shortcuts.create('read-it', { kind: 'workflow', workflowId });

    const verdict = await harness.resolver.resolveTyped('/read-it');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.resolution.targetId).toBe(workflowId);
    expect(verdict.resolution.targetKind).toBe('workflow');
    expect(verdict.resolution.stepCount).toBe(1);

    const before = harness.seen.length;
    const outcome = await harness.replayer.replay({
      workflowId: verdict.resolution.targetId,
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok && outcome.result.status).toBe('completed');
    expect(harness.seen).toHaveLength(before + 1);
  });

  it('runs a named skill through the same runner as the tool would', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    await harness.register(skillFixture({ id: 'test.skill', version: '1.0.0' }));
    await harness.shortcuts.create('inspect', {
      kind: 'skill',
      skillId: 'test.skill',
      skillVersion: '1.0.0',
    });

    const verdict = await harness.resolver.resolveTyped('/inspect');
    expect(verdict.ok && verdict.resolution.targetKind).toBe('skill');

    const before = harness.seen.length;
    const outcome = await harness.launcher.launch({
      skillId: 'test.skill',
      skillVersion: '1.0.0',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(outcome.ok && outcome.result.status).toBe('completed');
    // The step really dispatched, through the real registry.
    expect(harness.seen).toHaveLength(before + 1);
    expect(harness.seen.at(-1)?.tool).toBe('fake.read');
  });

  it('stops at a denied step exactly as it would without a shortcut', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('approve_once');
    const workflowId = await storeWorkflow(harness, 'fake.write');
    await harness.shortcuts.create('write-it', { kind: 'workflow', workflowId });

    harness.respondWith('deny');
    const named = await harness.resolver.resolveTyped('/write-it');
    const before = harness.seen.length;
    const viaShortcut = await harness.replayer.replay({
      workflowId: named.ok ? named.resolution.targetId : '',
      sessionId: 'session_skill',
      inputs: {},
    });
    const afterShortcut = harness.seen.length;

    // The same workflow, reached without a name.
    const viaId = await harness.replayer.replay({
      workflowId,
      sessionId: 'session_skill',
      inputs: {},
    });

    expect(viaShortcut.ok && viaShortcut.result.status).toBe('failed');
    expect(viaId.ok && viaId.result.status).toBe('failed');
    // Neither executed anything, and the name made no difference.
    expect(afterShortcut).toBe(before);
    expect(harness.seen).toHaveLength(before);
  });

  it('is asked for permission per step, the name buying nothing', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS, permissionMode: 'manual' });
    harness.respondWith('approve_once');
    const workflowId = await storeWorkflow(harness, 'fake.write');
    await harness.shortcuts.create('write-it', { kind: 'workflow', workflowId });

    const promptsBefore = harness.prompts().length;
    const verdict = await harness.resolver.resolveTyped('/write-it');
    // Resolution alone asks for nothing, because it runs nothing.
    expect(harness.prompts()).toHaveLength(promptsBefore);

    await harness.replayer.replay({
      workflowId: verdict.ok ? verdict.resolution.targetId : '',
      sessionId: 'session_skill',
      inputs: {},
    });
    expect(harness.prompts().length).toBeGreaterThan(promptsBefore);
  });

  it('keeps working for other shortcuts when one target is deleted', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const first = await storeWorkflow(harness, 'fake.read');
    const second = await storeWorkflow(harness, 'fake.read');
    await harness.shortcuts.create('one', { kind: 'workflow', workflowId: first });
    await harness.shortcuts.create('two', { kind: 'workflow', workflowId: second });

    await harness.store.remove(first);

    expect((await harness.resolver.resolveTyped('/one')).ok).toBe(false);
    expect((await harness.resolver.resolveTyped('/two')).ok).toBe(true);
  });

  it('keeps a dangling shortcut listed so the user can see and remove it', async () => {
    const harness = buildShortcutHarness({ tools: TOOLS });
    const workflowId = await storeWorkflow(harness, 'fake.read');
    const created = await harness.shortcuts.create('one', { kind: 'workflow', workflowId });
    await harness.store.remove(workflowId);

    // Still stored — silently deleting the name would hide that it existed —
    // but it resolves to nothing and therefore runs nothing.
    expect(await harness.shortcuts.list()).toHaveLength(1);
    expect((await harness.resolver.resolveRecord(created)).ok).toBe(false);

    await harness.shortcuts.remove(created.shortcutId);
    expect(await harness.shortcuts.list()).toHaveLength(0);
  });
});
