/**
 * How a step is described to the person looking at it.
 *
 * ## Why this is its own module
 *
 * It was inline in `summariseWorkflow` in `service-worker.ts`: a nested
 * conditional expression four branches deep, reachable only by assembling a
 * whole `RecordedWorkflow` and calling a panel route. That is the shape the
 * `doctorVerdict` extraction was done for — a mapping no test could call
 * directly, so a mutation to any branch of it survives the suite. The branches
 * are the thing worth checking here, because each one is a claim about what a
 * step will do, and the wrong one is a review surface that misdescribes an
 * action the user is about to approve.
 *
 * It is also needed in two places now. The stored review list and the live
 * recording list describe the same steps, and two copies of this mapping would
 * be two descriptions of one action — the defect the `doctorVerdict` comment
 * records having found between its own two copies.
 *
 * ## What a digest may carry, and why a literal is shown
 *
 * A binding's `detail` is prose the extension wrote, except for a literal,
 * where it is the stored value itself. That is deliberate and it is not a
 * widening: reviewing a workflow means seeing what it will actually do, and
 * nothing reaches a `literal` binding that the parameteriser was unwilling to
 * store — secret detection, then sensitivity, then taint, all before a value
 * becomes one. A value that could not be shown made its step unrecordable
 * instead, so there is no literal here that was not already cleared for disk.
 *
 * The same reasoning is what makes a digest safe to produce for a recording
 * that is still running: those steps went through the identical parameteriser
 * on the way in. A live digest shows no value a saved one would not.
 *
 * A digest carries no result, no output and no page content — a recording
 * holds the steps it would take, never the data those steps read or produced
 * (`ProhibitedWorkflowFieldError`), and a description of one holds less again.
 */
import type { SkillBinding, SkillStep } from '@/skills/core/skill-model';
import type { DroppedStep } from './workflow-model';

/** One binding, as a reviewer reads it. */
export interface BindingDigest {
  readonly kind: string;
  readonly detail: string;
}

/** One step, as both the review list and the live recording list show it. */
export interface StepDigest {
  readonly id: string;
  /** The tool a step calls, or the skill it delegates to. */
  readonly tool: string;
  readonly description: string;
  readonly arguments: Readonly<Record<string, BindingDigest>>;
}

/**
 * Describes one binding.
 *
 * Every branch says where the value will come from, because that is the
 * question a reviewer is answering. A slot says only that something will be
 * asked for, and never invents a value for it; a step reference names the step
 * rather than guessing what it will return; and an element binding says
 * plainly that its words were read from a page, so a reviewer knows they are
 * a way of finding something again and not data the workflow carries.
 */
export function describeBinding(binding: SkillBinding): BindingDigest {
  switch (binding.kind) {
    case 'literal':
      return { kind: binding.kind, detail: JSON.stringify(binding.value) };
    case 'input':
      return { kind: binding.kind, detail: `asked for at replay (${binding.name})` };
    case 'step':
      return { kind: binding.kind, detail: `from step ${binding.step}` };
    case 'element':
      return {
        kind: binding.kind,
        detail: `the ${binding.role} named "${binding.name}" (read from the page)`,
      };
  }
}

/**
 * Describes one step.
 *
 * A `skill` step is named by the skill it delegates to, in the same field a
 * `tool` step names its tool, because the reviewer's question is the same one:
 * what does this do. The two kinds are not merged anywhere else.
 */
export function digestStep(step: SkillStep): StepDigest {
  return {
    id: step.id,
    tool: step.kind === 'tool' ? step.tool : step.skill,
    description: step.description,
    arguments: Object.fromEntries(
      Object.entries(step.arguments).map(([name, binding]) => [name, describeBinding(binding)]),
    ),
  };
}

export function digestSteps(steps: readonly SkillStep[]): readonly StepDigest[] {
  return steps.map(digestStep);
}

/**
 * The steps and the gaps, in the order they happened.
 *
 * A dropped step is shown where it was, not in a list at the end, because
 * where it was is what tells the reader what the workflow will not do — a gap
 * between "navigate" and "read" means something very different from a gap
 * after the last step.
 */
export type ReviewEntry =
  | { readonly kind: 'step'; readonly step: StepDigest }
  | { readonly kind: 'dropped'; readonly dropped: DroppedStep; readonly index: number };

/**
 * Orders a digest and its gaps for display.
 *
 * It lives here rather than in the panel for two reasons. It is the same for a
 * stored workflow and for a recording still running — two sources that carry
 * these same two lists under different names — and a recording that reads
 * differently while it is being made from how it reads once saved is a
 * recording the person cannot check. And placing it in a surface module is
 * what put `digestStep` out of reach of a test for as long as it was inline in
 * the worker; the ordering is the part a reader relies on, so it is the part
 * worth being able to call directly.
 */
export function interleave(source: {
  readonly steps: readonly StepDigest[];
  readonly droppedSteps: readonly DroppedStep[];
}): ReviewEntry[] {
  const entries: ReviewEntry[] = [];
  const after = (stepId: string | null): void => {
    source.droppedSteps.forEach((dropped, index) => {
      if (dropped.afterStepId === stepId) entries.push({ kind: 'dropped', dropped, index });
    });
  };

  // Anything dropped before the first recorded step carries a null position.
  after(null);
  for (const step of source.steps) {
    entries.push({ kind: 'step', step });
    after(step.id);
  }
  return entries;
}
