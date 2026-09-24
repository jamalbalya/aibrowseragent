/**
 * Firing schedules (P-020).
 *
 * This is the clock, and only the clock. It decides *when* something runs and
 * records what happened; it decides nothing about whether the thing is safe.
 * Every action a scheduled run takes goes through `SkillRunner` →
 * `ToolRegistry.dispatch` → the policy engine → the permission engine, the
 * same sequence a run a person started by hand goes through, evaluated at the
 * moment of the action against the permission mode in force then.
 *
 * Three things this module deliberately is not:
 *
 * **It is not a second task engine.** It calls the existing replay and launch
 * routes and consumes the task lifecycle they already produce. There is no
 * scheduled-run state machine here, no scheduled dispatch, and no code path
 * to a tool.
 *
 * **It does not evaluate policy.** There is no risk level, no permission mode
 * and no site rule anywhere in this file. It cannot allow anything, and the
 * one thing it can do about safety is stop.
 *
 * **It grants nothing.** A scheduled run carries no stored approval, no
 * standing authorisation and no "always allow". When a run reaches an action
 * that requires a person to confirm it, the run stops — see
 * `UnattendedPrompter` and `docs/architecture/SCHEDULED_EXECUTION.md`. That is
 * an explicit AI Browser Agent product decision, taken because the
 * alternative is an agent taking a consequential action on a website with
 * nobody present to see it.
 */
import { getLogger } from '@/logging/logger';
import { describeBlock, type PersistenceHealthStore } from '@/storage/persistence-health';
import {
  isUnattendedSessionId,
  runIdFor,
  unattendedSessionIdFor,
  type ScheduleRecord,
  type ScheduleRunReason,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleTarget,
} from '@/schedules/schedule-model';
import { nextWakeUp, occurrencesDue } from '@/schedules/schedule-clock';
import { ScheduleError, type ScheduleStore } from '@/schedules/schedule-store';
import { newSessionId } from '@/utils/ids';

const log = getLogger('agent');

/** What a schedule's target turned out to be, resolved at the moment of firing. */
export type TargetResolution =
  | { readonly ok: true; readonly kind: 'workflow'; readonly workflowId: string }
  | {
      readonly ok: true;
      readonly kind: 'skill';
      readonly skillId: string;
      readonly skillVersion: string;
    }
  | { readonly ok: false; readonly reason: ScheduleRunReason; readonly detail: string };

/** The result of handing a target to the route that owns it. */
export type ScheduledExecution =
  | {
      readonly ok: true;
      readonly taskId: string;
      readonly status: 'completed' | 'failed' | 'cancelled' | 'refused';
      /**
       * Why a step was refused, when one was.
       *
       * The dispatch path already separates the two cases and this carries
       * that distinction through rather than re-deriving it: `POLICY_BLOCKED`
       * is an action that was not permitted at all, and `PERMISSION_DENIED`
       * is one that needed a person. Telling a user to run something
       * themselves when nobody could ever have approved it would be a lie,
       * and telling them nothing was permitted when they simply were not
       * there would be another one.
       */
      readonly refusal?: 'POLICY_BLOCKED' | 'PERMISSION_DENIED';
    }
  | { readonly ok: false; readonly reason: ScheduleRunReason; readonly detail: string };

export interface ScheduleAuditEvent {
  readonly type:
    | 'schedule.created'
    | 'schedule.updated'
    | 'schedule.paused'
    | 'schedule.resumed'
    | 'schedule.deleted'
    | 'schedule.run_started'
    | 'schedule.run_completed'
    | 'schedule.run_failed'
    | 'schedule.run_blocked'
    | 'schedule.run_cancelled'
    | 'schedule.run_missed';
  readonly scheduleId: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly outcome: 'allowed' | 'denied' | 'failed' | 'info';
  /** A closed vocabulary code. Never text from a page, a model or a tool. */
  readonly code?: string;
}

/** What the user is told, and when. */
export type ScheduleNotification =
  | { readonly kind: 'started'; readonly name: string }
  | { readonly kind: 'completed'; readonly name: string }
  | { readonly kind: 'failed'; readonly name: string }
  | { readonly kind: 'blocked'; readonly name: string; readonly reason: ScheduleRunReason };

