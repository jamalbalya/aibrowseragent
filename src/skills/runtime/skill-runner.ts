/**
 * Executing a skill.
 *
 * The runner holds no security logic. It resolves each step's arguments from
 * the definition and hands the call to `ToolRegistry.dispatch`, which is the
 * same function the agent runtime uses for a model-proposed call and the only
 * path from a proposed call to a real effect. A skill therefore gets schema
 * validation, argument-aware risk classification, policy, the permission
 * prompt, the egress gate, sanitisation and evidence — per step, not per run.
 *
 * Per step is the part worth stating plainly. A skill that reads a page and
 * then files an issue is two authorisations, asked at the two moments they
 * apply, with the second one seeing the taint the first one created. Bundling
 * them into a single "run this skill?" prompt would make a skill a way to buy
 * several approvals with one click, which is exactly what a workflow feature
 * must not become.
 *
 * Three things the runner does thread through itself, because nothing else
 * can:
 *
 *  - **Taint**, which grows as steps read things and is passed forward, so a
 *    later step's egress decision accounts for what an earlier one read. It
 *    only ever grows.
 *  - **Cancellation**, checked before every step and handed to each dispatch,
 *    so a cancelled task starts no further work.
 *  - **The step budget**, which is the task's, not a second allowance of its
 *    own.
 */
import { getLogger } from '@/logging/logger';
import { newToolCallId } from '@/utils/ids';
import { addTaint, type TaintState } from '@/security/taint/taint-state';
import { taintSignature } from '@/security/egress/consent';
import { REDACTED, redact } from '@/security/redaction/secret-redactor';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import type { EvidenceReference } from '@/evidence/evidence-model';
import type { RiskLevel } from '@/policy/risk-classifier';
import type { ToolRegistry } from '@/tools/registry/tool-registry';
import type { SkillRegistry, RegisteredSkill } from '@/skills/core/skill-registry';
import {
  MAX_COMPOSITION_DEPTH,
  type ElementBinding,
  type SkillBinding,
  type SkillDefinition,
  type SkillInput,
  type SkillStep,
} from '@/skills/core/skill-model';

const log = getLogger('agent');

export type SkillStepStatus = 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface SkillStepOutcome {
  readonly stepId: string;
  readonly status: SkillStepStatus;
  /** The tool or composed skill this step ran. */
  readonly ran: string;
  readonly risk?: RiskLevel;
  readonly error?: { readonly code: string; readonly message: string };
}

export type SkillRunStatus = 'completed' | 'failed' | 'cancelled' | 'refused';

export interface SkillRunResult {
  readonly status: SkillRunStatus;
  readonly skillId: string;
  readonly skillVersion: string;
  readonly skillHash: string;
  readonly steps: readonly SkillStepOutcome[];
  /** The declared outputs, resolved from step results. */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Taint every step reported, for the caller to persist. */
  readonly taint: readonly TaintSource[];
  readonly evidence: readonly EvidenceReference[];
  readonly summary: string;
}

export class SkillInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInputError';
  }
}

export interface SkillRunContext {
  readonly taskId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly tabId?: number;
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly saltEpoch: number;
  readonly signal: AbortSignal;
}

export interface SkillRunnerOptions {
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  /**
   * Steps this run may take in total, composition included.
   *
   * Derived from what the task has left, not invented here. A skill that
   * could take more steps than the task budget allows would be a second
   * budget, and a second budget is a way past the first.
   */
  readonly remainingToolCalls: (taskId: string) => number;
  readonly onStepStart?: (outcome: {
    stepId: string;
    ran: string;
    index: number;
    total: number;
  }) => void;
  readonly onStepFinished?: (outcome: SkillStepOutcome) => Promise<void>;
  /** Persists progress so an evicted worker can resume. */
  readonly onProgress?: (progress: SkillRunProgress) => Promise<void>;
}

export interface SkillRunProgress {
  readonly taskId: string;
  readonly skillId: string;
  readonly skillVersion: string;
  readonly skillHash: string;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly status: 'running' | SkillRunStatus;
}

