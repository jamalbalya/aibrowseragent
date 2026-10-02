/**
 * TEST-WORKFLOW-003 — how a step is described to the person approving it.
 *
 * ## Why this file exists
 *
 * The mapping it covers used to be a four-branch conditional expression inside
 * `summariseWorkflow` in `service-worker.ts`, reachable only by assembling a
 * whole `RecordedWorkflow` and going through a panel route. Nothing could call
 * it, so nothing checked it, and a wrong branch is not a cosmetic defect: a
 * review surface that says a step will be *asked for at replay* when it will
 * in fact use a stored literal has misdescribed an action the user is about to
 * approve. `doctor-verdict.ts` records the same extraction being made for the
 * same reason, and the two copies it found had already drifted apart.
 *
 * Every branch is pinned here, and so is the ordering of steps against the
 * gaps between them — because the position of a gap is what tells a reader
 * what a workflow will not do.
 */
import { describe, expect, it } from 'vitest';
import { describeBinding, digestStep, digestSteps, interleave } from '@/workflows/step-digest';
import type { DroppedStep } from '@/workflows/workflow-model';
import type { ElementBinding, SkillStep } from '@/skills/core/skill-model';

const ELEMENT: ElementBinding = {
  kind: 'element',
  provenance: 'PAGE_DERIVED',
  purpose: 'ELEMENT_BINDING',
  step: 's1',
  role: 'button',
  name: 'Log in',
};

function toolStep(overrides: Partial<Extract<SkillStep, { kind: 'tool' }>> = {}): SkillStep {
  return {
    kind: 'tool',
    id: 's1',
    tool: 'browser.navigate',
    description: 'Recorded browser.navigate.',
    arguments: { url: { kind: 'literal', value: 'https://example.test/' } },
    ...overrides,
  };
}

describe('each binding says where its value will come from', () => {
  it('shows a literal’s value, because that is what the step will do', () => {
    // Shown rather than hidden: nothing reaches a literal that the
    // parameteriser was unwilling to store, so there is no value here that
    // was not already cleared for disk.
    expect(describeBinding({ kind: 'literal', value: 'https://example.test/' })).toEqual({
      kind: 'literal',
      detail: '"https://example.test/"',
    });
    // JSON rather than String(), so a reader can tell "1" from 1 and sees the
    // shape of a structural argument instead of "[object Object]".
    expect(describeBinding({ kind: 'literal', value: 1 }).detail).toBe('1');
    expect(describeBinding({ kind: 'literal', value: true }).detail).toBe('true');
    expect(describeBinding({ kind: 'literal', value: ['a', 'b'] }).detail).toBe('["a","b"]');
  });

  it('says a slot will be asked for, and names it without inventing a value', () => {
    const digest = describeBinding({ kind: 'input', name: 's1_password' });
    expect(digest.kind).toBe('input');
    expect(digest.detail).toContain('asked for at replay');
    expect(digest.detail).toContain('s1_password');
  });

  it('names the step a reference reads from rather than guessing its result', () => {
    const digest = describeBinding({ kind: 'step', step: 's2', path: 'handles.0.id' });
    expect(digest.kind).toBe('step');
    expect(digest.detail).toBe('from step s2');
  });

  it('says plainly that an element binding’s words were read from the page', () => {
    // The reader has to be able to tell a way of finding something again from
    // data the workflow carries, because the two are the same bytes.
    const digest = describeBinding(ELEMENT);
    expect(digest.kind).toBe('element');
    expect(digest.detail).toBe('the button named "Log in" (read from the page)');
  });

  it('describes all four kinds and never falls through to an empty detail', () => {
    // A fifth binding would be a compile error here rather than a blank cell
    // in the review list.
    for (const binding of [
      { kind: 'literal', value: null },
      { kind: 'input', name: 'n' },
      { kind: 'step', step: 's1', path: 'a' },
      ELEMENT,
    ] as const) {
      const digest = describeBinding(binding);
      expect(digest.kind, JSON.stringify(binding)).toBe(binding.kind);
      expect(digest.detail.length, JSON.stringify(binding)).toBeGreaterThan(0);
    }
  });
});

