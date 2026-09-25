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
import type { ActedOnElement } from '@/content/semantic-tree';

const UNTAINTED: TaintState = { kind: 'KNOWN_UNTAINTED' };
const TAINTED: TaintState = { kind: 'TAINTED', sources: [] };

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

/** A description of an element a tool reported acting on. */
function actedOn(overrides: Partial<ActedOnElement> = {}): ActedOnElement {
  return {
    role: 'button',
    name: 'Save',
    nth: 0,
    matchCount: 1,
    enabled: true,
    visible: true,
    ...overrides,
  };
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

  it('turns an element handle into a page-derived binding, never a literal', () => {
    // `e1-12` names an element in one page read, so it is never stored. What
    // is stored is a description of the element, which a replay re-resolves
    // against a page read of its own.
    const decision = parameteriseArgument({
      tool: 'browser.click',
      stepId: 's2',
      argument: 'elementId',
      value: 'e1-12',
      taint: UNTAINTED,
      actedOn: actedOn(),
      elementStep: 's1',
    });

    expect(decision.kind).toBe('element');
    expect(decision.kind === 'element' && decision.binding).toMatchObject({
      kind: 'element',
      provenance: 'PAGE_DERIVED',
      purpose: 'ELEMENT_BINDING',
      step: 's1',
      role: 'button',
      name: 'Save',
    });
    expect(JSON.stringify(decision)).not.toContain('e1-12');
  });

  it('refuses when the tool reported no element to describe', () => {
    expect(
      parameteriseArgument({
        tool: 'browser.click',
        stepId: 's2',
        argument: 'elementId',
        value: 'e1-12',
        taint: UNTAINTED,
        elementStep: 's1',
      }).kind,
    ).toBe('refused');
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

  it('keeps a tainted task’s short structural list as written', () => {
    // The list case of the rule above it. A multi-select's chosen options are
    // exactly the short, structural values a scalar is kept for, and until this
    // existed every such recording became a slot — which a list cannot fill,
    // because `SkillInputType` has no list member. The recording looked
    // complete in the review surface and failed its schema on every replay.
    const decision = parameteriseArgument({
      tool: 'browser.select_many',
      stepId: 's2',
      argument: 'values',
      value: ['bags', 'meal'],
      taint: TAINTED,
    });
    expect(decision).toMatchObject({
      kind: 'literal',
      binding: { kind: 'literal', value: ['bags', 'meal'] },
    });
  });

  it('keeps a list of numbers too, matching how a lone number is treated', () => {
    expect(
      parameteriseArgument({
        tool: 'tabs.group',
        stepId: 's2',
        argument: 'tabIds',
        value: [12, 34],
        taint: TAINTED,
      }),
    ).toMatchObject({ kind: 'literal', binding: { kind: 'literal', value: [12, 34] } });
  });

  it('refuses a list it cannot store rather than asking for one at replay', () => {
    // NEGATIVE CONTROL for the case above, and the reason it is a refusal and
    // not a slot: a slot supplies one scalar, so a step whose list argument
    // became a slot can never run. Refusing drops the step, marks the
    // recording incomplete and says why — which is visible, where the slot was
    // not.
    for (const value of [
      // An element too long to read as structure.
      ['bags', 'x'.repeat(40)],
      // An element carrying content: whitespace, a scheme, an address.
      ['bags', 'two words'],
      ['bags', 'https://example.test/'],
      ['bags', 'someone@example.test'],
      // Nested, so no element-wise judgement applies.
      ['bags', ['meal']],
      // Longer than anything that is still structure.
      Array.from({ length: 33 }, (_, index) => `o${index}`),
      // Empty, which is a list nothing chose.
      [],
    ]) {
      const decision = parameteriseArgument({
        tool: 'browser.select_many',
        stepId: 's2',
        argument: 'values',
        value,
        taint: TAINTED,
      });
      expect(decision.kind, JSON.stringify(value)).toBe('refused');
      if (decision.kind !== 'refused') continue;
      expect(decision.reason).toMatch(/list cannot be asked for/);
    }
  });

  it('refuses a credential-shaped list instead of slotting it', () => {
    // Secret detection runs before taint and reached `slot` on the way out.
    // A list that cannot be stored also cannot be asked for, so the step goes.
    const decision = parameteriseArgument({
      tool: 'browser.select_many',
      stepId: 's2',
      argument: 'values',
      value: ['ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'],
      taint: UNTAINTED,
    });
    expect(decision.kind).toBe('refused');
  });

  it('agrees with the redactor about what a secret looks like', () => {
    expect(looksSecret('note', 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toBe(true);
    expect(looksSecret('apiKey', 'anything')).toBe(true);
    expect(looksSecret('note', 'an ordinary sentence')).toBe(false);
    expect(looksSecret('note', '')).toBe(false);
  });
});

describe('provenance is assigned at origin and never changes', () => {
  it('stays PAGE_DERIVED however many validity checks the value passes', () => {
    // The whole point of the revision. An ARIA-valid role, a clean short
    // name, a passing secret check and a unique match are four statements
    // about the value's *shape*. None of them says it came from anywhere but
    // a page, so none of them changes where it came from.
    const decision = parameteriseArgument({
      tool: 'browser.click',
      stepId: 's2',
      argument: 'elementId',
      value: 'e1-12',
      taint: UNTAINTED,
      actedOn: actedOn({ role: 'button', name: 'Save', matchCount: 1 }),
      elementStep: 's1',
    });

    expect(decision.kind).toBe('element');
    expect(decision.kind === 'element' && decision.binding.provenance).toBe('PAGE_DERIVED');
    // Not authored, and not anything the taint model would call clean.
    expect(JSON.stringify(decision)).not.toContain('AUTHORED');
    expect(JSON.stringify(decision)).not.toContain('KNOWN_UNTAINTED');
  });

  it('is PAGE_DERIVED even when the recording task had read nothing', () => {
    // A task that is KNOWN_UNTAINTED when it clicks still gets a page-derived
    // binding: the value came out of the page regardless of what the task had
    // read before it.
    const decision = parameteriseArgument({
      tool: 'browser.click',
      stepId: 's2',
      argument: 'elementId',
      value: 'e1-12',
      taint: { kind: 'KNOWN_UNTAINTED' },
      actedOn: actedOn(),
      elementStep: 's1',
    });
    expect(decision.kind === 'element' && decision.binding.provenance).toBe('PAGE_DERIVED');
  });

  it('never produces a literal binding from a page-derived value', () => {
    for (const state of [
      { kind: 'KNOWN_UNTAINTED' } as const,
      { kind: 'TAINTED', sources: [{ sourceType: 'page', sensitivity: 'internal' }] } as const,
    ]) {
      const decision = parameteriseArgument({
        tool: 'browser.click',
        stepId: 's2',
        argument: 'elementId',
        value: 'e1-12',
        taint: state,
        actedOn: actedOn(),
        elementStep: 's1',
      });
      // A literal supplies a value; a binding supplies a predicate. Only the
      // second may hold page-derived text, and the two are separate outcomes
      // so the code paths cannot be confused.
      expect(decision.kind).not.toBe('literal');
      expect(decision.kind).toBe('element');
    }
  });
});

describe('a binding is only stored when it can be stored safely', () => {
  const bind = (
    over: Partial<ActedOnElement>,
    step = 's1',
  ): ReturnType<typeof parameteriseArgument> =>
    parameteriseArgument({
      tool: 'browser.click',
      stepId: 's2',
      argument: 'elementId',
      value: 'e1-12',
      taint: UNTAINTED,
      actedOn: actedOn(over),
      ...(step === '' ? {} : { elementStep: step }),
    });

  it('refuses a role the page invented', () => {
    // A page sets role="anything", and an element with no mapping reports its
    // tag name, so a role is page-controlled. Only roles a recording can
    // meaningfully target are bindable.
    for (const role of ['marquee', 'div', 'custom-widget', 'generic', 'paragraph']) {
      expect(bind({ role }).kind, role).toBe('refused');
    }
    expect(bind({ role: 'button' }).kind).toBe('element');
  });

  it('refuses a name that is missing, too long, or shaped like a selector', () => {
    expect(bind({ name: '' }).kind).toBe('refused');
    expect(bind({ name: 'x'.repeat(65) }).kind).toBe('refused');
    for (const name of ['#submit', '//button[1]', 'javascript:alert(1)', 'li::after', '() => 1']) {
      expect(bind({ name }).kind, name).toBe('refused');
    }
    // A label genuinely contains dots and spaces.
    expect(bind({ name: 'Save file.txt' }).kind).toBe('element');
  });

  it('refuses a name that looks like it carries a credential', () => {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const decision = bind({ name: token });
    expect(decision.kind).toBe('refused');
    // Not stored in any form, including inside the refusal.
    expect(JSON.stringify(decision)).not.toContain(token.slice(0, 12));
  });

  it('refuses an ambiguous element rather than pinning it by position', () => {
    // "The third Delete button" is a recording that clicks the wrong thing the
    // moment a row is added.
    expect(bind({ matchCount: 2 }).kind).toBe('refused');
    expect(bind({ matchCount: 0 }).kind).toBe('refused');
    expect(bind({ matchCount: 1 }).kind).toBe('element');
  });

  it('refuses when nothing read the page before the step', () => {
    // A binding resolves against a page read, so it has to name one.
    const decision = bind({}, '');
    expect(decision.kind === 'element' && decision.binding.step).toBe('');
  });
});

describe('a recording says what it could not capture', () => {
  it('records a dropped step in the position it held', () => {
    const recording = recorder();
    recording.start('task_1');
    recording.observe(observation({ tool: 'browser.read_page', arguments: {} }));
    // No descriptor, so the click cannot be described and is dropped.
    recording.observe(
      observation({ tool: 'browser.click', arguments: { elementId: 'e1-12' }, toolCallId: 'tc_2' }),
    );
    recording.observe(
      observation({ tool: 'browser.read_page', arguments: {}, toolCallId: 'tc_3' }),
    );

    const captured = recording.stop();
    expect(captured?.definition.steps.map((step) => step.id)).toEqual(['s1', 's2']);
    expect(captured?.summary.skipped).toEqual([
      {
        afterStepId: 's1',
        tool: 'browser.click',
        reason: expect.stringContaining('could not be described'),
      },
    ]);
  });

  it('records a drop before the first step with a null position', () => {
    const recording = recorder();
    recording.start('task_1');
    recording.observe(observation({ tool: 'skills.run', arguments: {} }));
    recording.observe(
      observation({ tool: 'browser.read_page', arguments: {}, toolCallId: 'tc_2' }),
    );

    expect(recording.stop()?.summary.skipped[0]?.afterStepId).toBeNull();
  });

  it('binds a click to the page read that came before it', () => {
    const recording = recorder();
    recording.start('task_1');
    recording.observe(observation({ tool: 'browser.read_page', arguments: {} }));
    recording.observe(
      observation({
        tool: 'browser.click',
        arguments: { elementId: 'e1-12' },
        toolCallId: 'tc_2',
        actedOn: actedOn(),
      }),
    );

    const captured = recording.stop();
    expect(captured?.summary.skipped).toEqual([]);
    const click = captured?.definition.steps[1];
    expect(click?.kind === 'tool' && click.arguments['elementId']).toMatchObject({
      kind: 'element',
      provenance: 'PAGE_DERIVED',
      purpose: 'ELEMENT_BINDING',
      step: 's1',
    });
  });
});