export class SkillRunner {
  constructor(private readonly options: SkillRunnerOptions) {}

  /**
   * Runs one skill to completion, or stops at the first thing that says no.
   *
   * Never throws for an ordinary failure: a refused step, a cancelled task and
   * an exhausted budget all come back as a result with a status, because the
   * caller is a tool whose output becomes model context and an unhandled
   * exception there would become untrusted text.
   */
  async run(
    skill: RegisteredSkill,
    inputs: Readonly<Record<string, unknown>>,
    context: SkillRunContext,
  ): Promise<SkillRunResult> {
    const validated = validateInputs(skill.definition, inputs);
    return await this.execute(skill, validated, context, 0);
  }

  private async execute(
    skill: RegisteredSkill,
    inputs: Readonly<Record<string, unknown>>,
    context: SkillRunContext,
    depth: number,
  ): Promise<SkillRunResult> {
    const { definition } = skill;
    const steps: SkillStepOutcome[] = [];
    const evidence: EvidenceReference[] = [];
    const acquiredTaint: TaintSource[] = [];
    const results = new Map<string, unknown>();

    // Local, monotone, and never written back to the task here: persisting
    // taint is the runtime's job. Carrying it forward *within* the run is the
    // runner's, because step three's egress decision has to account for what
    // step one read.
    let taintState = context.taintState;

    const finish = (status: SkillRunStatus, summary: string): SkillRunResult => ({
      status,
      skillId: definition.id,
      skillVersion: definition.version,
      skillHash: skill.hash,
      steps,
      outputs: status === 'completed' ? resolveOutputs(definition, results) : {},
      taint: acquiredTaint,
      evidence,
      summary,
    });

    if (depth > MAX_COMPOSITION_DEPTH) {
      return finish('refused', `Skill composition went deeper than ${MAX_COMPOSITION_DEPTH}.`);
    }

    for (const [index, step] of definition.steps.entries()) {
      // Checked before every step, so a cancellation between two steps starts
      // no further work rather than being noticed at the end.
      if (context.signal.aborted) {
        steps.push({ stepId: step.id, status: 'cancelled', ran: nameOf(step) });
        return finish('cancelled', 'The task was cancelled before this skill finished.');
      }

      if (this.options.remainingToolCalls(context.taskId) <= 0) {
        steps.push({ stepId: step.id, status: 'skipped', ran: nameOf(step) });
        return finish(
          'failed',
          'The task ran out of its tool-call budget partway through this skill.',
        );
      }

      await this.options.onProgress?.({
        taskId: context.taskId,
        skillId: definition.id,
        skillVersion: definition.version,
        skillHash: skill.hash,
        stepIndex: index,
        totalSteps: definition.steps.length,
        status: 'running',
      });
      this.options.onStepStart?.({
        stepId: step.id,
        ran: nameOf(step),
        index,
        total: definition.steps.length,
      });

      let bound: Record<string, unknown>;
      try {
        bound = resolveArguments(step, inputs, results);
      } catch (error) {
        const outcome: SkillStepOutcome = {
          stepId: step.id,
          status: 'failed',
          ran: nameOf(step),
          error: {
            code: 'INVALID_ARGUMENT',
            message: error instanceof Error ? error.message : 'Arguments could not be resolved.',
          },
        };
        steps.push(outcome);
        await this.options.onStepFinished?.(outcome);
        if (step.optional === true) continue;
        return finish('failed', `Step "${step.id}" could not be prepared.`);
      }

      const outcome =
        step.kind === 'tool'
          ? await this.runToolStep(step, bound, context, taintState)
          : await this.runSkillStep(step, bound, context, taintState, depth);

      steps.push(outcome.outcome);
      evidence.push(...outcome.evidence);
      if (outcome.taint.length > 0) {
        acquiredTaint.push(...outcome.taint);
        // Monotone by construction: `addTaint` unions, and nothing here ever
        // replaces the state with a narrower one.
        taintState = addTaint(taintState, outcome.taint);
      }
      if (outcome.result !== undefined) results.set(step.id, outcome.result);
      await this.options.onStepFinished?.(outcome.outcome);

      if (outcome.outcome.status === 'cancelled') {
        return finish('cancelled', 'The task was cancelled while this skill was running.');
      }
      if (outcome.outcome.status === 'failed' && step.optional !== true) {
        // A required step failed, so the rest of the skill assumed something
        // that is not true. Continuing would be guessing.
        return finish(
          'failed',
          `Step "${step.id}" failed and the skill requires it, so the run stopped there.`,
        );
      }
    }

    await this.options.onProgress?.({
      taskId: context.taskId,
      skillId: definition.id,
      skillVersion: definition.version,
      skillHash: skill.hash,
      stepIndex: definition.steps.length,
      totalSteps: definition.steps.length,
      status: 'completed',
    });

    return finish('completed', `Ran ${definition.name}: ${steps.length} steps.`);
  }

