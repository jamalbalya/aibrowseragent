/**
 * Turning what a task did into a workflow it could do again.
 *
 * The recorder sits on `ToolRegistry`'s observation hook and sees completed
 * dispatches — frozen, derived records with no authority attached. It builds
 * up a `SkillDefinition` in memory and hands it to the store when the user
 * stops recording.
 *
 * Two things it deliberately does not do:
 *
 * **It never executes.** It is a bystander on the dispatch path. Starting,
 * stopping and saving a recording run nothing; the only thing that runs a
 * workflow is an explicit replay.
 *
 * **It never stores a value it cannot justify.** Every captured argument goes
 * through the parameteriser, which applies secret detection first, then
 * sensitivity, then taint. A value that cannot be stored safely in any form
 * makes the step unrecordable rather than making the recording lossy in a way
 * nobody would notice.
 */
import { getLogger } from '@/logging/logger';
import type { DispatchObservation } from '@/tools/registry/tool-registry';
import type { TaintState } from '@/security/taint/taint-state';
import type {
  SkillBinding,
  SkillDefinition,
  SkillInput,
  SkillStep,
} from '@/skills/core/skill-model';
import { MAX_STEPS_PER_SKILL } from '@/skills/core/skill-model';
import { RECORDED_PROVENANCE, type DroppedStep } from './workflow-model';
import { parameteriseArgument } from './parameteriser';

const log = getLogger('agent');

/** Tools whose calls are never recorded. */
const NOT_RECORDABLE: ReadonlySet<string> = new Set([
  // Recording a recording, or a workflow replay, would nest execution paths.
  'skills.run',
  'skills.list',
  // A file selection needs a person at a picker; replaying one cannot.
  'files.select',
  // Cosmetic, and noisy in a recording.
  'debugger.detach',
]);

/** Tools whose result an element binding can be resolved against. */
const PAGE_READS: ReadonlySet<string> = new Set(['browser.read_page']);

export interface RecordedStep {
  readonly step: SkillStep;
  readonly inputs: readonly SkillInput[];
}

export interface RecordingSummary {
  readonly taskId: string;
  readonly startedAt: number;
  readonly stepCount: number;
  /** What the recorder watched happen and could not write down, in position. */
  readonly skipped: readonly DroppedStep[];
}

export interface WorkflowRecorderOptions {
  /** The task's taint at the moment a call is observed. */
  readonly taintFor: (taskId: string) => TaintState | undefined;
  readonly now?: () => number;
}

interface Session {
  readonly taskId: string;
  readonly startedAt: number;
  readonly steps: SkillStep[];
  readonly inputs: SkillInput[];
  readonly skipped: DroppedStep[];
  /**
   * The most recent recorded step that read the page.
   *
   * An element binding resolves against a page read, so it has to name one.
   * A recording with no read before an interaction cannot express that
   * interaction, and the step is dropped rather than bound to nothing.
   */
  lastPageRead: string | null;
  /** The broadest taint seen while recording, for the stored record. */
  taint: 'KNOWN_UNTAINTED' | 'TAINTED' | 'UNKNOWN';
}

export class WorkflowRecorder {
  private session: Session | null = null;
  private readonly now: () => number;

