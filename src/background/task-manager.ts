/**
 * Task manager.
 *
 * Owns task lifecycle in the service worker: creation, execution, pause,
 * resume, cancel and retry. All state changes go through the persistent store
 * so a worker eviction mid-task loses nothing but the in-memory abort handle.
 */
import { getLogger } from '@/logging/logger';
import { createError, type AgentError } from '@/types/result';
import { newId, newTaskId } from '@/utils/ids';
import type { AgentRuntime, RuntimeCallbacks } from '@/agent/runtime/agent-runtime';
import type { AIProviderAdapter, ModelCapabilities } from '@/providers/core/types';
import type { TaskStore } from '@/tasks/task-store';
import {
  canTransition,
  createTask,
  generateTaintSalt,
  isTerminal,
  type AgentTask,
  type TaskState,
  type TaskStep,
  type TaskUsage,
} from '@/tasks/task-model';
import type { PermissionMode } from '@/policy/policy-engine';
import {
  amendPlan,
  approvePlan,
  MAX_REVISION_NOTE,
  type AuthorizationModel,
  type PlanProposal,
} from '@/policy/plan-model';
import { requestPlanProposal } from '@/agent/runtime/plan-turn';
import { broadcastEvent } from '@/messaging/bus';
import type { EvidenceReference } from '@/evidence/evidence-model';
import { describeBlock, type PersistenceHealthStore } from '@/storage/persistence-health';

const log = getLogger('task');

export interface TaskManagerOptions {
  readonly store: TaskStore;
  /**
   * Durable persistence health (D-3).
   *
   * Consulted before work starts or resumes, and nowhere else. A task whose
   * security state could not be persisted is a task whose taint, salt and
   * history are no longer established, and running it would mean deciding
   * with state that is missing rather than state that is clean.
   *
   * Deliberately *not* consulted mid-execution. A check in the middle of a
   * run would abort work that is already authorised and already happening,
   * which is a different failure from refusing to begin — and the audit
   * domain, which this gate ignores entirely, is the one that must never stop
   * an execution at all.
   */
  readonly health?: PersistenceHealthStore;
  /** Resolves the provider + capabilities for a task at run time. */
  readonly resolveProvider: () => Promise<{
    adapter: AIProviderAdapter;
    capabilities: ModelCapabilities;
    providerId: string;
    /** The connected account behind this provider, when there is one. */
    connectionId?: string;
    modelId: string;
  }>;
  readonly getPermissionMode: () => Promise<PermissionMode>;
  /**
   * The workspace a new task belongs to.
   *
   * Resolved once, at creation, and never changed: a task that could be moved
   * between workspaces would be a task whose scope depends on when you asked.
   */
  readonly resolveWorkspaceId?: () => Promise<string | undefined>;
  readonly getActiveTabId: () => Promise<number | undefined>;
  /**
   * Notified whenever a task's usage changes.
   *
   * A read-only observer, so something outside the manager can track how much
   * of a task's budget is left without polling storage. It cannot change the
   * usage or the budget — a hook that could would be a way to grant a task
   * more allowance than it started with.
   */
  readonly onUsageChanged?: (taskId: string, usage: TaskUsage) => void;
  /**
   * Notified when a task is created, changes state or finishes.
   *
   * An observer, like `onUsageChanged`: it is told what happened and cannot
   * change it. The manager does not await it and never lets it fail a
   * transition — a record of a state change is not the state change.
   */
  readonly onLifecycle?: (event: {
    readonly kind: 'created' | 'state' | 'completed';
    readonly taskId: string;
    readonly sessionId?: string;
    readonly state?: TaskState;
    readonly outcome?: string;
    readonly providerId?: string;
    readonly modelId?: string;
    readonly permissionMode?: PermissionMode;
  }) => void;
  readonly now?: () => number;
}

export class TaskManager {
  /** Abort handles for tasks currently executing in this worker generation. */
  private readonly running = new Map<string, AbortController>();
  private readonly now: () => number;
  private runtime: AgentRuntime | null = null;