  /** One tool step, dispatched exactly as a model-proposed call would be. */
  private async runToolStep(
    step: Extract<SkillStep, { kind: 'tool' }>,
    args: Record<string, unknown>,
    context: SkillRunContext,
    taintState: TaintState,
  ): Promise<{
    outcome: SkillStepOutcome;
    result?: unknown;
    taint: readonly TaintSource[];
    evidence: readonly EvidenceReference[];
  }> {
    // Recomputed per step rather than taken from the caller: the signature is
    // part of the consent key, and a step that runs after the taint grew must
    // not reuse the signature from before it did.
    const signature = await taintSignature(taintState);

    const dispatched = await this.options.tools.dispatch({
      toolCallId: `${context.toolCallId}.${step.id}.${newToolCallId()}`,
      taskId: context.taskId,
      sessionId: context.sessionId,
      name: step.tool,
      arguments: args,
      ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
      taintState,
      taintSalt: context.taintSalt,
      saltEpoch: context.saltEpoch,
      taintSignature: signature,
      signal: context.signal,
    });

    const { envelope } = dispatched;
    if (envelope.status === 'success') {
      return {
        outcome: {
          stepId: step.id,
          status: 'completed',
          ran: step.tool,
          risk: dispatched.risk,
        },
        result: envelope.result,
        taint: dispatched.taint,
        evidence: dispatched.evidence,
      };
    }

    log.info('A skill step was refused or failed.', {
      taskId: context.taskId,
      step: step.id,
      tool: step.tool,
      code: envelope.error?.code,
    });

    return {
      outcome: {
        stepId: step.id,
        status: context.signal.aborted ? 'cancelled' : 'failed',
        ran: step.tool,
        risk: dispatched.risk,
        ...(envelope.error === undefined
          ? {}
          : { error: { code: envelope.error.code, message: envelope.error.message } }),
      },
      taint: dispatched.taint,
      evidence: dispatched.evidence,
    };
  }

  /** One composed skill, at the exact version the parent pinned. */
  private async runSkillStep(
    step: Extract<SkillStep, { kind: 'skill' }>,
    args: Record<string, unknown>,
    context: SkillRunContext,
    taintState: TaintState,
    depth: number,
  ): Promise<{
    outcome: SkillStepOutcome;
    result?: unknown;
    taint: readonly TaintSource[];
    evidence: readonly EvidenceReference[];
  }> {
    const ran = `${step.skill}@${step.skillVersion}`;
    const composed = this.options.skills.get(step.skill, step.skillVersion);
    if (!composed) {
      // Registration checked this, so reaching it means the registry changed
      // under a run. Refusing is the only safe reading.
      return {
        outcome: {
          stepId: step.id,
          status: 'failed',
          ran,
          error: { code: 'TOOL_NOT_FOUND', message: `Skill ${ran} is not registered.` },
        },
        taint: [],
        evidence: [],
      };
    }

    let inner: SkillRunResult;
    try {
      inner = await this.execute(
        composed,
        validateInputs(composed.definition, args),
        { ...context, taintState },
        depth + 1,
      );
    } catch (error) {
      return {
        outcome: {
          stepId: step.id,
          status: 'failed',
          ran,
          error: {
            code: 'INVALID_ARGUMENT',
            message: error instanceof Error ? error.message : 'The composed skill refused.',
          },
        },
        taint: [],
        evidence: [],
      };
    }

    return {
      outcome: {
        stepId: step.id,
        status:
          inner.status === 'completed'
            ? 'completed'
            : inner.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        ran,
      },
      result: inner.outputs,
      taint: inner.taint,
      evidence: inner.evidence,
    };
  }
}