  constructor(private readonly options: WorkflowRecorderOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Begins recording one task's tool calls. Runs nothing. */
  start(taskId: string): RecordingSummary {
    this.session = {
      taskId,
      startedAt: this.now(),
      steps: [],
      inputs: [],
      skipped: [],
      lastPageRead: null,
      taint: 'KNOWN_UNTAINTED',
    };
    log.info('Workflow recording started.', { taskId });
    return this.summary();
  }

  isRecording(taskId?: string): boolean {
    if (!this.session) return false;
    return taskId === undefined || this.session.taskId === taskId;
  }

  summary(): RecordingSummary {
    const session = this.session;
    if (!session) {
      return { taskId: '', startedAt: 0, stepCount: 0, skipped: [] };
    }
    return {
      taskId: session.taskId,
      startedAt: session.startedAt,
      stepCount: session.steps.length,
      skipped: [...session.skipped],
    };
  }

  /**
   * Observes one completed dispatch.
   *
   * Called from `ToolRegistry`'s hook, so the argument is already frozen and
   * carries no authority. Nothing here can affect the call it is observing —
   * it has already happened and its result has already been returned.
   */
  observe(observation: DispatchObservation): void {
    const session = this.session;
    if (!session || observation.taskId !== session.taskId) return;

    // Only calls that actually reached a tool. A refused call is not
    // something the user did, and recording it would produce a workflow that
    // proposes an action nobody performed.
    if (!observation.executed || observation.status !== 'success') return;

    if (NOT_RECORDABLE.has(observation.tool)) {
      this.drop(session, observation.tool, 'not a recordable action');
      return;
    }

    if (session.steps.length >= MAX_STEPS_PER_SKILL) {
      this.drop(session, observation.tool, 'the workflow is already full');
      return;
    }

    // A task whose taint cannot be read is treated as unknowable, not as
    // clean — the parameteriser then refuses to store anything from it.
    const taint: TaintState =
      this.options.taintFor(observation.taskId) ??
      ({ kind: 'UNKNOWN', reason: 'field-absent' } as const);
    session.taint = widen(session.taint, taint.kind);

    const stepId = `s${session.steps.length + 1}`;
    const args: Record<string, SkillBinding> = {};
    const newInputs: SkillInput[] = [];

    for (const [argument, value] of Object.entries(observation.arguments)) {
      const decision = parameteriseArgument({
        tool: observation.tool,
        stepId,
        argument,
        value,
        taint,
        ...(observation.actedOn === undefined ? {} : { actedOn: observation.actedOn }),
        ...(session.lastPageRead === null ? {} : { elementStep: session.lastPageRead }),
      });

      if (decision.kind === 'refused') {
        // The whole step goes, not just the argument. A step recorded with
        // one argument missing would replay as something nobody did.
        this.drop(session, observation.tool, decision.reason);
        return;
      }
      if (decision.kind === 'element' && decision.binding.step.length === 0) {
        this.drop(
          session,
          observation.tool,
          'nothing read the page before this step, so the element cannot be found again',
        );
        return;
      }
      args[argument] = decision.binding;
      if (decision.kind === 'slot') newInputs.push(decision.input);
    }

    session.steps.push({
      kind: 'tool',
      id: stepId,
      tool: observation.tool,
      description: `Recorded ${observation.tool}.`,
      arguments: args,
    });
    session.inputs.push(...newInputs);
    if (PAGE_READS.has(observation.tool)) session.lastPageRead = stepId;
  }

  /** Records a step that happened and could not be written down, in position. */
  private drop(session: Session, tool: string, reason: string): void {
    session.skipped.push({
      afterStepId: session.steps.at(-1)?.id ?? null,
      tool,
      reason,
    });
  }

  /**
   * Ends the recording and returns what was captured. Runs nothing.
   *
   * The definition is returned rather than stored, so the caller decides
   * whether to keep it — which is the review step in the lifecycle.
   */
  stop(): {
    definition: SkillDefinition;
    summary: RecordingSummary;
    taint: Session['taint'];
  } | null {
    const session = this.session;
    this.session = null;
    if (!session || session.steps.length === 0) return null;

    const tools = [...new Set(session.steps.map((step) => (step.kind === 'tool' ? step.tool : '')))]
      .filter((name) => name.length > 0)
      .sort();

    const definition: SkillDefinition = {
      id: 'recorded.workflow',
      version: '1.0.0',
      name: 'Recorded workflow',
      description: `Recorded from a task on ${new Date(session.startedAt).toISOString()}.`,
      provenance: RECORDED_PROVENANCE,
      // A floor only. The store recomputes the effective risk from the tools
      // the steps actually reach, and replay recomputes it again.
      risk: 'R0',
      requiredTools: tools,
      requiredConnectors: [],
      inputs: session.inputs,
      outputs: [],
      steps: session.steps,
    };

    log.info('Workflow recording stopped.', {
      taskId: session.taskId,
      steps: session.steps.length,
      slots: session.inputs.length,
    });

    return {
      definition,
      summary: {
        taskId: session.taskId,
        startedAt: session.startedAt,
        stepCount: session.steps.length,
        skipped: [...session.skipped],
      },
      taint: session.taint,
    };
  }

  /** Abandons a recording without storing anything. */
  cancel(): void {
    this.session = null;
  }
}

/** Taint only ever widens, here as everywhere else. */
function widen(current: Session['taint'], seen: TaintState['kind']): Session['taint'] {
  if (current === 'UNKNOWN' || seen === 'UNKNOWN') return 'UNKNOWN';
  if (current === 'TAINTED' || seen === 'TAINTED') return 'TAINTED';
  return 'KNOWN_UNTAINTED';
}