describe('a step is named by what it does', () => {
  it('names a tool step by its tool', () => {
    expect(digestStep(toolStep())).toEqual({
      id: 's1',
      tool: 'browser.navigate',
      description: 'Recorded browser.navigate.',
      arguments: { url: { kind: 'literal', detail: '"https://example.test/"' } },
    });
  });

  it('names a skill step by the skill it delegates to', () => {
    // The field is shared because the reviewer's question is shared: what does
    // this do. A skill step reading `undefined` there would describe nothing.
    const digest = digestStep({
      kind: 'skill',
      id: 's2',
      skill: 'research.summarise',
      skillVersion: '1.2.0',
      description: 'Summarise the page.',
      arguments: {},
    });
    expect(digest.tool).toBe('research.summarise');
    expect(digest.id).toBe('s2');
  });

  it('keeps every argument, so no argument disappears from a review', () => {
    const digest = digestStep(
      toolStep({
        arguments: {
          url: { kind: 'literal', value: 'https://example.test/' },
          token: { kind: 'input', name: 's1_token' },
          target: ELEMENT,
        },
      }),
    );
    expect(Object.keys(digest.arguments).sort()).toEqual(['target', 'token', 'url']);
  });

  it('keeps steps in the order they were recorded', () => {
    const digested = digestSteps([
      toolStep({ id: 's1', tool: 'browser.navigate' }),
      toolStep({ id: 's2', tool: 'browser.read_page' }),
      toolStep({ id: 's3', tool: 'browser.click' }),
    ]);
    expect(digested.map((step) => step.id)).toEqual(['s1', 's2', 's3']);
    expect(digested.map((step) => step.tool)).toEqual([
      'browser.navigate',
      'browser.read_page',
      'browser.click',
    ]);
  });
});

describe('a gap is shown where it happened', () => {
  const dropped = (afterStepId: string | null, tool: string): DroppedStep => ({
    afterStepId,
    tool,
    reason: 'a value in this step could not be stored',
  });

  it('places a drop after the step it followed', () => {
    const entries = interleave({
      steps: digestSteps([toolStep({ id: 's1' }), toolStep({ id: 's2' })]),
      droppedSteps: [dropped('s1', 'browser.click')],
    });
    expect(
      entries.map((entry) => (entry.kind === 'step' ? entry.step.id : entry.dropped.tool)),
    ).toEqual(['s1', 'browser.click', 's2']);
  });

  it('places a drop that came before the first step at the front', () => {
    const entries = interleave({
      steps: digestSteps([toolStep({ id: 's1' })]),
      droppedSteps: [dropped(null, 'browser.type')],
    });
    expect(entries[0]).toMatchObject({ kind: 'dropped' });
    expect(entries[1]).toMatchObject({ kind: 'step' });
  });

  it('shows every drop and every step, losing neither', () => {
    // A gap the reader cannot see is the defect `isIncomplete` exists for.
    const entries = interleave({
      steps: digestSteps([toolStep({ id: 's1' }), toolStep({ id: 's2' })]),
      droppedSteps: [
        dropped(null, 'a'),
        dropped('s1', 'b'),
        dropped('s2', 'c'),
        dropped('s2', 'd'),
      ],
    });
    expect(entries.filter((entry) => entry.kind === 'step')).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === 'dropped')).toHaveLength(4);
  });

  it('gives two drops in the same position distinct keys', () => {
    // They render as siblings in one list; a shared key would collapse them
    // and hide one of the gaps.
    const entries = interleave({
      steps: digestSteps([toolStep({ id: 's1' })]),
      droppedSteps: [dropped('s1', 'browser.click'), dropped('s1', 'browser.click')],
    });
    const indices = entries.flatMap((entry) => (entry.kind === 'dropped' ? [entry.index] : []));
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('is an empty list when there is nothing yet', () => {
    expect(interleave({ steps: [], droppedSteps: [] })).toEqual([]);
  });
});