  constructor(private readonly options: TaskManagerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Injects the runtime.
   *
   * The runtime needs this manager's callbacks and this manager needs the
   * runtime, so the cycle is closed here rather than by forward-declaring
   * either one.
   */
  setRuntime(runtime: AgentRuntime): void {
    this.runtime = runtime;
  }

  private requireRuntime(): AgentRuntime {
    if (!this.runtime) {
      throw new Error('TaskManager.setRuntime() must be called before tasks can run.');
    }
    return this.runtime;
  }

  /**
   * Refuses to begin when persistence is not in a state that can carry a
   * task's security state.
   *
   * Fail closed and say why. The alternative — starting anyway and hoping the
   * writes land this time — produces a task whose taint cannot be trusted,
   * and every gate downstream is reading that taint.
   */
  private async requireHealthyPersistence(action: string): Promise<void> {
    if (!this.options.health) return;
    const snapshot = await this.options.health.snapshot();
    if (!snapshot.blocked) return;
    log.error('Refusing to start work: persistence is not healthy.', {
      action,
      gating: snapshot.gating,
    });
    throw new TaskManagerError(
      createError('POLICY_BLOCKED', `Persistence is ${snapshot.gating}; ${action} is refused.`, {
        userMessage: describeBlock(snapshot),
        retryable: false,
      }),
    );
  }

  /**
   * Creates a task and starts it. Execution proceeds in the background.
   *
   * `authorizationModel` is fixed here and nowhere else. A task that could
   * change shape after it started would be a task whose boundary depends on
   * when you asked, and the approval a person gave would have been given
   * against a different thing.
   */
  async create(
    objective: string,
    sessionId: string,
    options: { readonly authorizationModel?: AuthorizationModel } = {},
  ): Promise<AgentTask> {
    await this.requireHealthyPersistence('starting a task');
    const trimmed = objective.trim();
    if (trimmed.length === 0) {
      throw new TaskManagerError(
        createError('INVALID_ARGUMENT', 'A task needs an objective.', {
          userMessage: 'Describe what you want the agent to do.',
        }),
      );
    }

    const provider = await this.options.resolveProvider();
    const workspaceId = await this.options.resolveWorkspaceId?.();
    const task = createTask({
      id: newTaskId(),
      sessionId,
      objective: trimmed,
      providerId: provider.providerId,
      ...(provider.connectionId === undefined ? {} : { connectionId: provider.connectionId }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      modelId: provider.modelId,
      permissionMode: await this.options.getPermissionMode(),
      ...(options.authorizationModel === undefined
        ? {}
        : { authorizationModel: options.authorizationModel }),
      now: this.now(),
    });

    await this.options.store.saveTask(task);
    this.emit(task);
    this.observeLifecycle({
      kind: 'created',
      taskId: task.id,
      sessionId: task.sessionId,
      providerId: task.providerId,
      modelId: task.modelId,
      permissionMode: task.permissionMode,
    });

    // The abort handle is registered synchronously, before execution is
    // scheduled. Registering it inside `execute` would leave a window in which
    // a Stop pressed right after create() aborts nothing, and the task would
    // run to completion despite the user cancelling it.
    this.running.set(task.id, new AbortController());

    // Execution is intentionally not awaited: the caller gets the task record
    // immediately and follows progress through events.
    void this.execute(task.id).catch((error: unknown) => {
      log.error('Task execution threw outside the runtime.', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return task;
  }

  private async execute(taskId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      this.running.delete(taskId);
      return;
    }

    // Every caller registers the abort handle before scheduling execution, so
    // a missing handle means pause or cancel already removed it. Re-creating
    // one here would resurrect a task the user just stopped.
    const controller = this.running.get(taskId);
    if (!controller || controller.signal.aborted || isTerminal(task.state)) {
      this.running.delete(taskId);
      log.debug('Task was stopped before execution began.', { taskId, state: task.state });
      return;
    }

    try {
      const provider = await this.options.resolveProvider();

      // A task records the provider and model it began on, and specification
      // §60 forbids a silent provider fallback. Resuming a half-finished task
      // onto whatever is active now would be exactly that: the conversation
      // so far was produced by one model, and continuing it on another —
      // under a record that still names the first — is a substitution nobody
      // asked for.
      //
      // So it is refused rather than silently carried over. Switching back,
      // or retrying the objective on the current provider, are both explicit
      // actions the person can take.
      // The account is part of that identity, not just the provider family.
      // Two OpenAI accounts differ in entitlement, billing and data
      // agreement, so resuming a task started on one onto the other is the
      // same substitution as resuming it onto a different provider — and
      // until connections existed it was indistinguishable from a match.
      if (
        provider.providerId !== task.providerId ||
        provider.modelId !== task.modelId ||
        (task.connectionId !== undefined && provider.connectionId !== task.connectionId)
      ) {
        await this.fail(
          taskId,
          createError(
            'POLICY_BLOCKED',
            `This task started on ${task.providerId}/${task.modelId}; ${provider.providerId}/${provider.modelId} is active now.`,
            {
              userMessage:
                `This task was started with ${task.modelId}, and ${provider.modelId} is ` +
                'active now. Switch back to continue it, or retry it on the current model.',
              retryable: false,
            },
          ),
        );
        return;
      }

      const started = await this.transition(taskId, 'PLANNING');
      if (!started) return;

      // A Classic task with no approved plan does not run. It proposes, and
      // stops. Nothing is dispatched on this path — no tool, no page, no
      // navigation — so the boundary a person is about to approve is the same
      // boundary that will be in force when they approve it.
      if (task.authorizationModel === 'classic' && task.planApproval === undefined) {
        await this.proposePlan(task, provider.adapter, controller.signal);
        return;
      }

      const tabId = await this.options.getActiveTabId();

      // The runtime records the final state and result atomically through
      // `onComplete`, so nothing needs writing here.
      await this.requireRuntime().run({
        task: { ...task, startedAt: this.now() },
        provider: provider.adapter,
        capabilities: provider.capabilities,
        signal: controller.signal,
        ...(tabId === undefined ? {} : { tabId }),
      });
    } catch (error) {
      log.error('Task failed unexpectedly.', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.fail(
        taskId,
        createError('INTERNAL_ERROR', 'The task failed unexpectedly.', {
          userMessage: 'The task stopped because of an internal error.',
          technicalDetails: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      this.running.delete(taskId);
      const final = await this.options.store.getTask(taskId);
      if (final) this.emit(final);
    }
  }

  /**
   * Applies a state transition if the state machine permits it.
   * Returns false when the transition was rejected.
   */
  private async transition(taskId: string, next: TaskState, summary?: string): Promise<boolean> {
    let allowed = false;
    const updated = await this.options.store.updateTask(taskId, (task) => {
      if (task.state === next) {
        allowed = true;
        return task;
      }
      if (!canTransition(task.state, next)) {
        log.warn('Rejected an invalid task transition.', {
          taskId,
          from: task.state,
          to: next,
        });
        return task;
      }
      allowed = true;
      return {
        ...task,
        state: next,
        updatedAt: this.now(),
        ...(summary === undefined ? {} : { currentStepSummary: summary }),
        ...(isTerminal(next) ? { finishedAt: this.now() } : {}),
      };
    });
    if (updated) this.emit(updated);
    if (updated && allowed) {
      this.observeLifecycle({
        kind: isTerminal(next) ? 'completed' : 'state',
        taskId,
        state: next,
        ...(isTerminal(next) ? { outcome: next } : {}),
      });
    }
    return allowed;
  }

  /**
   * Tells the lifecycle observer what happened, and never lets it interfere.
   *
   * Not awaited and fully guarded: a transition that already succeeded must
   * not be undone because something watching it threw.
   */
  private observeLifecycle(
    event: Parameters<NonNullable<TaskManagerOptions['onLifecycle']>>[0],
  ): void {
    try {
      this.options.onLifecycle?.(event);
    } catch (error) {
      log.warn('A task lifecycle observer threw and was ignored.', {
        taskId: event.taskId,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /** Callbacks the runtime uses to report progress. */
  createCallbacks(): RuntimeCallbacks {
    return {
      onStateChange: async (taskId, state, summary) => {
        await this.transition(taskId, state, summary);
      },

      recoverSalt: async (taskId) => {
        try {
          const repaired = await this.options.store.ensureSalt(taskId, generateTaintSalt());
          if (!repaired) return undefined;
          return { salt: repaired.taintSalt, epoch: repaired.saltEpoch };
        } catch (error) {
          log.error('Could not restore the task evidence key.', {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      },

      persistTaint: async (taskId, sources) => {
        try {
          return await this.options.store.appendTaint(taskId, sources);
        } catch (error) {
          // A storage failure here is a security failure, not a nuisance: the
          // runtime would otherwise carry on with a taint set it believes is
          // complete and that no restart could reproduce. Report it as
          // unpersisted and let the runtime pause.
          log.error('Could not persist task taint.', {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      },

      onComplete: async (taskId, outcome) => {
        // One atomic write: state, result, usage and error together. An
        // observer can never see a terminal task whose outcome is missing.
        let applied = false;
        const updated = await this.options.store.updateTask(taskId, (task) => {
          if (isTerminal(task.state)) return task;
          if (!canTransition(task.state, outcome.state)) {
            log.warn('Rejected an invalid terminal transition.', {
              taskId,
              from: task.state,
              to: outcome.state,
            });
            return task;
          }
          applied = true;
          return {
            ...task,
            state: outcome.state,
            result: outcome.result,
            usage: outcome.usage,
            currentStepSummary: outcome.result.summary,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
            finishedAt: this.now(),
            updatedAt: this.now(),
          };
        });
        if (updated) this.emit(updated);

        // This is the path every model-driven task actually ends on, and it
        // told the lifecycle observer nothing. `transition()` reports a
        // terminal state and this did not, so "the task reached a terminal
        // state" was observable only when a task was cancelled or failed
        // *around* the runtime rather than by it.
        //
        // What that cost was not theoretical. The observer is where a
        // finished task's staged files are released and where the audit
        // trail's `task.completed` record is written; a real-Chromium run of
        // an ordinary completing task produced no such record, and the user's
        // file stayed in memory until the worker happened to be evicted.
        //
        // Reported after the write, and only when the write moved the task,
        // so an observer can never see a terminal state the store does not
        // hold, and a second terminal write reports nothing.
        if (applied) {
          this.observeLifecycle({
            kind: 'completed',
            taskId,
            state: outcome.state,
            outcome: outcome.state,
          });
        }
      },
      onStep: async (taskId, step: TaskStep) => {
        const updated = await this.options.store.updateTask(taskId, (task) => ({
          ...task,
          steps: [...task.steps, step],
          updatedAt: this.now(),
        }));
        if (updated) this.emit(updated);
      },
      onActivity: (taskId, activity) => {
        broadcastEvent({ type: 'task.activity', taskId, activity });
      },
      onUsage: async (taskId, usage: TaskUsage) => {
        await this.options.store.updateTask(taskId, (task) => ({
          ...task,
          usage,
          updatedAt: this.now(),
        }));
        this.options.onUsageChanged?.(taskId, usage);
      },
      onEvidence: async (taskId, evidence: readonly EvidenceReference[]) => {
        await this.options.store.updateTask(taskId, (task) => ({
          ...task,
          evidenceIds: [...task.evidenceIds, ...evidence.map((item) => item.id)],
          updatedAt: this.now(),
        }));
      },
      onTextDelta: (taskId, delta) => {
        broadcastEvent({ type: 'task.streamDelta', taskId, delta });
      },
    };
  }

  /**
   * Asks the model for a plan and parks the task in front of the person.
   *
   * The proposal is written to the durable record before the task is parked,
   * so a worker eviction between here and the approval loses the turn rather
   * than the proposal: the panel reads it back and shows the same plan.
   */
  private async proposePlan(
    task: AgentTask,
    provider: AIProviderAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    let proposal: PlanProposal;
    try {
      proposal = await requestPlanProposal({ task, provider, signal, now: this.now() });
    } catch (error) {
      if (signal.aborted) return;
      log.error('The planning turn failed.', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.fail(
        task.id,
        createError('MODEL_ERROR', 'The AI provider could not produce a plan.', {
          userMessage:
            'The AI model could not produce a plan for this task. Try again, or start it ' +
            'without planning first.',
          retryable: true,
        }),
      );
      return;
    }
    // A task stopped mid-turn is not parked waiting for approval: pause and
    // cancel have already moved it, and writing a proposal onto it now would
    // show the user a plan for a run they stopped.
    if (signal.aborted) return;

    await this.options.store.updateTask(task.id, (current) => {
      // The note asked for *this* proposal. Leaving it would steer the next
      // one as well, and a revision the user already got would keep applying.
      const { planRevisionNote: _spent, ...rest } = current;
      return { ...rest, planProposal: proposal, updatedAt: this.now() };
    });
    await this.transition(task.id, 'WAITING_FOR_USER', 'Waiting for you to approve the plan.');
  }

  /**
   * Turns the proposal a person is looking at into the authorization they gave.
   *
   * The only caller of `approvePlan`, and reachable only from the panel's
   * CLASS_B route. Everything about that is deliberate: the model produces the
   * proposal and cannot reach this, and the approval it produces is a separate
   * record rather than a field flipped on the proposal.
   *
   * Refuses a second approval. Re-approving would mint version 1 again and
   * silently discard every site the person added during the run.
   */
  async approvePlanFor(taskId: string): Promise<AgentTask> {
    let failure: PlanFailure | null = null;
    const updated = await this.options.store.updateTask(taskId, (task) => {
      // A finished task cannot be authorised. The approval would never govern
      // anything, and the record would read as though it had.
      if (isTerminal(task.state)) {
        failure = 'finished';
        return task;
      }
      if (task.planApproval !== undefined) {
        failure = 'already-approved';
        return task;
      }
      if (task.planProposal === undefined) {
        failure = 'no-proposal';
        return task;
      }
      return {
        ...task,
        planApproval: approvePlan(task.planProposal, newId('plan'), this.now()),
        updatedAt: this.now(),
      };
    });

    if (!updated) failure ??= 'missing';
    if (failure !== null) throw plannedTaskError(failure);

    const task = updated as AgentTask;
    this.emit(task);
    // Resuming is what makes the approval take effect, and it goes through the
    // ordinary resume path: nothing about an approved plan starts a task any
    // differently from a person pressing Resume.
    await this.resume(taskId);
    return task;
  }

  /**
   * Sends a proposal back to be rewritten.
   *
   * Creates no authorization, widens nothing and touches no security state:
   * the proposal is dropped, the person's note is kept, and the task goes
   * round the planning turn again. A task that is already approved is refused,
   * because re-proposing under an authorization already given would produce a
   * plan the person never saw approved.
   */
  async revisePlan(taskId: string, note?: string): Promise<AgentTask> {
    const trimmed = note?.trim().slice(0, MAX_REVISION_NOTE) ?? '';
    let failure: PlanFailure | null = null;
    const updated = await this.options.store.updateTask(taskId, (task) => {
      if (isTerminal(task.state)) {
        failure = 'finished';
        return task;
      }
      if (task.planApproval !== undefined) {
        failure = 'already-approved';
        return task;
      }
      const { planProposal: _rejected, planRevisionNote: _previous, ...rest } = task;
      return {
        ...rest,
        ...(trimmed.length === 0 ? {} : { planRevisionNote: trimmed }),
        updatedAt: this.now(),
      };
    });

    if (!updated) failure ??= 'missing';
    if (failure !== null) throw plannedTaskError(failure);

    const task = updated as AgentTask;
    this.emit(task);
    await this.resume(taskId);
    return task;
  }

  /**
   * Adds a site to a task's approved plan.
   *
   * Called when a person answers a prompt with "allow for this task". It
   * amends an existing approval and can never create one: a task that never
   * planned has nothing to amend, and this returns having changed nothing
   * rather than inventing an authorization the person was never shown.
   *
   * No `SiteRule` is written. The site is authorised for as long as this task
   * runs and not one moment longer.
   */
  async addSiteToPlan(taskId: string, site: string): Promise<void> {
    await this.options.store.updateTask(taskId, (task) => {
      if (task.planApproval === undefined) return task;
      const amended = amendPlan(task.planApproval, site, this.now());
      if (amended === task.planApproval) return task;
      return { ...task, planApproval: amended, updatedAt: this.now() };
    });
  }

  /**
   * Parks a task while a person does something only they can do.
   *
   * Choosing a file in a picker is the first such case. There is deliberately
   * no deadline attached here: the broker owns the timeout, and a task
   * waiting on a human must not be failed by a clock.
   */
  async markWaitingForUser(taskId: string, summary: string): Promise<void> {
    await this.transition(taskId, 'WAITING_FOR_USER', summary);
  }

  /** Returns a task to RUNNING once the person has answered. */
  async markUserResponded(taskId: string): Promise<void> {
    await this.transition(taskId, 'RUNNING');
  }

  async pause(taskId: string): Promise<TaskState> {
    // Pausing aborts the in-flight turn; the task record keeps its history so
    // a resume starts a fresh turn rather than a half-finished one. The handle
    // is removed only after aborting, so a task still starting up sees the
    // abort when it picks the handle up.
    const controller = this.running.get(taskId);
    controller?.abort();
    this.running.delete(taskId);
    await this.transition(taskId, 'PAUSED', 'Paused.');
    return (await this.options.store.getTask(taskId))?.state ?? 'PAUSED';
  }

  async resume(taskId: string): Promise<TaskState> {
    await this.requireHealthyPersistence('resuming a task');
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new TaskManagerError(createError('INVALID_ARGUMENT', 'That task no longer exists.'));
    }
    if (isTerminal(task.state)) {
      throw new TaskManagerError(
        createError('INVALID_ARGUMENT', `A ${task.state} task cannot be resumed.`, {
          userMessage: `This task already finished (${task.state}). Use retry to run it again.`,
        }),
      );
    }
    if (this.running.has(taskId)) return task.state;

    this.running.set(taskId, new AbortController());
    void this.execute(taskId).catch(() => undefined);
    return 'RUNNING';
  }

  async cancel(taskId: string): Promise<TaskState> {
    const controller = this.running.get(taskId);
    controller?.abort();
    this.running.delete(taskId);
    await this.transition(taskId, 'CANCELLED', 'Cancelled by the user.');
    return 'CANCELLED';
  }

  /** Starts a fresh task with the same objective. History is never rewritten. */
  async retry(taskId: string): Promise<AgentTask> {
    await this.requireHealthyPersistence('retrying a task');
    const previous = await this.options.store.getTask(taskId);
    if (!previous) {
      throw new TaskManagerError(createError('INVALID_ARGUMENT', 'That task no longer exists.'));
    }
    if (!isTerminal(previous.state)) await this.cancel(taskId);
    // The shape carries; the authorization does not. A retry is a new task,
    // and a plan approved for the previous one was approved against a proposal
    // this one has not made yet.
    return this.create(previous.objective, previous.sessionId, {
      ...(previous.authorizationModel === undefined
        ? {}
        : { authorizationModel: previous.authorizationModel }),
    });
  }

  private async fail(taskId: string, error: AgentError): Promise<void> {
    const updated = await this.options.store.updateTask(taskId, (task) =>
      isTerminal(task.state)
        ? task
        : {
            ...task,
            state: 'FAILED' as const,
            error,
            finishedAt: this.now(),
            updatedAt: this.now(),
          },
    );
    if (updated) this.emit(updated);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Aborts everything in flight. Used when the worker is shutting down. */
  abortAll(): void {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private emit(task: AgentTask): void {
    broadcastEvent({ type: 'task.updated', task });
  }
}

/** The ways a plan operation can arrive at a task that cannot take it. */
type PlanFailure = 'missing' | 'no-proposal' | 'already-approved' | 'finished';

function plannedTaskError(reason: PlanFailure): TaskManagerError {
  switch (reason) {
    case 'missing':
      return new TaskManagerError(createError('INVALID_ARGUMENT', 'That task no longer exists.'));
    case 'no-proposal':
      return new TaskManagerError(
        createError('INVALID_ARGUMENT', 'That task has no plan to approve.', {
          userMessage: 'There is no plan waiting for approval on this task.',
        }),
      );
    case 'finished':
      return new TaskManagerError(
        createError('INVALID_ARGUMENT', 'That task has already finished.', {
          userMessage: 'This task has finished. Start a new one to plan again.',
          retryable: false,
        }),
      );
    case 'already-approved':
      return new TaskManagerError(
        createError('POLICY_BLOCKED', 'That task already has an approved plan.', {
          userMessage:
            'This task is already running under an approved plan. Stop it and start a new ' +
            'one to plan again.',
          retryable: false,
        }),
      );
  }
}

export class TaskManagerError extends Error {
  constructor(readonly agentError: AgentError) {
    super(agentError.message);
    this.name = 'TaskManagerError';
  }
}