function nameOf(step: SkillStep): string {
  return step.kind === 'tool' ? step.tool : `${step.skill}@${step.skillVersion}`;
}

/**
 * Checks the values a caller supplied against what the skill declares.
 *
 * The tool's own schema runs anyway and is authoritative; this is the skill's
 * chance to be narrower than the tools it uses. It also drops anything the
 * skill did not declare, so an extra property a model invented cannot reach a
 * binding — a binding can only name a declared input, but dropping unknowns
 * keeps the recorded inputs honest as well.
 */
export function validateInputs(
  definition: SkillDefinition,
  supplied: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const accepted: Record<string, unknown> = {};

  for (const input of definition.inputs) {
    const value = supplied[input.name];
    if (value === undefined || value === null) {
      if (input.required) throw new SkillInputError(`"${input.name}" is required.`);
      continue;
    }
    accepted[input.name] = checkInput(input, value);
  }

  const declared = new Set(definition.inputs.map((input) => input.name));
  const extra = Object.keys(supplied).filter((name) => !declared.has(name));
  if (extra.length > 0) {
    // Refused rather than ignored. A caller passing something the skill does
    // not take has misunderstood what it does, and silently dropping the
    // value would hide that.
    throw new SkillInputError(`"${extra.join('", "')}" is not an input this skill takes.`);
  }

  return accepted;
}

function checkInput(input: SkillInput, value: unknown): unknown {
  if (input.type === 'string') {
    if (typeof value !== 'string') throw new SkillInputError(`"${input.name}" must be text.`);
    if (input.maxLength !== undefined && value.length > input.maxLength) {
      throw new SkillInputError(
        `"${input.name}" is longer than the ${input.maxLength} characters this skill accepts.`,
      );
    }
    if (input.enum !== undefined && !input.enum.includes(value)) {
      throw new SkillInputError(`"${input.name}" must be one of: ${input.enum.join(', ')}.`);
    }
    return value;
  }
  if (input.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SkillInputError(`"${input.name}" must be a number.`);
    }
    return value;
  }
  if (typeof value !== 'boolean')
    throw new SkillInputError(`"${input.name}" must be true or false.`);
  return value;
}

/** Builds one step's arguments from the definition's bindings. */
export function resolveArguments(
  step: SkillStep,
  inputs: Readonly<Record<string, unknown>>,
  results: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(step.arguments)) {
    const value = resolveBinding(binding, inputs, results);
    // An optional argument whose source produced nothing is left out, so the
    // tool sees an absent property rather than an explicit undefined its
    // schema would reject.
    if (value !== undefined) args[name] = value;
  }
  return args;
}

export function resolveBinding(
  binding: SkillBinding,
  inputs: Readonly<Record<string, unknown>>,
  results: ReadonlyMap<string, unknown>,
): unknown {
  if (binding.kind === 'literal') return binding.value;
  if (binding.kind === 'input') return inputs[binding.name];
  if (binding.kind === 'element') return resolveElement(binding, results.get(binding.step));
  return readPath(results.get(binding.step), binding.path);
}

/** One element as the page model reports it, narrowed to what matching uses. */
interface MatchableElement {
  readonly elementId?: unknown;
  readonly role?: unknown;
  readonly name?: unknown;
  readonly visible?: unknown;
  readonly enabled?: unknown;
}

