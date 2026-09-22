/**
 * Replaying a recorded workflow (P-022).
 *
 * This is the only thing in P-022 that executes, and it runs nothing of its
 * own: it revalidates a stored recording, shapes it into the value
 * `SkillRunner` already takes, and hands it over. Every step then goes through
 * `ToolRegistry.dispatch` exactly as a bundled skill's step does — schema,
 * risk, policy, permission, egress, evidence, sanitisation — so a replayed
 * step is adjudicated by the same code that adjudicated it when it was
 * recorded. There is no second execution path and no second security path.
 *
 * **A recording carries no authority.** Being stored does not pre-approve
 * anything. The prompts a user saw while recording are not banked; they are
 * asked again, against the state of the world at replay, which is the only
 * state that can be reasoned about. A site that has since been blocked, a
 * connector that has since been disconnected, a tool that has since been
 * removed — each of those refuses the replay at the moment it applies.
 *
 * **Replay is an explicit user action.** Nothing in this file is reachable
 * from a model: it is not a tool, it is not registered, and the route that
 * calls it exists only on the side panel's message surface. A recorded
 * workflow never appears in `skills.list` and can never be selected by a
 * model, so the only way a recording runs is a person choosing to run it.
 *
 * **And revalidation fails closed.** A record that will not re-derive its own
 * hash, that came from a format this build cannot read, that names a tool
 * which no longer exists, or whose arguments no longer satisfy the tool's
 * schema, is refused outright rather than partially executed.
 */
import { getLogger } from '@/logging/logger';
import { newTaskId, newToolCallId } from '@/utils/ids';
import { createTask, type AgentTask } from '@/tasks/task-model';
import type { TaskStore } from '@/tasks/task-store';
import type { PermissionMode } from '@/policy/policy-engine';
import type { RiskLevel } from '@/policy/risk-classifier';
import type { TaintState } from '@/security/taint/taint-state';
import { taintSignature } from '@/security/egress/consent';
import type { ToolRegistry } from '@/tools/registry/tool-registry';
import type { RegisteredSkill } from '@/skills/core/skill-registry';
import {
  effectiveSkillRisk,
  toolsReachedBy,
  type SkillBinding,
  type SkillDefinition,
} from '@/skills/core/skill-model';
import {
  SkillInputError,
  type SkillRunner,
  type SkillRunResult,
} from '@/skills/runtime/skill-runner';
import { isIncomplete, WORKFLOW_FORMAT_VERSION, type RecordedWorkflow } from './workflow-model';
import type { WorkflowStore } from './workflow-store';

const log = getLogger('agent');

/**
 * What a replay task records as its provider.
 *
 * A replay consults no model — the steps are fixed by the recording and
 * nothing generates new ones — so naming a provider here would claim a
 * dependency the run does not have. It is also a security property worth
 * being able to read off the task record: no model output reached this run,
 * therefore no model output chose any of its arguments.
 */
export const REPLAY_PROVIDER_ID = 'none';
export const REPLAY_MODEL_ID = 'none';

export type ReplayRefusal =
  | 'NOT_FOUND'
  | 'FORMAT_UNSUPPORTED'
  | 'INTEGRITY_FAILED'
  | 'DEFINITION_INVALID'
  | 'ARGUMENTS_INVALID'
  | 'INPUTS_INVALID'
  | 'INCOMPLETE_RECORDING';

export type RevalidationVerdict =
  | {
      readonly ok: true;
      readonly record: RecordedWorkflow;
      /** Recomputed now, never read from the record. */
      readonly skill: RegisteredSkill;
      /** True when a tool's risk changed since the recording was made. */
      readonly riskChanged: boolean;
    }
  | { readonly ok: false; readonly reason: ReplayRefusal; readonly detail: string };

export type ReplayOutcome =
  | { readonly ok: true; readonly taskId: string; readonly result: SkillRunResult }
  | { readonly ok: false; readonly reason: ReplayRefusal; readonly detail: string };

