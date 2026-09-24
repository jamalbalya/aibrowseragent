/**
 * Where schedules and their run history live.
 *
 * Two record sets in one class because they are written together and are
 * meaningless apart: a schedule without its runs cannot say what happened,
 * and a run without its schedule names nothing.
 *
 * The store owns one property nothing else can: **an occurrence is claimed at
 * most once**. Chrome fires alarms more than once in practice — a wake-up
 * races a startup reconciliation, an alarm survives an eviction and is
 * delivered again, two events arrive in the same worker generation — and the
 * only defence that works is for the check and the claim to be a single
 * operation on the record. That is `claimOccurrence`, and it is the reason
 * `RecordStore.mutate` exists.
 *
 * Nothing here executes anything. There is no path from this class to
 * `SkillRunner`, `WorkflowReplayer` or `ToolRegistry`.
 */
import { newId } from '@/utils/ids';
import type { TransactionalStorageArea } from '@/storage/storage-area';
import { RecordStore } from '@/storage/record-store';
import type { PersistenceHealthStore } from '@/storage/persistence-health';
import {
  assertScheduleSafe,
  isUsableCadence,
  isUsableSchedule,
  isUsableScheduleRun,
  isUsableTarget,
  nextOccurrence,
  runIdFor,
  SCHEDULE_FORMAT_VERSION,
  SCHEDULE_RUN_FORMAT_VERSION,
  type ScheduleCadence,
  type ScheduleRecord,
  type ScheduleRunReason,
  type ScheduleRunRecord,
  type ScheduleRunStatus,
  type ScheduleTarget,
} from './schedule-model';

const MAX_SCHEDULES = 50;
/** Run history is a log, not an archive. The oldest are evicted. */
const MAX_RUNS = 250;
const MAX_NAME_LENGTH = 80;

export type ScheduleRefusal =
  'NAME_REQUIRED' | 'NAME_TAKEN' | 'TOO_MANY' | 'NOT_FOUND' | 'INVALID_TARGET' | 'INVALID_CADENCE';