export interface ScheduleRunnerOptions {
  readonly store: ScheduleStore;
  /**
   * Looks up what a schedule points at, now.
   *
   * Re-resolved at every firing rather than trusted from creation: a shortcut
   * can be retargeted, a workflow deleted, a skill withdrawn from the
   * registry, and a schedule must follow all three rather than keep running
   * whatever was there when it was made.
   */
  readonly resolveTarget: (target: ScheduleTarget) => Promise<TargetResolution>;
  readonly runWorkflow: (input: {
    readonly workflowId: string;
    readonly sessionId: string;
  }) => Promise<ScheduledExecution>;
  readonly runSkill: (input: {
    readonly skillId: string;
    readonly skillVersion: string;
    readonly sessionId: string;
  }) => Promise<ScheduledExecution>;
  /** Stops a task that is currently running. */
  readonly cancelTask: (taskId: string) => boolean;
  /**
   * Durable persistence health, consulted before a run begins.
   *
   * The same gate `TaskManager` applies, for the same reason: a run whose
   * security state cannot be persisted is a run whose taint is not
   * established, and every check downstream reads that taint.
   */
  readonly health?: PersistenceHealthStore;
  readonly audit?: (event: ScheduleAuditEvent) => Promise<void>;
  readonly notify?: (event: ScheduleNotification) => void;
  /** Asks Chrome to wake the worker at an instant, or clears the alarm. */
  readonly setWakeUp: (at: number | undefined) => Promise<void>;
  readonly onChanged?: () => void;
  readonly now?: () => number;
}

export class ScheduleRunner {
  private readonly now: () => number;
  /** Sessions that hit the confirmation boundary during the current worker generation. */
  private readonly refusedSessions = new Set<string>();
  /** Session → task, so a run in flight can be cancelled by the person who scheduled it. */
  private readonly sessionTasks = new Map<string, string>();
  /** Serialises ticks: two wake-ups must not walk the same schedules at once. */
  private ticking: Promise<void> | null = null;

