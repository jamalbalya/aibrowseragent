/**
 * TEST-WORKFLOW-001 — what the recorder captures, and what it refuses to.
 *
 * The security boundary is covered by TEST-SECURITY-P022; this is the
 * behaviour underneath it — which calls become steps, which become slots, and
 * what happens to a recording that cannot be made safely.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowRecorder } from '@/workflows/workflow-recorder';
import { RECORDED_PROVENANCE } from '@/workflows/workflow-model';
import { parameteriseArgument, slotName, looksSecret } from '@/workflows/parameteriser';
import { MAX_STEPS_PER_SKILL } from '@/skills/core/skill-model';
import type { DispatchObservation } from '@/tools/registry/tool-registry';
import type { TaintState } from '@/security/taint/taint-state';

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };

function observation(overrides: Partial<DispatchObservation> = {}): DispatchObservation {
  return {
    taskId: 'task_1',
    toolCallId: 'tc_1',
    tool: 'browser.navigate',
    arguments: { url: 'https://example.test/' },
    risk: 'R1',
    executed: true,
    status: 'success',
    ...overrides,
  };
}

function recorder(taint: TaintState = UNTAINTED): WorkflowRecorder {
  return new WorkflowRecorder({ taintFor: () => taint });
}

describe('the recorder captures what happened, and nothing else', () => {
  it('records completed calls and ignores refused or failed ones', () => {
    const recording = recorder();
    recording.start('task_1');

    recording.observe(observation());
    // Refused before execution: nobody did this, so it is not something to
    // propose doing again.
    recording.observe(observation({ tool: 'browser.click', executed: false, status: 'error' }));
    // Executed but failed.
    recording.observe(observation({ tool: 'browser.click', status: 'error' }));

    const captured = recording.stop();
    expect(captured?.definition.steps).toHaveLength(1);
    expect(captured?.definition.steps[0]).toMatchObject({ kind: 'tool', tool: 'browser.navigate' });
  });

  it('ignores calls belonging to a different task', () => {
    const recording = recorder();
    recording.start('task_1');
    recording.observe(observation({ taskId: 'task_2' }));
    expect(recording.stop()).toBeNull();
  });

  it('never records a skill run, a file picker or a detach', () => {
    const recording = recorder();
    recording.start('task_1');
    for (const tool of ['skills.run', 'skills.list', 'files.select', 'debugger.detach']) {
      recording.observe(observation({ tool }));
    }
    expect(recording.stop()).toBeNull();
  });

  it('stops growing at the step ceiling rather than producing an invalid definition', () => {
    const recording = recorder();
    recording.start('task_1');
    for (let index = 0; index < MAX_STEPS_PER_SKILL + 5; index += 1) {
      recording.observe(observation({ toolCallId: `tc_${index}` }));
    }
    const captured = recording.stop();
    expect(captured?.definition.steps).toHaveLength(MAX_STEPS_PER_SKILL);
    expect(captured?.summary.skipped.length).toBe(5);
  });

  it('marks what it produces as recorded, never as bundled', () => {
    const recording = recorder();
    recording.start('task_1');
    recording.observe(observation());
    expect(recording.stop()?.definition.provenance).toBe(RECORDED_PROVENANCE);
  });

  it('discards everything on cancel', () => {
    const recording = recorder();
    recording.start('task_1');
    recording.observe(observation());
    recording.cancel();
    expect(recording.isRecording()).toBe(false);
    expect(recording.stop()).toBeNull();
  });

  it('drops the whole step when one of its arguments cannot be stored', () => {
    // An UNKNOWN security context refuses every argument, so the step is not
    // recorded half-bound — a partial step would replay as something nobody
    // did.
    const recording = recorder({ kind: 'UNKNOWN', reason: 'field-absent' });
    recording.start('task_1');
    recording.observe(observation());
    expect(recording.stop()).toBeNull();
  });

  it('reports the broadest taint it saw, because taint only widens', () => {
    let taint: TaintState = UNTAINTED;
    const recording = new WorkflowRecorder({ taintFor: () => taint });
    recording.start('task_1');
    recording.observe(observation());
    taint = { kind: 'TAINTED', sources: [{ sourceType: 'page', sensitivity: 'internal' }] };
    recording.observe(observation({ toolCallId: 'tc_2' }));
    expect(recording.stop()?.taint).toBe('TAINTED');
  });
});

describe('the parameteriser decides literal, slot or refusal', () => {
  it('keeps a clean task’s plain values as literals', () => {
    const decision = parameteriseArgument({
      tool: 'browser.navigate',
      stepId: 's1',
      argument: 'url',
      value: 'https://example.test/',
      taint: UNTAINTED,
    });
    expect(decision).toMatchObject({
      kind: 'literal',
      binding: { kind: 'literal', value: 'https://example.test/' },
    });
  });

  it('keeps flags as written, because they are structure rather than data', () => {
    for (const argument of ['clearFirst', 'submit']) {
      expect(
        parameteriseArgument({
          tool: 'browser.type',
          stepId: 's1',
          argument,
          value: true,
          taint: UNTAINTED,
        }).kind,
      ).toBe('literal');
    }
  });

  it('refuses an element handle rather than storing one that can never replay', () => {
    // `e1-12` names an element in one page read. A replay reads the page
    // again, which mints a new snapshot, so a stored handle is refused as
    // stale every time — measured in Chromium, not assumed. Recording it would
    // put a step into a workflow that cannot succeed.
    const decision = parameteriseArgument({
      tool: 'browser.click',
      stepId: 's1',
      argument: 'elementId',
      value: 'e1-12',
      taint: UNTAINTED,
    });
    expect(decision.kind).toBe('refused');
  });

  it('names a slot after where the value goes, so two steps never collide', () => {
    expect(slotName('s1', 'url')).toBe('s1_url');
    expect(slotName('s2', 'url')).toBe('s2_url');
    expect(slotName('s-1', 'a.b')).toBe('s_1_a_b');
  });

  it('describes a slot without quoting what it replaced', () => {
    const decision = parameteriseArgument({
      tool: 'connector.github.create_issue',
      stepId: 's1',
      argument: 'body',
      value: 'a long body that this task read from somewhere and must not keep',
      taint: { kind: 'TAINTED', sources: [{ sourceType: 'page', sensitivity: 'internal' }] },
    });
    expect(decision.kind).toBe('slot');
    expect(decision.kind === 'slot' && decision.input.description).not.toContain('somewhere');
  });

  it('agrees with the redactor about what a secret looks like', () => {
    expect(looksSecret('note', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toBe(true);
    expect(looksSecret('apiKey', 'anything')).toBe(true);
    expect(looksSecret('note', 'an ordinary sentence')).toBe(false);
    expect(looksSecret('note', '')).toBe(false);
  });
});