/**
 * Finds the one element a binding means, or nothing at all.
 *
 * Every branch that is not "exactly what was asked for" returns `undefined`,
 * which leaves the argument absent and lets the tool's own schema refuse the
 * call. That is what fail-closed means here: there is no closest match, no
 * relaxed comparison, no positional fallback and no "well, there was only one
 * button" guess. A page that changed enough to make the binding ambiguous is
 * a page the recording no longer describes.
 *
 * Matching reads the semantic page model — `role` and `name` compared
 * literally after trimming. Nothing is passed to the DOM, nothing is
 * evaluated, and `selectorHints` is deliberately not consulted: it exists as
 * a recovery hint for a human, and using it here would reintroduce selectors
 * through the back door.
 */
export function resolveElement(binding: ElementBinding, stepResult: unknown): unknown {
  const elements = elementsOf(stepResult);
  if (elements === null) return undefined;

  const role = binding.role.trim().toLowerCase();
  const name = binding.name.trim().toLowerCase();

  // Document order, because that is the order the page model is built in —
  // `querySelectorAll` over the interactive selector — so `nth` refers to
  // something stable rather than to whatever the array happened to hold.
  const matches = elements.filter((element) => {
    if (typeof element.role !== 'string' || typeof element.name !== 'string') return false;
    // Re-checked against the page as it is now, not only as it was when the
    // binding was recorded. A page that has since put a credential into a
    // label must not have it read back into a comparison, so such a candidate
    // is not considered at all — which fails the step closed rather than
    // matching something else.
    if (looksLikeSecret(element.name)) return false;
    if (element.role.trim().toLowerCase() !== role) return false;
    if (element.name.trim().toLowerCase() !== name) return false;
    return satisfiesExpectation(element, binding.expect);
  });

  if (matches.length === 0) return undefined;

  if (binding.nth === undefined) {
    // Ambiguity is refused rather than resolved. Taking the first would be a
    // coin flip dressed up as a decision.
    if (matches.length > 1) return undefined;
    return idOf(matches[0]);
  }

  const chosen = matches[binding.nth];
  return chosen === undefined ? undefined : idOf(chosen);
}

/**
 * Whether a page's current label looks like it carries a credential.
 *
 * The same redactor the logs, evidence and audit trail use, so a binding
 * cannot match on something they would have refused to record.
 */
function looksLikeSecret(value: string): boolean {
  if (value.length === 0) return false;
  const redacted = redact(value);
  return redacted !== value || redacted.includes(REDACTED);
}

function satisfiesExpectation(
  element: MatchableElement,
  expect: ElementBinding['expect'],
): boolean {
  if (expect === undefined) return true;
  if (expect === 'visible') return element.visible === true;
  if (expect === 'enabled') return element.enabled === true;
  // `editable` is the conjunction a text entry actually needs: an invisible
  // or disabled field accepts nothing, so typing into one is a failure that
  // would otherwise surface much later and much less clearly.
  return element.visible === true && element.enabled === true;
}

function idOf(element: MatchableElement | undefined): unknown {
  return typeof element?.elementId === 'string' ? element.elementId : undefined;
}

/** The element list from a `browser.read_page` result, or `null`. */
function elementsOf(stepResult: unknown): MatchableElement[] | null {
  if (stepResult === null || typeof stepResult !== 'object') return null;
  const elements = (stepResult as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return null;
  return elements.filter(
    (element): element is MatchableElement => element !== null && typeof element === 'object',
  );
}

/**
 * Walks a dotted path through a result.
 *
 * Own properties only, and never through anything that is not a plain object
 * or an array. The path syntax already excludes `__proto__`, `constructor` and
 * `prototype`; this refuses them again at run time rather than trusting that,
 * because the two checks protect against different mistakes — the first
 * against a bad definition, the second against a result whose shape someone
 * else controls.
 */
export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveOutputs(
  definition: SkillDefinition,
  results: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const output of definition.outputs) {
    const value = readPath(results.get(output.step), output.path);
    if (value !== undefined) outputs[output.name] = value;
  }
  return outputs;
}