export interface WorkflowAuditEvent {
  readonly type: 'workflow.replay';
  readonly taskId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly definitionHash: string;
  readonly outcome: 'allowed' | 'denied' | 'failed' | 'info';
  readonly code?: string;
}

export interface WorkflowReplayerOptions {
  readonly store: WorkflowStore;
  readonly runner: SkillRunner;
  readonly tools: ToolRegistry;
  readonly tasks: TaskStore;
  readonly getPermissionMode: () => Promise<PermissionMode>;
  readonly getActiveTabId: () => Promise<number | undefined>;
  /**
   * Publishes the replay task's security context.
   *
   * The same hook the tool registry uses for a model-driven task, so a
   * connector called from a replayed step inherits the replay's taint rather
   * than finding none and assuming a clean one.
   */
  readonly publishSecurityContext: (
    taskId: string,
    context: {
      taintState: TaintState;
      taintSalt: string;
      saltEpoch: number;
      taintSignature: string;
    },
  ) => void;
  readonly audit?: (event: WorkflowAuditEvent) => Promise<void>;
  readonly onTaskChanged?: (task: AgentTask) => void;
  readonly now?: () => number;
}

export interface ReplayRequest {
  readonly workflowId: string;
  readonly sessionId: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

export class WorkflowReplayer {
  /** Abort handles for replays running in this worker generation. */
  private readonly running = new Map<string, AbortController>();
  private readonly now: () => number;