  constructor(private readonly options: ScheduleRunnerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Told that an unattended run reached the confirmation boundary.
   *
   * Wired to `UnattendedPrompter`. It records the fact so the run's outcome
   * can say *why* it stopped — "this needed you to approve something" rather
   * than the indistinguishable "a tool was refused".
   */
  noteConfirmationRefusal(sessionId: string): void {
    this.refusedSessions.add(sessionId);
  }

  /** Told which task an unattended session produced, so the run can be cancelled. */
  observeTask(taskId: string, sessionId: string): void {
    if (!isUnattendedSessionId(sessionId)) return;
    this.sessionTasks.set(sessionId, taskId);
  }

  /* -------------------------------- ticking ------------------------------- */

  /**
   * Reconciles every schedule against the clock, then re-arms the alarm.
   *
   * Serialised: a second call while one is in flight awaits the first rather
   * than walking the same schedules beside it. Duplicate alarm deliveries are
   * ordinary in MV3, and the occurrence claim would refuse the second anyway
   * — this just stops it doing the work to find that out.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      await this.ticking;
      return;
    }
    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    await run;
  }

  private async runTick(): Promise<void> {
    const schedules = await this.options.store.list();
    for (const schedule of schedules) {
      try {
        await this.advance(schedule);
      } catch (error) {
        log.error('A schedule could not be advanced.', {
          scheduleId: schedule.scheduleId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.rearm();
  }

  /** Re-arms the single alarm from whatever the schedules now say. */
  async rearm(): Promise<void> {
    const at = nextWakeUp(await this.options.store.list());
    await this.options.setWakeUp(at);
  }

  private async advance(schedule: ScheduleRecord): Promise<void> {
    const verdict = occurrencesDue(schedule, this.now());

    for (const occurrenceAt of verdict.missed) {
      await this.recordMissed(schedule, occurrenceAt);
    }

    if (verdict.due === undefined) return;
    await this.fire(schedule, verdict.due);
  }

  /**
   * Records an occurrence that went past without running.
   *
   * The occurrence is claimed as it is recorded, so a later wake-up cannot
   * pick it up and run it late. It is never replayed: see
   * `docs/architecture/SCHEDULED_EXECUTION.md` for why a catch-up run is the
   * wrong behaviour for an agent that acts on live web pages.
   */
  private async recordMissed(schedule: ScheduleRecord, occurrenceAt: number): Promise<void> {
    const claimed = await this.options.store.skipOccurrence(schedule.scheduleId, occurrenceAt);
    if (!claimed) return;

    const runId = runIdFor(schedule.scheduleId, occurrenceAt);
    await this.options.store.startRun({
      runId,
      scheduleId: schedule.scheduleId,
      occurrenceAt,
      status: 'missed',
      reason: 'MISSED_WHILE_ASLEEP',
    });
    await this.options.store.recordOutcome(schedule.scheduleId, {
      at: occurrenceAt,
      status: 'missed',
      reason: 'MISSED_WHILE_ASLEEP',
    });
    await this.emit({
      type: 'schedule.run_missed',
      scheduleId: schedule.scheduleId,
      runId,
      outcome: 'info',
      code: 'MISSED_WHILE_ASLEEP',
    });
    this.options.onChanged?.();
  }

  /**
   * Runs one occurrence, unattended.
   *
   * The occurrence is claimed first. Everything after the claim is best
   * effort: if the worker dies halfway, the occurrence stays claimed and is
   * never run again, which is the safe direction for an agent that clicks
   * things.
   */
  private async fire(schedule: ScheduleRecord, occurrenceAt: number): Promise<void> {
    const claim = await this.options.store.claimOccurrence(schedule.scheduleId, occurrenceAt);
    if (!claim.ok) {
      log.debug('An occurrence was already claimed.', {
        scheduleId: schedule.scheduleId,
        reason: claim.reason,
      });
      return;
    }
    await this.execute(claim.schedule, {
      runId: claim.runId,
      occurrenceAt,
      sessionId: unattendedSessionIdFor(claim.runId),
      attended: false,
    });
  }

  /**
   * Runs a schedule immediately because a person asked.
   *
   * Attended, deliberately, and the difference is the whole point: a person
   * pressing "Run now" has the panel open and can answer a confirmation, so
   * the run gets an ordinary session and the ordinary interactive prompter.
   * This is how somebody acts on a run that stopped at the boundary — the
   * blocked run tells them what it needed, and they run it themselves and
   * answer.
   *
   * It does **not** touch the schedule's clock. No occurrence is claimed, the
   * next scheduled firing is unchanged, and a missed occurrence stays missed.
   */
  async runNow(scheduleId: string): Promise<ScheduleRunRecord | undefined> {
    const schedule = await this.options.store.get(scheduleId);
    if (!schedule) throw new ScheduleError('NOT_FOUND', 'That schedule no longer exists.');
    const at = this.now();
    return this.execute(schedule, {
      runId: runIdFor(scheduleId, at),
      occurrenceAt: at,
      sessionId: newSessionId(),
      attended: true,
    });
  }

  private async execute(
    schedule: ScheduleRecord,
    run: {
      readonly runId: string;
      readonly occurrenceAt: number;
      readonly sessionId: string;
      readonly attended: boolean;
    },
  ): Promise<ScheduleRunRecord | undefined> {
    const blocked = await this.persistenceBlocked();
    if (blocked !== undefined) {
      return this.settle(schedule, run, 'blocked', 'PERSISTENCE_BLOCKED', blocked);
    }

    const target = await this.options.resolveTarget(schedule.target);
    if (!target.ok) {
      return this.settle(schedule, run, 'blocked', target.reason, target.detail);
    }

    await this.options.store.startRun({
      runId: run.runId,
      scheduleId: schedule.scheduleId,
      occurrenceAt: run.occurrenceAt,
      status: 'running',
    });
    await this.emit({
      type: 'schedule.run_started',
      scheduleId: schedule.scheduleId,
      runId: run.runId,
      outcome: 'info',
      code: run.attended ? 'RUN_NOW' : 'SCHEDULED',
    });
    this.options.notify?.({ kind: 'started', name: schedule.displayName });
    this.options.onChanged?.();

    let execution: ScheduledExecution;
    try {
      execution =
        target.kind === 'workflow'
          ? await this.options.runWorkflow({
              workflowId: target.workflowId,
              sessionId: run.sessionId,
            })
          : await this.options.runSkill({
              skillId: target.skillId,
              skillVersion: target.skillVersion,
              sessionId: run.sessionId,
            });
    } catch (error) {
      log.error('A scheduled run threw outside the execution path.', {
        scheduleId: schedule.scheduleId,
        error: error instanceof Error ? error.message : String(error),
      });
      execution = {
        ok: false,
        reason: 'INTERNAL_ERROR',
        detail: 'The run stopped because of an internal error.',
      };
    } finally {
      this.sessionTasks.delete(run.sessionId);
    }

    const hitBoundary = this.refusedSessions.delete(run.sessionId);

    if (!execution.ok) {
      return this.settle(schedule, run, 'blocked', execution.reason, execution.detail);
    }

    const { status, reason } = classify(execution.status, hitBoundary, execution.refusal);
    return this.settle(schedule, run, status, reason, undefined, execution.taskId);
  }

  /**
   * Writes the outcome everywhere it has to appear: the run record, the
   * schedule's own summary, the audit trail and the notification.
   *
   * One place, so a run can never be completed in the history and blocked in
   * the list, or finished without a trail.
   */
  private async settle(
    schedule: ScheduleRecord,
    run: { readonly runId: string; readonly occurrenceAt: number },
    status: ScheduleRunStatus,
    reason: ScheduleRunReason | undefined,
    detail?: string,
    taskId?: string,
  ): Promise<ScheduleRunRecord | undefined> {
    const existing = await this.options.store.getRun(run.runId);
    if (!existing) {
      await this.options.store.startRun({
        runId: run.runId,
        scheduleId: schedule.scheduleId,
        occurrenceAt: run.occurrenceAt,
        status,
        ...(reason === undefined ? {} : { reason }),
        ...(taskId === undefined ? {} : { taskId }),
      });
    } else {
      await this.options.store.finishRun(run.runId, {
        status,
        ...(reason === undefined ? {} : { reason }),
        ...(taskId === undefined ? {} : { taskId }),
      });
    }

    await this.options.store.recordOutcome(schedule.scheduleId, {
      at: this.now(),
      status,
      ...(reason === undefined ? {} : { reason }),
    });

    await this.emit({
      type:
        status === 'completed'
          ? 'schedule.run_completed'
          : status === 'blocked'
            ? 'schedule.run_blocked'
            : status === 'cancelled'
              ? 'schedule.run_cancelled'
              : 'schedule.run_failed',
      scheduleId: schedule.scheduleId,
      runId: run.runId,
      ...(taskId === undefined ? {} : { taskId }),
      outcome: status === 'completed' ? 'allowed' : status === 'blocked' ? 'denied' : 'failed',
      ...(reason === undefined ? {} : { code: reason }),
    });

    if (status === 'completed') {
      this.options.notify?.({ kind: 'completed', name: schedule.displayName });
    } else if (status === 'blocked') {
      this.options.notify?.({
        kind: 'blocked',
        name: schedule.displayName,
        reason: reason ?? 'POLICY_DENIED',
      });
    } else if (status === 'failed') {
      this.options.notify?.({ kind: 'failed', name: schedule.displayName });
    }

    if (detail !== undefined) {
      log.info('A scheduled run ended without completing.', {
        scheduleId: schedule.scheduleId,
        status,
        reason,
      });
    }

    this.options.onChanged?.();
    return this.options.store.getRun(run.runId);
  }

  /* ----------------------------- cancellation ---------------------------- */

  /**
   * Stops a run that is in flight.
   *
   * Steps already taken are not undone — nothing here can un-click a button —
   * so this aborts the rest and records the run as cancelled.
   */
  async cancelRun(runId: string): Promise<boolean> {
    const run = await this.options.store.getRun(runId);
    if (!run || run.status !== 'running') return false;

    const sessionId = unattendedSessionIdFor(runId);
    const taskId = run.taskId ?? this.sessionTasks.get(sessionId);
    const stopped = taskId === undefined ? false : this.options.cancelTask(taskId);

    await this.options.store.finishRun(runId, { status: 'cancelled', reason: 'CANCELLED' });
    await this.options.store.recordOutcome(run.scheduleId, {
      at: this.now(),
      status: 'cancelled',
      reason: 'CANCELLED',
    });
    await this.emit({
      type: 'schedule.run_cancelled',
      scheduleId: run.scheduleId,
      runId,
      ...(taskId === undefined ? {} : { taskId }),
      outcome: 'info',
      code: 'CANCELLED',
    });
    this.options.onChanged?.();
    return stopped || true;
  }

  /* ------------------------------ recovery ------------------------------- */

  /**
   * Reconciles after a worker restart, before any alarm is handled.
   *
   * A run still marked `running` belongs to a worker generation that no
   * longer exists. It is closed as interrupted rather than resumed: the page
   * it was working on has moved on, its abort handle is gone, and resuming
   * halfway through a sequence of browser actions is how a workflow does the
   * second half of something to the wrong page.
   *
   * Its occurrence stays claimed, so the interrupted run is not retried and
   * cannot be run twice.
   */
  async recover(): Promise<number> {
    const stale = await this.options.store.listRunningRuns();
    for (const run of stale) {
      await this.options.store.finishRun(run.runId, {
        status: 'failed',
        reason: 'INTERRUPTED',
      });
      await this.options.store.recordOutcome(run.scheduleId, {
        at: this.now(),
        status: 'failed',
        reason: 'INTERRUPTED',
      });
      await this.emit({
        type: 'schedule.run_failed',
        scheduleId: run.scheduleId,
        runId: run.runId,
        outcome: 'failed',
        code: 'INTERRUPTED',
      });
    }
    if (stale.length > 0) {
      log.info('Closed scheduled runs interrupted by a worker restart.', { count: stale.length });
      this.options.onChanged?.();
    }
    return stale.length;
  }

  /* ------------------------------ internals ------------------------------ */

  private async persistenceBlocked(): Promise<string | undefined> {
    if (!this.options.health) return undefined;
    try {
      const snapshot = await this.options.health.snapshot();
      return snapshot.blocked ? describeBlock(snapshot) : undefined;
    } catch {
      // Unreadable health is not healthy.
      return 'Stored state could not be checked, so this run did not start.';
    }
  }

  private async emit(event: ScheduleAuditEvent): Promise<void> {
    try {
      await this.options.audit?.(event);
    } catch (error) {
      // A record of a run is not the run.
      log.warn('A schedule event could not be added to the audit trail.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/**
 * Turns a run's status into a schedule outcome.
 *
 * The one place `refused` is split into its two meanings. A refusal that came
 * with a confirmation-boundary denial is `CONFIRMATION_REQUIRED` — the run
 * needed a person. Any other refusal is `POLICY_DENIED` — the action was not
 * permitted at all, and a person would not have been asked.
 */
function classify(
  status: 'completed' | 'failed' | 'cancelled' | 'refused',
  hitBoundary: boolean,
  refusal?: 'POLICY_BLOCKED' | 'PERMISSION_DENIED',
): { status: ScheduleRunStatus; reason?: ScheduleRunReason } {
  if (status === 'completed') return { status: 'completed' };
  if (status === 'cancelled') return { status: 'cancelled', reason: 'CANCELLED' };

  // The refusal code the dispatch path produced is the most precise thing
  // available and is preferred over everything else. `hitBoundary` is a
  // fallback for the case where a prompt was raised and refused but the step
  // ended some other way.
  if (refusal === 'PERMISSION_DENIED') {
    return { status: 'blocked', reason: 'CONFIRMATION_REQUIRED' };
  }
  if (refusal === 'POLICY_BLOCKED') {
    return { status: 'blocked', reason: 'POLICY_DENIED' };
  }
  if (hitBoundary) {
    return { status: 'blocked', reason: 'CONFIRMATION_REQUIRED' };
  }
  if (status === 'refused') return { status: 'blocked', reason: 'POLICY_DENIED' };
  return { status: 'failed', reason: 'RUN_FAILED' };
}