export class ScheduleError extends Error {
  constructor(
    readonly reason: ScheduleRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/**
 * Accepts a stored schedule, or does not.
 *
 * Both gates, in the order they are always applied: the shape check, and the
 * prohibited-field assertion that keeps a payload or a credential out of a
 * record whose type has nowhere to put one.
 */
function isStorableSchedule(candidate: unknown): candidate is ScheduleRecord {
  if (!isUsableSchedule(candidate)) return false;
  try {
    assertScheduleSafe(candidate as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
  return true;
}

function isStorableRun(candidate: unknown): candidate is ScheduleRunRecord {
  if (!isUsableScheduleRun(candidate)) return false;
  try {
    assertScheduleSafe(candidate as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
  return true;
}

export interface ScheduleStoreOptions {
  readonly area: TransactionalStorageArea;
  readonly now?: () => number;
  readonly health?: PersistenceHealthStore;
}

/** What a claim attempt produced. Anything but `ok` means: do not run. */
export type ClaimVerdict =
  | { readonly ok: true; readonly runId: string; readonly schedule: ScheduleRecord }
  | { readonly ok: false; readonly reason: 'ALREADY_CLAIMED' | 'NOT_FOUND' | 'PAUSED' };

export class ScheduleStore {
  private readonly now: () => number;
  private readonly schedules: RecordStore<ScheduleRecord>;
  private readonly runs: RecordStore<ScheduleRunRecord>;

  constructor(options: ScheduleStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.schedules = new RecordStore<ScheduleRecord>({
      area: options.area,
      kind: 'schedules',
      version: SCHEDULE_FORMAT_VERSION,
      identify: (record) => record.scheduleId,
      validate: isStorableSchedule,
      max: MAX_SCHEDULES,
      ...(options.health === undefined ? {} : { health: options.health }),
    });
    this.runs = new RecordStore<ScheduleRunRecord>({
      area: options.area,
      kind: 'schedule-runs',
      version: SCHEDULE_RUN_FORMAT_VERSION,
      identify: (record) => record.runId,
      validate: isStorableRun,
      max: MAX_RUNS,
      ...(options.health === undefined ? {} : { health: options.health }),
    });
  }

  /* ------------------------------ schedules ------------------------------ */

  /**
   * Creates a schedule, or refuses. Executes nothing.
   *
   * The target is **not** resolved here. Existence and usability are checked
   * by the caller before creation and again at every firing, because a target
   * that exists today can be deleted tomorrow and a schedule that trusted a
   * creation-time check would keep pointing at nothing.
   */
  async create(input: {
    readonly displayName: string;
    readonly target: ScheduleTarget;
    readonly cadence: ScheduleCadence;
    /**
     * Whether the new schedule is live.
     *
     * Required, with no default, because "it fires on its own from now on" is
     * a decision the caller has to make in writing. An optional flag
     * defaulting to `true` would be a permissive default in the one place
     * that starts unattended execution, and a caller that forgot it would
     * create a live schedule by omission.
     */
    readonly enabled: boolean;
  }): Promise<ScheduleRecord> {
    const displayName = input.displayName.trim().slice(0, MAX_NAME_LENGTH);
    if (displayName.length === 0) {
      throw new ScheduleError('NAME_REQUIRED', 'A schedule needs a name.');
    }
    if (!isUsableTarget(input.target)) {
      throw new ScheduleError('INVALID_TARGET', 'That is not something a schedule can point at.');
    }
    if (!isUsableCadence(input.cadence)) {
      throw new ScheduleError('INVALID_CADENCE', 'That is not a schedule this build can keep.');
    }

    const existing = await this.list();
    if (existing.length >= MAX_SCHEDULES) {
      throw new ScheduleError('TOO_MANY', `There is room for ${MAX_SCHEDULES} schedules.`);
    }
    if (existing.some((entry) => entry.displayName.toLowerCase() === displayName.toLowerCase())) {
      throw new ScheduleError(
        'NAME_TAKEN',
        `A schedule called "${displayName}" already exists. Choose a different name.`,
      );
    }

    const createdAt = this.now();
    const first = nextOccurrence(input.cadence, createdAt);
    if (first === undefined) {
      throw new ScheduleError('INVALID_CADENCE', 'That schedule never comes round.');
    }

    const record: ScheduleRecord = {
      scheduleId: newId('schedule'),
      formatVersion: SCHEDULE_FORMAT_VERSION,
      displayName,
      target: input.target,
      cadence: input.cadence,
      enabled: input.enabled,
      createdAt,
      updatedAt: createdAt,
      nextRunAt: first,
      // Nothing has been claimed yet, and the first occurrence is ahead of
      // creation, so no past instant can ever be claimed for a new schedule.
      lastClaimedOccurrenceAt: createdAt,
    };

    // The last gate before disk.
    assertScheduleSafe(record as unknown as Record<string, unknown>);
    await this.schedules.put(record);
    return record;
  }

  /**
   * Changes a schedule's name, target or cadence. Executes nothing.
   *
   * A cadence change recomputes `nextRunAt` from now and leaves
   * `lastClaimedOccurrenceAt` exactly where it was, so an edit can never
   * unclaim an occurrence that already ran.
   */
  async edit(
    scheduleId: string,
    patch: {
      readonly displayName?: string;
      readonly target?: ScheduleTarget;
      readonly cadence?: ScheduleCadence;
    },
  ): Promise<ScheduleRecord> {
    const existing = await this.get(scheduleId);
    if (!existing) throw new ScheduleError('NOT_FOUND', 'That schedule no longer exists.');

    let displayName = existing.displayName;
    if (patch.displayName !== undefined) {
      displayName = patch.displayName.trim().slice(0, MAX_NAME_LENGTH);
      if (displayName.length === 0) {
        throw new ScheduleError('NAME_REQUIRED', 'A schedule needs a name.');
      }
      const clash = (await this.list()).find(
        (entry) =>
          entry.scheduleId !== scheduleId &&
          entry.displayName.toLowerCase() === displayName.toLowerCase(),
      );
      if (clash) {
        throw new ScheduleError(
          'NAME_TAKEN',
          `A schedule called "${displayName}" already exists. Choose a different name.`,
        );
      }
    }

    if (patch.target !== undefined && !isUsableTarget(patch.target)) {
      throw new ScheduleError('INVALID_TARGET', 'That is not something a schedule can point at.');
    }
    if (patch.cadence !== undefined && !isUsableCadence(patch.cadence)) {
      throw new ScheduleError('INVALID_CADENCE', 'That is not a schedule this build can keep.');
    }

    const cadence = patch.cadence ?? existing.cadence;
    const updatedAt = this.now();
    let nextRunAt = existing.nextRunAt;
    if (patch.cadence !== undefined) {
      const recomputed = nextOccurrence(
        cadence,
        Math.max(updatedAt, existing.lastClaimedOccurrenceAt),
      );
      if (recomputed === undefined) {
        throw new ScheduleError('INVALID_CADENCE', 'That schedule never comes round.');
      }
      nextRunAt = recomputed;
    }

    const record: ScheduleRecord = {
      ...existing,
      displayName,
      target: patch.target ?? existing.target,
      cadence,
      nextRunAt,
      updatedAt,
    };
    assertScheduleSafe(record as unknown as Record<string, unknown>);
    // In place: an edit must not reorder the list the user is looking at.
    await this.schedules.replace(record);
    return record;
  }

  /**
   * Pauses or resumes.
   *
   * Resuming recomputes `nextRunAt` from now, so a schedule paused for a
   * month does not wake up owing thirty runs. The occurrences that passed
   * while it was paused are not missed runs either: a paused schedule was not
   * expected to fire, so there is nothing to record.
   */
  async setEnabled(scheduleId: string, enabled: boolean): Promise<ScheduleRecord> {
    const existing = await this.get(scheduleId);
    if (!existing) throw new ScheduleError('NOT_FOUND', 'That schedule no longer exists.');
    if (existing.enabled === enabled) return existing;

    const updatedAt = this.now();
    let nextRunAt = existing.nextRunAt;
    if (enabled) {
      const recomputed = nextOccurrence(
        existing.cadence,
        Math.max(updatedAt, existing.lastClaimedOccurrenceAt),
      );
      if (recomputed === undefined) {
        throw new ScheduleError('INVALID_CADENCE', 'That schedule never comes round.');
      }
      nextRunAt = recomputed;
    }

    const record: ScheduleRecord = { ...existing, enabled, nextRunAt, updatedAt };
    await this.schedules.replace(record);
    return record;
  }

  async list(): Promise<ScheduleRecord[]> {
    return [...(await this.schedules.list())];
  }

  async get(scheduleId: string): Promise<ScheduleRecord | undefined> {
    return this.schedules.get(scheduleId);
  }

  /** Deletes a schedule. Its run history is deleted with it. */
  async remove(scheduleId: string): Promise<void> {
    await this.schedules.remove(scheduleId);
    for (const run of await this.runs.list()) {
      if (run.scheduleId === scheduleId) await this.runs.remove(run.runId);
    }
  }

  /**
   * Claims one occurrence, atomically, at most once ever.
   *
   * The whole of the duplicate-execution defence. `lastClaimedOccurrenceAt`
   * only ever moves forward, and it moves inside the same read-modify-write
   * that decides whether it may: a second caller examining the same
   * occurrence — in this worker generation or the next — reads the advanced
   * value and is refused.
   *
   * A paused schedule is refused here as well as at the caller, because the
   * claim is the last point at which anything is still stoppable.
   */
  async claimOccurrence(scheduleId: string, occurrenceAt: number): Promise<ClaimVerdict> {
    let outcome: ClaimVerdict = { ok: false, reason: 'NOT_FOUND' };
    const updated = await this.schedules.mutate(scheduleId, (current) => {
      if (!current.enabled) {
        outcome = { ok: false, reason: 'PAUSED' };
        return undefined;
      }
      if (occurrenceAt <= current.lastClaimedOccurrenceAt) {
        outcome = { ok: false, reason: 'ALREADY_CLAIMED' };
        return undefined;
      }
      const next = nextOccurrence(current.cadence, occurrenceAt);
      return {
        ...current,
        lastClaimedOccurrenceAt: occurrenceAt,
        ...(next === undefined ? {} : { nextRunAt: next }),
        updatedAt: this.now(),
      };
    });
    if (!updated) return outcome;
    return { ok: true, runId: runIdFor(scheduleId, occurrenceAt), schedule: updated };
  }

  /**
   * Moves a schedule past an occurrence without running it.
   *
   * Used when an occurrence is recorded as missed. It is the same monotonic
   * claim, so a missed occurrence can never be claimed again by a later
   * wake-up and turned into a late run.
   */
  async skipOccurrence(
    scheduleId: string,
    occurrenceAt: number,
  ): Promise<ScheduleRecord | undefined> {
    return this.schedules.mutate(scheduleId, (current) => {
      if (occurrenceAt <= current.lastClaimedOccurrenceAt) return undefined;
      const next = nextOccurrence(current.cadence, occurrenceAt);
      return {
        ...current,
        lastClaimedOccurrenceAt: occurrenceAt,
        ...(next === undefined ? {} : { nextRunAt: next }),
        updatedAt: this.now(),
      };
    });
  }

  /** Records how the most recent firing ended, for the list the user reads. */
  async recordOutcome(
    scheduleId: string,
    outcome: {
      readonly at: number;
      readonly status: ScheduleRunStatus;
      readonly reason?: ScheduleRunReason;
    },
  ): Promise<ScheduleRecord | undefined> {
    return this.schedules.mutate(scheduleId, (current) => ({
      ...current,
      lastRunAt: outcome.at,
      lastRunStatus: outcome.status,
      ...(outcome.reason === undefined ? {} : { lastRunReason: outcome.reason }),
      updatedAt: this.now(),
    }));
  }

  /* -------------------------------- runs -------------------------------- */

  /**
   * Opens a run record, or returns the one that already exists.
   *
   * Deterministic ids make this idempotent: writing the same occurrence twice
   * produces one record, whichever wake-up got there first.
   */
  async startRun(input: {
    readonly runId: string;
    readonly scheduleId: string;
    readonly occurrenceAt: number;
    readonly status: ScheduleRunStatus;
    readonly reason?: ScheduleRunReason;
    readonly taskId?: string;
  }): Promise<ScheduleRunRecord> {
    const existing = await this.runs.get(input.runId);
    if (existing) return existing;
    const record: ScheduleRunRecord = {
      runId: input.runId,
      formatVersion: SCHEDULE_RUN_FORMAT_VERSION,
      scheduleId: input.scheduleId,
      occurrenceAt: input.occurrenceAt,
      startedAt: this.now(),
      status: input.status,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.status === 'running' ? {} : { finishedAt: this.now() }),
    };
    assertScheduleSafe(record as unknown as Record<string, unknown>);
    await this.runs.put(record);
    return record;
  }

  /** Closes a run. A run already in a terminal status is left alone. */
  async finishRun(
    runId: string,
    outcome: {
      readonly status: ScheduleRunStatus;
      readonly reason?: ScheduleRunReason;
      readonly taskId?: string;
    },
  ): Promise<ScheduleRunRecord | undefined> {
    return this.runs.mutate(runId, (current) => {
      if (current.status !== 'running') return undefined;
      return {
        ...current,
        status: outcome.status,
        finishedAt: this.now(),
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }),
      };
    });
  }

  /** Attaches the task a run created, once the run has one. */
  async attachTask(runId: string, taskId: string): Promise<ScheduleRunRecord | undefined> {
    return this.runs.mutate(runId, (current) =>
      current.taskId === taskId ? undefined : { ...current, taskId },
    );
  }

  async getRun(runId: string): Promise<ScheduleRunRecord | undefined> {
    return this.runs.get(runId);
  }

  /** Run history, newest first. Every schedule's, or one schedule's. */
  async listRuns(scheduleId?: string): Promise<ScheduleRunRecord[]> {
    const all = [...(await this.runs.list())];
    const scoped = scheduleId === undefined ? all : all.filter((r) => r.scheduleId === scheduleId);
    return scoped.sort((a, b) => b.occurrenceAt - a.occurrenceAt);
  }

  /** Runs still marked running. Reconciled after a worker restart. */
  async listRunningRuns(): Promise<ScheduleRunRecord[]> {
    return (await this.listRuns()).filter((run) => run.status === 'running');
  }
}