  constructor(private readonly options: WorkflowReplayerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Re-checks a stored recording against the world as it is now.
   *
   * Separate from `replay` and returning a verdict rather than running, so the
   * review surface can show a user why a workflow will not run without
   * anything being executed to find out.
   */
  async revalidate(
    workflowId: string,
    inputs?: Readonly<Record<string, unknown>>,
  ): Promise<RevalidationVerdict> {
    const record = await this.options.store.get(workflowId);
    if (!record) {
      return { ok: false, reason: 'NOT_FOUND', detail: 'That workflow no longer exists.' };
    }

    if (record.formatVersion !== WORKFLOW_FORMAT_VERSION) {
      return {
        ok: false,
        reason: 'FORMAT_UNSUPPORTED',
        detail:
          `That workflow was recorded in format ${record.formatVersion}, which this version ` +
          'of the extension cannot read. Record it again.',
      };
    }

    // Before anything is read out of the definition: a record that does not
    // re-derive its own hash was altered underneath the store, and its steps
    // are no longer the ones anybody reviewed.
    if (!(await this.options.store.verifyIntegrity(record))) {
      return {
        ok: false,
        reason: 'INTEGRITY_FAILED',
        detail: 'That workflow has changed since it was saved, so it will not be run.',
      };
    }

    // A workflow missing a step does something materially different from the
    // task it was recorded from: dropping the click out of "navigate, click
    // Login, read" leaves something that completes successfully having never
    // logged in. Running the subset and reporting success would be reporting
    // the wrong thing, so an incomplete recording does not run at all.
    if (isIncomplete(record)) {
      const dropped = record.droppedSteps;
      return {
        ok: false,
        reason: 'INCOMPLETE_RECORDING',
        detail:
          `That recording is missing ${dropped.length} step${dropped.length === 1 ? '' : 's'} ` +
          'the task actually took, so replaying it would do something different from what ' +
          'was recorded. Record it again.',
      };
    }

    // Catches a tool that has been removed, a definition that no longer
    // validates, and anything the recorder could not have produced.
    const problems = this.options.store.validate(record.definition);
    if (problems.length > 0) {
      return {
        ok: false,
        reason: 'DEFINITION_INVALID',
        detail: `That workflow can no longer run — ${problems.join('; ')}.`,
      };
    }

    const argumentProblems = this.checkArguments(record.definition, inputs ?? {});
    if (argumentProblems.length > 0) {
      return {
        ok: false,
        reason: 'ARGUMENTS_INVALID',
        detail:
          'A tool this workflow uses no longer accepts the arguments it recorded — ' +
          `${argumentProblems.join('; ')}.`,
      };
    }

    const riskOfTool = (name: string): RiskLevel | undefined => this.options.tools.get(name)?.risk;
    const resolve = (): undefined => undefined;
    // Recomputed, never taken from the record: a tool whose risk was raised
    // since the recording must raise the replay's, and a stored value would
    // hold the replay at the risk the recording was made under.
    const risk = effectiveSkillRisk(record.definition, riskOfTool, resolve);

    return {
      ok: true,
      record,
      riskChanged: risk !== record.risk,
      skill: {
        definition: record.definition,
        // The store's hash, over the bytes just verified above.
        hash: record.definitionHash,
        risk,
        tools: toolsReachedBy(record.definition, resolve),
        registeredAt: record.recordedAt,
      },
    };
  }

  /**
   * Runs a stored recording, as the user.
   *
   * Only ever called from the side panel's explicit replay route. It creates a
   * task so the run is visible, cancellable and auditable like any other, then
   * hands the definition to `SkillRunner` — which is where the security story
   * ends, because from there every step is an ordinary dispatch.
   */
  async replay(request: ReplayRequest): Promise<ReplayOutcome> {
    const verdict = await this.revalidate(request.workflowId, request.inputs);
    if (!verdict.ok) {
      log.info('A workflow replay was refused before anything ran.', {
        workflowId: request.workflowId,
        reason: verdict.reason,
      });
      await this.options.audit?.({
        type: 'workflow.replay',
        taskId: '',
        workflowId: request.workflowId,
        workflowVersion: 0,
        definitionHash: '',
        outcome: 'denied',
        code: verdict.reason,
      });
      return { ok: false, reason: verdict.reason, detail: verdict.detail };
    }

    const { record, skill } = verdict;
    const task = createTask({
      id: newTaskId(),
      sessionId: request.sessionId,
      objective: `Replay the recorded workflow "${record.name}".`,
      providerId: REPLAY_PROVIDER_ID,
      modelId: REPLAY_MODEL_ID,
      // The mode in force now. A recording cannot carry a looser one forward:
      // that would let a workflow recorded under one setting run under it
      // forever.
      permissionMode: await this.options.getPermissionMode(),
      now: this.now(),
    });
    await this.options.tasks.saveTask(task);
    this.options.onTaskChanged?.(task);

    const controller = new AbortController();
    this.running.set(task.id, controller);

    // A replay starts clean. It is a fresh task that has read nothing, and
    // inheriting the recording task's taint would be inheriting a fact about
    // a different run — taint is a property of what *this* task has read.
    const security = {
      taintState: task.taintState,
      taintSalt: task.taintSalt,
      saltEpoch: task.saltEpoch,
    };
    // The signature is part of the consent key, so it is derived from the
    // taint rather than invented. Each dispatch recomputes it as the taint
    // grows; this is the value that holds until the first step runs.
    this.options.publishSecurityContext(task.id, {
      ...security,
      taintSignature: await taintSignature(security.taintState),
    });

    await this.options.audit?.({
      type: 'workflow.replay',
      taskId: task.id,
      workflowId: record.workflowId,
      workflowVersion: record.version,
      definitionHash: record.definitionHash,
      outcome: 'info',
      code: 'started',
    });
    await this.setState(task.id, 'RUNNING');

    const tabId = await this.options.getActiveTabId();
    let result: SkillRunResult;
    try {
      result = await this.options.runner.run(skill, request.inputs, {
        taskId: task.id,
        sessionId: request.sessionId,
        toolCallId: newToolCallId(),
        ...(tabId === undefined ? {} : { tabId }),
        ...security,
        signal: controller.signal,
      });
    } catch (error) {
      this.running.delete(task.id);
      await this.setState(task.id, 'FAILED');
      if (error instanceof SkillInputError) {
        return { ok: false, reason: 'INPUTS_INVALID', detail: error.message };
      }
      throw error;
    } finally {
      this.running.delete(task.id);
    }

    // Whatever the steps read, the replay task now carries — persisted the
    // same way a model-driven task's is, because the egress gate reads it
    // from the task record on the next call.
    if (result.taint.length > 0) {
      await this.options.tasks.appendTaint(task.id, result.taint);
    }
    await this.setState(
      task.id,
      result.status === 'completed'
        ? 'COMPLETED'
        : result.status === 'cancelled'
          ? 'CANCELLED'
          : result.status === 'refused'
            ? 'BLOCKED'
            : 'FAILED',
      result.summary,
    );
    await this.options.audit?.({
      type: 'workflow.replay',
      taskId: task.id,
      workflowId: record.workflowId,
      workflowVersion: record.version,
      definitionHash: record.definitionHash,
      outcome: result.status === 'completed' ? 'allowed' : 'failed',
      code: result.status,
    });

    log.info('A workflow replay finished.', {
      taskId: task.id,
      workflowId: record.workflowId,
      status: result.status,
      steps: result.steps.length,
    });
    return { ok: true, taskId: task.id, result };
  }

  /** Stops a running replay. The steps already taken are not undone. */
  cancel(taskId: string): boolean {
    const controller = this.running.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /**
   * Checks every argument this build can resolve without running anything.
   *
   * Literals and input slots are known before the first step; a value bound to
   * an earlier step's result is not, and is left to that step's own dispatch,
   * which validates it against the same schema. Pre-flighting the knowable
   * part means a workflow whose tool changed its schema refuses before it has
   * half-executed rather than after.
   */
  private checkArguments(
    definition: SkillDefinition,
    inputs: Readonly<Record<string, unknown>>,
  ): string[] {
    const problems: string[] = [];
    const declared = new Map(definition.inputs.map((input) => [input.name, input]));

    for (const step of definition.steps) {
      if (step.kind !== 'tool') continue;
      const tool = this.options.tools.get(step.tool);
      if (!tool) {
        problems.push(`step "${step.id}" uses "${step.tool}", which no longer exists`);
        continue;
      }

      const resolved: Record<string, unknown> = {};
      let complete = true;
      for (const [name, binding] of Object.entries(step.arguments)) {
        const value = resolveKnown(binding, inputs, declared);
        if (value === UNRESOLVED) {
          complete = false;
          continue;
        }
        if (value !== OMITTED) resolved[name] = value;
      }
      // A partially-resolvable step cannot be schema-checked here without
      // inventing values for the missing arguments, and an invented value
      // that happened to validate would be worse than no check at all.
      if (!complete) continue;

      const parsed = tool.inputSchema.safeParse(resolved);
      if (!parsed.success) {
        problems.push(
          `step "${step.id}" no longer satisfies ${step.tool}'s schema ` +
            `(${parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')})`,
        );
      }
    }
    return problems;
  }

  private async setState(
    taskId: string,
    state: AgentTask['state'],
    summary?: string,
  ): Promise<void> {
    const updated = await this.options.tasks.updateTask(taskId, (task) => ({
      ...task,
      state,
      updatedAt: this.now(),
      ...(summary === undefined ? {} : { currentStepSummary: summary }),
      ...(state === 'RUNNING' ? { startedAt: this.now() } : { finishedAt: this.now() }),
    }));
    if (updated) this.options.onTaskChanged?.(updated);
  }
}

/** Distinguishes "not knowable yet" from "deliberately absent". */
const UNRESOLVED = Symbol('unresolved');
const OMITTED = Symbol('omitted');

function resolveKnown(
  binding: SkillBinding,
  inputs: Readonly<Record<string, unknown>>,
  declared: ReadonlyMap<string, { readonly required: boolean }>,
): unknown {
  switch (binding.kind) {
    case 'literal':
      return binding.value;
    case 'input': {
      const supplied = inputs[binding.name];
      if (supplied !== undefined) return supplied;
      // An optional slot nobody filled is genuinely absent, which is a state
      // the schema should be checked against. A required one that is missing
      // is caught by the runner's own input validation, not here.
      return declared.get(binding.name)?.required === false ? OMITTED : UNRESOLVED;
    }
    case 'step':
    case 'element':
      // Both are resolved against something that does not exist yet: an
      // earlier step's result, or a live page.
      return UNRESOLVED;
  }
}
