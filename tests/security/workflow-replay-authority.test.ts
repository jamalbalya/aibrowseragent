/**
 * TEST-SECURITY-075 — what a replay has to earn again (P-022).
 *
 * TEST-SECURITY-023 settled that a recording is not a capability: it is never
 * registered, never listed to a model, never replayed by anything but a
 * person, and it fails closed on integrity. This suite asks the question that
 * comes after: the recording is legitimate, the person really is asking for it,
 * and the world has moved since it was made. Which of the approvals it was
 * given the first time does it still have?
 *
 * The answer this build gives is none. Not the site grant, not the permission
 * mode, not the fact that a prompt was answered. Every case below changes one
 * thing between the recording and the replay and asserts the change is what
 * decides — each with the control that would catch a build which simply
 * refuses, or simply allows, everything.
 *
 * Groups:
 *   A. site authorization is re-earned against the policy as it is now
 *   B. the permission mode in force is the replay's, in both directions
 *   C. a list argument either stores or refuses, never becomes unreplayable
 *   D. failure stops where it failed, and leaves nothing half-authorised
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildWorkflowHarness, type WorkflowHarness } from '../fixtures/workflow-harness';
import { emptySitePolicyState, type SitePolicyState } from '@/policy/site-policy';
import type { TaintState } from '@/security/taint/taint-state';
import type { SkillDefinition } from '@/skills/core/skill-model';

const TASK = 'task_skill_1';
const SESSION = 'session_skill';
const TAB = 7;
const SITE_URL = 'https://recorded.test/form';

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };

/** Source with comments stripped, so a census reads code and not prose. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A harness whose tab really is on a site, so site rules apply to page steps.
 *
 * Without the URL every page action resolves to no scope, every site rule is
 * inapplicable, and a suite about site authorization would pass against a
 * build that had none.
 */
function harnessOn(url = SITE_URL, mode: 'manual' | 'auto' | 'skip' = 'auto'): WorkflowHarness {
  return buildWorkflowHarness({
    permissionMode: mode,
    activeTabId: TAB,
    resolveTabUrl: () => Promise.resolve(url),
    tools: [
      { name: 'fake.read', risk: 'R0', returns: { title: 'A page' }, siteAuthorization: 'page' },
      // R2 rather than R1, because R1 is below the auto-approval line and
      // never reaches the stage where a standing grant is consulted. A suite
      // about site grants built on an R1 tool would be watching a decision the
      // engine takes two stages earlier.
      {
        name: 'fake.write',
        risk: 'R2',
        returns: { written: true },
        siteAuthorization: 'page',
      },
      {
        name: 'fake.second',
        risk: 'R2',
        returns: { written: true },
        siteAuthorization: 'page',
      },
    ],
  });
}

