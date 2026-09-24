/**
 * MV3 lifecycle management (specification sections 6.2, 24, 90).
 *
 * Service workers are evicted whenever Chrome decides to, taking every
 * in-memory handle with them. This module reconciles persisted state with that
 * reality on each startup: a task that was mid-flight is not silently resumed
 * — the page it was working on may have moved — it is parked so the user can
 * resume or retry deliberately.
 */
import { getLogger } from '@/logging/logger';
import type { TaskStore } from '@/tasks/task-store';
import { recoveryStateFor } from '@/tasks/task-store';
import { isTerminal } from '@/tasks/task-model';
import type { DebuggerManager } from '@/tools/debugger/debugger-manager';
import type { FieldObservationStore } from '@/policy/field-observation-store';

const log = getLogger('agent');

export interface LifecycleOptions {
  readonly store: TaskStore;
  readonly debuggerManager: DebuggerManager;
  /**
   * Field observations to drop when a tab goes away.
   *
   * Not a security boundary — a handle from a closed tab is refused by its
   * generation anyway, and by the content script that no longer exists to
   * receive it. This is housekeeping: without it the map keeps one entry per
   * tab the browser ever opened, for as long as the worker lives.
   */
  readonly fieldObservations: FieldObservationStore;
  readonly now?: () => number;
}

export interface RecoveryReport {
  readonly recovered: number;
  readonly taskIds: readonly string[];
}

export class LifecycleManager {
  private readonly now: () => number;

  constructor(private readonly options: LifecycleOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Reconciles interrupted tasks on worker startup.
   *
   * Runs before any message is handled so the side panel never observes a task
   * still claiming RUNNING when nothing is executing it.
   */
  async recoverInterruptedTasks(): Promise<RecoveryReport> {
    const interrupted = await this.options.store.listInterrupted();
    const recovered: string[] = [];

    for (const task of interrupted) {
      const next = recoveryStateFor(task.state);
      if (next === task.state) continue;

      await this.options.store.updateTask(task.id, (current) =>
        isTerminal(current.state)
          ? current
          : {
              ...current,
              state: next,
              currentStepSummary:
                'Paused: the extension restarted while this task was running. ' +
                'Resume to continue, or retry to start again.',
              updatedAt: this.now(),
            },
      );
      recovered.push(task.id);
    }

    if (recovered.length > 0) {
      log.info('Recovered tasks interrupted by a worker restart.', { count: recovered.length });
    }
    return { recovered: recovered.length, taskIds: recovered };
  }

  /**
   * Detaches the debugger from a tab that closed or navigated away.
   * Without this, Chrome's debugging banner can outlive the task.
   */
  handleTabClosed(tabId: number): void {
    if (this.options.debuggerManager.isAttached(tabId)) {
      void this.options.debuggerManager.detach(tabId);
    }
    this.options.fieldObservations.forget(tabId);
  }

  /** Releases every external resource this worker generation holds. */
  async shutdown(): Promise<void> {
    await this.options.debuggerManager.detachAll();
  }
}
