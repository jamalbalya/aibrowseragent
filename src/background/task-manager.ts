/**
 * Task manager.
 *
 * Owns task lifecycle in the service worker: creation, execution, pause,
 * resume, cancel and retry. All state changes go through the persistent store
 * so a worker eviction mid-task loses nothing but the in-memory abort handle.
 */
import { getLogger } from '@/logging/logger';
import { createError, type AgentError } from '@/types/result';
import { newTaskId } from '@/utils/ids';
import type { AgentRuntime, RuntimeCallbacks } from '@/agent/runtime/agent-runtime';
import type { AIProviderAdapter, ModelCapabilities } from '@/providers/core/types';
import type { TaskStore } from '@/tasks/task-store';
import {
  canTransition,
  createTask,
  isTerminal,
  type AgentTask,
  type TaskState,
  type TaskStep,
  type TaskUsage,
} from '@/tasks/task-model';
import type { PermissionMode } from '@/policy/policy-engine';
import { broadcastEvent } from '@/messaging/bus';
import type { EvidenceReference } from '@/evidence/evidence-model';

const log = getLogger('task');

export interface TaskManagerOptions {
  readonly store: TaskStore;
  /** Resolves the provider + capabilities for a task at run time. */
  readonly resolveProvider: () => Promise<{
    adapter: AIProviderAdapter;
    capabilities: ModelCapabilities;
    providerId: string;
    modelId: string;
  }>;
  readonly getPermissionMode: () => Promise<PermissionMode>;
  readonly getActiveTabId: () => Promise<number | undefined>;
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

  /** Creates a task and starts it. Execution proceeds in the background. */
  async create(objective: string, sessionId: string): Promise<AgentTask> {
    const trimmed = objective.trim();
    if (trimmed.length === 0) {
      throw new TaskManagerError(
        createError('INVALID_ARGUMENT', 'A task needs an objective.', {
          userMessage: 'Describe what you want the agent to do.',
        }),
      );
    }

    const provider = await this.options.resolveProvider();
    const task = createTask({
      id: newTaskId(),
      sessionId,
      objective: trimmed,
      providerId: provider.providerId,
      modelId: provider.modelId,
      permissionMode: await this.options.getPermissionMode(),
      now: this.now(),
    });

    await this.options.store.saveTask(task);
    this.emit(task);

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
      const tabId = await this.options.getActiveTabId();

      const started = await this.transition(taskId, 'PLANNING');
      if (!started) return;

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
    return allowed;
  }

  /** Callbacks the runtime uses to report progress. */
  createCallbacks(): RuntimeCallbacks {
    return {
      onStateChange: async (taskId, state, summary) => {
        await this.transition(taskId, state, summary);
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
    const previous = await this.options.store.getTask(taskId);
    if (!previous) {
      throw new TaskManagerError(createError('INVALID_ARGUMENT', 'That task no longer exists.'));
    }
    if (!isTerminal(previous.state)) await this.cancel(taskId);
    return this.create(previous.objective, previous.sessionId);
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

export class TaskManagerError extends Error {
  constructor(readonly agentError: AgentError) {
    super(agentError.message);
    this.name = 'TaskManagerError';
  }
}