/** Dispatches one call the way a running task does, so the recorder sees it. */
async function dispatch(
  harness: WorkflowHarness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await harness.tools.dispatch({
    toolCallId: `tc_${name}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: TASK,
    sessionId: SESSION,
    name,
    arguments: args,
    taintState: UNTAINTED,
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    tabId: TAB,
    signal: new AbortController().signal,
  });
}

/** Records the given calls and stores what was captured. */
async function recordAndSave(
  harness: WorkflowHarness,
  calls: readonly { name: string; args?: Record<string, unknown> }[],
): Promise<{ workflowId: string; definition: SkillDefinition }> {
  harness.recorder.start(TASK);
  for (const call of calls) await dispatch(harness, call.name, call.args ?? {});
  const captured = harness.recorder.stop();
  expect(captured, 'nothing was captured').not.toBeNull();
  const saved = await harness.store.save({
    name: 'A recording',
    description: 'Recorded from a task.',
    definition: captured!.definition,
    recordedFromTaskId: TASK,
    taintAtCapture: 'KNOWN_UNTAINTED',
  });
  return { workflowId: saved.workflowId, definition: captured!.definition };
}

function replay(harness: WorkflowHarness, workflowId: string) {
  return harness.replayer.replay({ workflowId, sessionId: SESSION, inputs: {} });
}

/** A standing rule, shaped the way the permission engine writes one. */
function policyWith(rule: Partial<SitePolicyState['rules'][number]> & { site: string }) {
  return {
    ...emptySitePolicyState(),
    rules: [
      {
        decision: 'allow' as const,
        maxRisk: 'R2' as const,
        createdAt: 1,
        ...rule,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// A. site authorization is re-earned
// ---------------------------------------------------------------------------

describe('TEST-SECURITY-075 group A: the site policy that applies is the one in force now', () => {
  it('01 — a grant that covered the recording still covers an unchanged replay', async () => {
    // The control the rest of the group needs. Without it, every case below
    // would pass against a build whose replay refused unconditionally.
    const harness = harnessOn();
    await harness.saveSitePolicy(policyWith({ site: 'recorded.test' }));

    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);
    const before = harness.prompts().length;

    const outcome = await replay(harness, workflowId);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.result.status).toBe('completed');
    // Silent, because the grant covers it.
    expect(harness.prompts().length).toBe(before);
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(2);
  });

  it('02 — revoking the grant between recording and replay brings the confirmation back', async () => {
    const harness = harnessOn();
    await harness.saveSitePolicy(policyWith({ site: 'recorded.test' }));

    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);

    // The user changed their mind. The recording did not bank the approval it
    // ran under, so it has nothing to fall back on.
    await harness.saveSitePolicy(emptySitePolicyState());
    const before = harness.prompts().length;

    harness.respondWith('deny');
    const outcome = await replay(harness, workflowId);

    expect(harness.prompts().length).toBeGreaterThan(before);
    expect(outcome.ok && outcome.result.status).toBe('failed');
    // Asked, refused, and the write never happened a second time.
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(1);
  });

  it('03 — a site blocked after the recording refuses the replay outright', async () => {
    // The grant stays in place and a block is added beside it, which is the
    // shape this actually takes: a user who trusted a site and then changed
    // their mind. It also makes the precedence load-bearing — with the block
    // alone, a build that ignored `decision` entirely would still refuse,
    // because there would be nothing else to find.
    const harness = harnessOn();
    await harness.saveSitePolicy(policyWith({ site: 'recorded.test' }));
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);
    const before = harness.prompts().length;

    await harness.saveSitePolicy({
      ...emptySitePolicyState(),
      rules: [
        { site: 'recorded.test', decision: 'allow', maxRisk: 'R2', createdAt: 1 },
        { site: 'recorded.test', decision: 'block', maxRisk: 'R2', createdAt: 2 },
      ],
    });

    // Approve everything, so the only thing that can stop this is the block.
    harness.respondWith('approve_once');
    const outcome = await replay(harness, workflowId);

    expect(outcome.ok && outcome.result.status).toBe('failed');
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(1);
    // A block is a denial, not a question: nothing was asked on the way to it.
    expect(harness.prompts().length).toBe(before);
  });

  it('04 — a grant for the recording’s site does not cover a replay on another one', async () => {
    const harness = harnessOn();
    await harness.saveSitePolicy(policyWith({ site: 'recorded.test' }));
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);

    // Same recording, same steps, different page. A grant answers "is this
    // site trusted", and this is not that site.
    const elsewhere = buildWorkflowHarness({
      permissionMode: 'auto',
      activeTabId: TAB,
      resolveTabUrl: () => Promise.resolve('https://elsewhere.test/form'),
      tools: [
        { name: 'fake.read', risk: 'R0', returns: {}, siteAuthorization: 'page' },
        { name: 'fake.write', risk: 'R2', returns: {}, siteAuthorization: 'page' },
      ],
    });
    await elsewhere.saveSitePolicy(policyWith({ site: 'recorded.test' }));
    const moved = await elsewhere.store.save({
      name: 'A recording',
      description: 'The same recording, on another site.',
      definition: (await harness.store.get(workflowId))!.definition,
      recordedFromTaskId: TASK,
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    elsewhere.respondWith('deny');
    const outcome = await replay(elsewhere, moved.workflowId);

    expect(elsewhere.prompts().length).toBeGreaterThan(0);
    expect(outcome.ok && outcome.result.status).toBe('failed');
    expect(elsewhere.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B. the mode in force is the replay's
// ---------------------------------------------------------------------------

describe('TEST-SECURITY-075 group B: the permission mode is read at replay, not recorded', () => {
  it('05 — a workflow recorded in skip mode still confirms when replayed in manual', async () => {
    // The direction that matters. A recording made while nothing was being
    // asked must not carry that silence forward as though it were consent.
    const harness = harnessOn(SITE_URL, 'skip');
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);
    expect(harness.prompts()).toEqual([]);

    harness.setMode('manual');
    harness.respondWith('deny');
    const outcome = await replay(harness, workflowId);

    expect(harness.prompts()).toContain('fake.write');
    expect(outcome.ok && outcome.result.status).toBe('failed');
    expect(harness.seen.filter((call) => call.tool === 'fake.write')).toHaveLength(1);
  });

  it('06 — and the mode is read at replay in the other direction too', async () => {
    // NEGATIVE CONTROL for 05. Without it, 05 would pass against a build whose
    // replay always prompts — which would be a different product, not this
    // property. What is being shown is that the mode in force decides, and the
    // user loosening their own mode is their decision to make.
    const harness = harnessOn(SITE_URL, 'manual');
    harness.respondWith('approve_once');
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);
    expect(harness.prompts()).toContain('fake.write');

    harness.setMode('skip');
    const before = harness.prompts().length;
    const outcome = await replay(harness, workflowId);

    expect(outcome.ok && outcome.result.status).toBe('completed');
    expect(harness.prompts().length).toBe(before);
  });

  it('07 — the replay task records the mode it actually ran under', async () => {
    // The record and the enforcement have to agree. The engine reads the live
    // setting on every dispatch; the task stamps what was in force when it
    // started. A stamp taken from the recording would describe a run that
    // never happened.
    const harness = harnessOn(SITE_URL, 'skip');
    const { workflowId } = await recordAndSave(harness, [{ name: 'fake.read' }]);

    harness.setMode('manual');
    harness.respondWith('approve_once');
    const outcome = await replay(harness, workflowId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const task = await harness.tasks.getTask(outcome.taskId);
    expect(task?.permissionMode).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// C. a list argument stores or refuses
// ---------------------------------------------------------------------------

describe('TEST-SECURITY-075 group C: a recorded list can be replayed or was never stored', () => {
  it('08 — a recorded list of short values replays with the same list', async () => {
    // The end-to-end proof for the parameteriser's list case. Before it, a
    // tainted list became a slot, `SkillInputType` had no list member, and the
    // replayed call failed its own schema every time — a recording that looked
    // complete in the review surface and could never run.
    const harness = harnessOn();
    harness.setTaint({
      kind: 'TAINTED',
      sources: [{ sourceType: 'page', site: 'recorded.test', sensitivity: 'internal' }],
    });

    const { workflowId, definition } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write', args: { values: ['bags', 'meal'] } },
    ]);

    // The step was recorded at all, which is the half a dropped step would
    // fail. Without this the case passes against a build that refuses the list
    // and silently records a read-only workflow, because the last `fake.write`
    // the harness saw would then be the recording's own.
    expect(definition.steps.map((step) => step.kind === 'tool' && step.tool)).toEqual([
      'fake.read',
      'fake.write',
    ]);
    // Stored as written, and asked for at replay by nothing.
    expect(definition.inputs).toEqual([]);

    const callsWhileRecording = harness.seen.filter((call) => call.tool === 'fake.write').length;
    const outcome = await replay(harness, workflowId);
    expect(outcome.ok && outcome.result.status).toBe('completed');

    // It really ran a second time, with the same list.
    const calls = harness.seen.filter((call) => call.tool === 'fake.write');
    expect(calls.length).toBe(callsWhileRecording + 1);
    expect(calls.at(-1)?.args['values']).toEqual(['bags', 'meal']);
  });

  it('09 — a list it could not store is dropped, and the recording refuses to replay', async () => {
    // NEGATIVE CONTROL and the fail-closed half: the alternative to storing is
    // never "ask for it at replay", because a slot supplies one scalar. A step
    // that cannot be stored leaves a gap the recording reports.
    const harness = harnessOn();
    harness.setTaint({
      kind: 'TAINTED',
      sources: [{ sourceType: 'page', site: 'recorded.test', sensitivity: 'internal' }],
    });

    harness.recorder.start(TASK);
    await dispatch(harness, 'fake.read');
    await dispatch(harness, 'fake.write', { values: ['bags', 'a value with spaces in it'] });
    const captured = harness.recorder.stop()!;

    expect(captured.definition.steps.map((step) => step.kind === 'tool' && step.tool)).toEqual([
      'fake.read',
    ]);
    expect(captured.summary.skipped.map((entry) => entry.tool)).toEqual(['fake.write']);
    expect(captured.summary.skipped[0]?.reason).toMatch(/list cannot be asked for/);

    const saved = await harness.store.save({
      name: 'An incomplete recording',
      description: 'Recorded from a task.',
      definition: captured.definition,
      recordedFromTaskId: TASK,
      taintAtCapture: 'TAINTED',
      droppedSteps: captured.summary.skipped,
    });
    const outcome = await replay(harness, saved.workflowId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('INCOMPLETE_RECORDING');
  });
});

// ---------------------------------------------------------------------------
// D. failure semantics
// ---------------------------------------------------------------------------

describe('TEST-SECURITY-075 group D: a failed replay stops, and leaves nothing to resume', () => {
  it('10 — a replay refused at the second step ran the first and not the third', async () => {
    const harness = harnessOn(SITE_URL, 'manual');
    harness.respondWith('approve_once');
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
      { name: 'fake.second' },
    ]);
    const readsWhileRecording = harness.seen.filter((call) => call.tool === 'fake.read').length;

    // Approve the read, refuse the write. The step after it must not run: a
    // workflow is an ordered thing, and continuing past a refusal would do
    // something nobody recorded.
    let answered = 0;
    harness.respondPerTool((tool) => {
      answered += 1;
      return tool === 'fake.write' ? 'deny' : 'approve_once';
    });

    const outcome = await replay(harness, workflowId);
    expect(answered).toBeGreaterThan(0);
    expect(outcome.ok && outcome.result.status).toBe('failed');
    if (!outcome.ok) return;

    const steps = outcome.result.steps;
    expect(steps.map((step) => step.ran)).toEqual(['fake.read', 'fake.write']);
    expect(steps.at(-1)?.status).not.toBe('completed');
    // The read really ran again; the third step never did.
    expect(harness.seen.filter((call) => call.tool === 'fake.read').length).toBe(
      readsWhileRecording + 1,
    );
    expect(harness.seen.filter((call) => call.tool === 'fake.second')).toHaveLength(1);
  });

  it('11 — a failed replay leaves no run record to resume from', async () => {
    // There is no "continue where it stopped" for a workflow, and that is the
    // safe answer rather than a missing feature: resuming would mean carrying
    // the decisions the earlier steps were given into a later moment. Starting
    // again re-asks everything, which is the only thing that can be reasoned
    // about.
    const harness = harnessOn(SITE_URL, 'manual');
    // Approved while recording, so the write is in the recording at all; the
    // refusal that matters is the one given at replay.
    harness.respondWith('approve_once');
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);

    harness.respondWith('deny');
    const outcome = await replay(harness, workflowId);
    expect(outcome.ok && outcome.result.status).toBe('failed');
    if (!outcome.ok) return;

    // The replayer never starts a skill run record, so nothing exists for a
    // resume path to find. Asserted from the source as well, because "no
    // record" is only durable while nothing starts one — and read with the
    // comments stripped, so the prose above it cannot make the check pass or
    // fail.
    const source = resolve(import.meta.dirname, '../../src/workflows/workflow-replay.ts');
    const code = withoutComments(readFileSync(source, 'utf8'));
    expect(code).not.toMatch(/\bruns[.?]/);
    expect(code).not.toContain('SkillRunStore');
  });

  it('12 — replaying again after a failure starts from the first step and asks again', async () => {
    const harness = harnessOn(SITE_URL, 'manual');
    harness.respondWith('approve_once');
    const { workflowId } = await recordAndSave(harness, [
      { name: 'fake.read' },
      { name: 'fake.write' },
    ]);

    harness.respondWith('deny');
    const first = await replay(harness, workflowId);
    expect(first.ok && first.result.status).toBe('failed');

    const promptsAfterFailure = harness.prompts().length;
    harness.respondWith('approve_once');
    const second = await replay(harness, workflowId);

    expect(second.ok && second.result.status).toBe('completed');
    if (!second.ok) return;
    // Every step, from the beginning — not a continuation from where the
    // previous attempt stopped.
    expect(second.result.steps.map((step) => step.ran)).toEqual(['fake.read', 'fake.write']);
    expect(harness.prompts().length).toBeGreaterThan(promptsAfterFailure);
    // And it is a task of its own, so the trail shows two attempts.
    expect(second.taskId).not.toBe(first.ok ? first.taskId : '');
  });
});
