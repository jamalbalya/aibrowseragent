/**
 * What a schedule is (P-020).
 *
 * A schedule is a **clock attached to something that already exists**. It
 * holds a reference — a shortcut, a stored workflow or a bundled skill — a
 * cadence, and the bookkeeping needed to fire it once per occurrence. It
 * holds nothing else, and in particular it holds no inputs, no arguments, no
 * page content, no model output and no credential of any kind. There is
 * nowhere in this type to put one, and `assertScheduleSafe` refuses a record
 * that grew one anyway.
 *
 * That shape is the whole of the security story, and it is worth stating
 * plainly because the obvious implementation of "run this every morning" is a
 * little job record that carries a payload. This one cannot: firing a
 * schedule resolves a reference and hands it to the route that already
 * existed for that kind of target, so a schedule adds a *time*, never a
 * capability.
 *
 * ## Unattended execution is not a grant
 *
 * Nothing in this module authorises anything. A scheduled run is evaluated by
 * the same policy engine, under the same permission mode, against the same
 * risk model as a run a person started by hand. The single difference is that
 * nobody is there to answer a confirmation prompt — and the product decision
 * (see `docs/architecture/SCHEDULED_EXECUTION.md`) is that such a run stops at
 * that boundary rather than crossing it. There is no stored approval here, no
 * "always allow", and no field that could become one.
 */

/** Bumped when the stored shape changes in a way an older reader cannot parse. */
export const SCHEDULE_FORMAT_VERSION = 1;
export const SCHEDULE_RUN_FORMAT_VERSION = 1;

/**
 * What a schedule points at.
 *
 * A discriminated reference, never a definition. A `shortcut` target is
 * resolved through the shortcut store at every firing, so retargeting or
 * deleting the shortcut changes or stops the schedule without the schedule
 * being touched — which is the behaviour a user who renamed their shortcut
 * expects, and the behaviour that stops a stale copy running on.
 */
export type ScheduleTarget =
  | { readonly kind: 'shortcut'; readonly shortcutId: string }
  | { readonly kind: 'workflow'; readonly workflowId: string }
  | { readonly kind: 'skill'; readonly skillId: string; readonly skillVersion: string };

export const SCHEDULE_TARGET_KINDS: readonly ScheduleTarget['kind'][] = [
  'shortcut',
  'workflow',
  'skill',
];

/**
 * How often a schedule fires.
 *
 * Wall-clock local time, deliberately. "Every morning at 8" means 8 in the
 * morning where the user is, and an offset stored at creation would drift by
 * an hour twice a year — the one thing a person would notice immediately.
 * What that costs is documented on `nextOccurrence`.
 */
export type ScheduleCadence =
  | { readonly kind: 'daily'; readonly hour: number; readonly minute: number }
  | {
      readonly kind: 'weekly';
      /** 0 = Sunday, matching `Date.prototype.getDay`. */
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: 'monthly';
      /** 1-31. A month without that day has no occurrence; see `nextOccurrence`. */
      readonly day: number;
      readonly hour: number;
      readonly minute: number;
    }
  | {
      readonly kind: 'annual';
      /** 1-12, as a person writes it, not as `Date` indexes it. */
      readonly month: number;
      readonly day: number;
      readonly hour: number;
      readonly minute: number;
    };

export const CADENCE_KINDS: readonly ScheduleCadence['kind'][] = [
  'daily',
  'weekly',
  'monthly',
  'annual',
];

/**
 * How a scheduled run ended.
 *
 * `blocked` is the state this phase exists to produce: the run reached an
 * action that requires a person to confirm it, nobody was there, and it
 * stopped. It is a terminal outcome, not a retry state.
 *
 * `missed` is recorded for an occurrence that passed while nothing was
 * running. It is never executed late; see `docs/architecture/SCHEDULED_EXECUTION.md`.
 */
export const SCHEDULE_RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'missed',
] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

/**
 * Why a run ended the way it did.
 *
 * A closed vocabulary written by this extension from its own words. It is
 * never a message from a page, a model or a tool: a run record is shown in
 * the panel and copied into the audit trail, and neither is a place for text
 * whose provenance is a web page.
 */
export const SCHEDULE_RUN_REASONS = [
  /** The run reached an action that needs a person to confirm it. */
  'CONFIRMATION_REQUIRED',
  /** Policy refused outright — a prohibition, R5, a blocked site, exfiltration. */
  'POLICY_DENIED',
  /** The shortcut, workflow or skill this schedule names is gone. */
  'TARGET_MISSING',
  /** The target exists but cannot run: incomplete recording, failed integrity. */
  'TARGET_UNUSABLE',
  /** The target asks for values at run time, and nobody is there to supply them. */
  'INPUTS_REQUIRED',
  /** Storage is not in a state that can carry a run's security state. */
  'PERSISTENCE_BLOCKED',
  /** The occurrence passed while the browser or the worker was not running. */
  'MISSED_WHILE_ASLEEP',
  /** The run itself failed. */
  'RUN_FAILED',
  /** Stopped by the user. */
  'CANCELLED',
  /** The worker was evicted while the run was in flight. Never resumed. */
  'INTERRUPTED',
  /** Something threw where nothing should have. */
  'INTERNAL_ERROR',
] as const;
export type ScheduleRunReason = (typeof SCHEDULE_RUN_REASONS)[number];

/**
 * A schedule as it is stored.
 *
 * `lastClaimedOccurrenceAt` is the idempotency guard and the reason a
 * duplicated wake-up cannot run anything twice. Occurrences are claimed
 * strictly monotonically: a claim for an instant at or before this one is
 * refused, whoever is asking and however many times the alarm fires. It is a
 * single number rather than a set because the set would grow without bound
 * and would answer a question nobody asks — occurrences are ordered, so
 * "have I already passed this one" is all that is needed.
 */
export interface ScheduleRecord {
  readonly scheduleId: string;
  readonly formatVersion: number;
  /** What the user typed, shown back to them verbatim. */
  readonly displayName: string;
  readonly target: ScheduleTarget;
  readonly cadence: ScheduleCadence;
  /** False means paused. A paused schedule computes occurrences and runs none. */
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The next occurrence this schedule will consider. Always in the future of the last claim. */
  readonly nextRunAt: number;
  /** The highest occurrence ever claimed. Monotonic; never decreases. */
  readonly lastClaimedOccurrenceAt: number;
  readonly lastRunAt?: number;
  readonly lastRunStatus?: ScheduleRunStatus;
  readonly lastRunReason?: ScheduleRunReason;
}

/**
 * One firing, recorded.
 *
 * Deliberately not a copy of the task: it names one by id and stops there.
 * Run history is a list of *when a schedule fired and how that ended*, and a
 * second copy of the task's steps here would be page-derived content in a
 * record whose whole point is that it holds none.
 */
export interface ScheduleRunRecord {
  /** Deterministic: the same occurrence always produces the same id. */
  readonly runId: string;
  readonly formatVersion: number;
  readonly scheduleId: string;
  /** The scheduled instant, never the instant the alarm happened to fire. */
  readonly occurrenceAt: number;
  readonly startedAt: number;
  readonly status: ScheduleRunStatus;
  readonly finishedAt?: number;
  readonly reason?: ScheduleRunReason;
  /** The task the run created, once there is one. */
  readonly taskId?: string;
}

/**
 * The execution identity of one occurrence.
 *
 * Derived from the schedule and the scheduled instant, so it is the same
 * value on every wake-up, in every worker generation, after every eviction.
 * That is what makes "has this already run" answerable without a lock.
 */
export function runIdFor(scheduleId: string, occurrenceAt: number): string {
  return `srun_${scheduleId}_${occurrenceAt}`;
}

/**
 * The session a scheduled run executes under.
 *
 * A prefix `newSessionId()` cannot produce, and it is load-bearing: the
 * unattended boundary is decided by reading the *task record*, which is
 * durable, rather than by consulting worker memory, which is not. A run that
 * outlives an eviction is therefore still unattended when it wakes, and a
 * scheduled task can never be mistaken for one a person is watching.
 */
export const UNATTENDED_SESSION_PREFIX = 'unattended_';

export function unattendedSessionIdFor(runId: string): string {
  return `${UNATTENDED_SESSION_PREFIX}${runId}`;
}

/** Is this task running with nobody watching? Read from the record, not from memory. */
export function isUnattendedSessionId(sessionId: string): boolean {
  return sessionId.startsWith(UNATTENDED_SESSION_PREFIX);
}

/**
 * Field names a stored schedule may never carry, at any depth.
 *
 * The same recursive assertion a shortcut gets, for the same reason and with
 * one addition that matters more here: a schedule fires without a person
 * present, so a payload smuggled into one would be a payload nobody reviews
 * before it runs.
 */
const PROHIBITED_FIELDS: ReadonlySet<string> = new Set(
  [
    // A definition, rather than a reference to one.
    'steps',
    'step',
    'definition',
    'arguments',
    'args',
    'inputs',
    'input',
    'tool',
    'tools',
    'binding',
    'bindings',
    // Anything executable, or anything that would be interpreted.
    'code',
    'script',
    'expression',
    'selector',
    'selectors',
    'xpath',
    'template',
    'prompt',
    'instructions',
    'command',
    'objective',
    // Data that has no business in a scheduling layer.
    'result',
    'results',
    'outputs',
    'output',
    'payload',
    'content',
    'pagecontent',
    'body',
    'html',
    'text',
    'screenshot',
    'evidence',
    'response',
    'completion',
    // Credentials, in every spelling this project uses.
    'password',
    'passphrase',
    'secret',
    'token',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'key',
    'credential',
    'credentials',
    'cookie',
    'cookies',
    'authorization',
    'auth',
    'bearer',
  ].map((name) => name.toLowerCase()),
);

const MAX_SCHEDULE_DEPTH = 6;

export class ProhibitedScheduleFieldError extends Error {
  constructor(readonly field: string) {
    super(
      `A schedule may not carry "${field}". A schedule is a clock pointing at something that ` +
        'already exists; it never holds the inputs, content or credentials of what it runs.',
    );
    this.name = 'ProhibitedScheduleFieldError';
  }
}

/** Rejects a schedule that grew a field it should not have. */
export function assertScheduleSafe(value: Record<string, unknown>): void {
  walk(value, [], 0);
}

function walk(value: unknown, path: readonly string[], depth: number): void {
  if (depth > MAX_SCHEDULE_DEPTH) {
    throw new ProhibitedScheduleFieldError(path.join('.') || '(root)');
  }
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walk(item, [...path, String(index)], depth + 1);
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new ProhibitedScheduleFieldError([...path, key].join('.'));
    }
    walk(nested, [...path, key], depth + 1);
  }
}

function isWholeNumber(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether a cadence is one this build can compute occurrences for. */
export function isUsableCadence(value: unknown): value is ScheduleCadence {
  if (value === null || typeof value !== 'object') return false;
  const cadence = value as { kind?: unknown; [key: string]: unknown };
  if (!isWholeNumber(cadence.hour, 0, 23)) return false;
  if (!isWholeNumber(cadence.minute, 0, 59)) return false;
  switch (cadence.kind) {
    case 'daily':
      return true;
    case 'weekly':
      return isWholeNumber(cadence.weekday, 0, 6);
    case 'monthly':
      return isWholeNumber(cadence.day, 1, 31);
    case 'annual':
      return (
        isWholeNumber(cadence.month, 1, 12) &&
        isWholeNumber(cadence.day, 1, 31) &&
        daysInMonth(2024, cadence.month as number) >= (cadence.day as number)
      );
    default:
      return false;
  }
}

/** Whether a target names something in a form a resolver could look up. */
export function isUsableTarget(value: unknown): value is ScheduleTarget {
  if (value === null || typeof value !== 'object') return false;
  const target = value as Partial<ScheduleTarget> & { kind?: unknown };
  switch (target.kind) {
    case 'shortcut':
      return (
        typeof (target as { shortcutId?: unknown }).shortcutId === 'string' &&
        (target as { shortcutId: string }).shortcutId.length > 0
      );
    case 'workflow':
      return (
        typeof (target as { workflowId?: unknown }).workflowId === 'string' &&
        (target as { workflowId: string }).workflowId.length > 0
      );
    case 'skill': {
      const skill = target as { skillId?: unknown; skillVersion?: unknown };
      return (
        typeof skill.skillId === 'string' &&
        skill.skillId.length > 0 &&
        typeof skill.skillVersion === 'string' &&
        /^\d+\.\d+\.\d+$/.test(skill.skillVersion)
      );
    }
    default:
      return false;
  }
}

/**
 * Whether a stored record still has the shape this build can use.
 *
 * Called on the way out of storage as well as in. A schedule fires without a
 * person present, so a record that was edited underneath the store — by a
 * partial write, or by something writing extension storage directly — must
 * resolve to nothing rather than to a best guess.
 */
export function isUsableSchedule(value: unknown): value is ScheduleRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<ScheduleRecord>;
  if (record.formatVersion !== SCHEDULE_FORMAT_VERSION) return false;
  if (typeof record.scheduleId !== 'string' || record.scheduleId.length === 0) return false;
  if (typeof record.displayName !== 'string' || record.displayName.length === 0) return false;
  if (typeof record.enabled !== 'boolean') return false;
  if (!Number.isFinite(record.createdAt)) return false;
  if (!Number.isFinite(record.updatedAt)) return false;
  if (!Number.isFinite(record.nextRunAt)) return false;
  if (!Number.isFinite(record.lastClaimedOccurrenceAt)) return false;
  if (!isUsableCadence(record.cadence)) return false;
  if (!isUsableTarget(record.target)) return false;
  if (
    record.lastRunStatus !== undefined &&
    !(SCHEDULE_RUN_STATUSES as readonly string[]).includes(record.lastRunStatus)
  ) {
    return false;
  }
  if (
    record.lastRunReason !== undefined &&
    !(SCHEDULE_RUN_REASONS as readonly string[]).includes(record.lastRunReason)
  ) {
    return false;
  }
  return true;
}

export function isUsableScheduleRun(value: unknown): value is ScheduleRunRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<ScheduleRunRecord>;
  if (record.formatVersion !== SCHEDULE_RUN_FORMAT_VERSION) return false;
  if (typeof record.runId !== 'string' || record.runId.length === 0) return false;
  if (typeof record.scheduleId !== 'string' || record.scheduleId.length === 0) return false;
  if (!Number.isFinite(record.occurrenceAt)) return false;
  if (!Number.isFinite(record.startedAt)) return false;
  if (!(SCHEDULE_RUN_STATUSES as readonly string[]).includes(String(record.status))) return false;
  if (
    record.reason !== undefined &&
    !(SCHEDULE_RUN_REASONS as readonly string[]).includes(record.reason)
  ) {
    return false;
  }
  if (record.taskId !== undefined && typeof record.taskId !== 'string') return false;
  return true;
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month, 0).getDate();
}

/**
 * How far the search for the next occurrence may walk before giving up.
 *
 * Every cadence reaches its next occurrence well inside this: daily in one
 * step, weekly in seven, monthly-on-the-31st in at most three months, and
 * annual-on-29-February in at most eight years. The cap exists so that a
 * cadence this build does not understand cannot spin.
 */
const MAX_SEARCH_STEPS = 400;

/**
 * The first occurrence strictly after `after`.
 *
 * Computed on the local wall clock, by incrementing calendar fields rather
 * than by adding milliseconds. That is what makes "08:00 every day" stay at
 * 08:00 across a daylight-saving change instead of drifting to 07:00 or
 * 09:00 for half the year.
 *
 * Two edges are decided here rather than left to chance, and both are
 * deterministic:
 *
 *  - **A day that does not exist in a month is skipped, never clamped.** "The
 *    31st" in February means there is no occurrence in February, not one on
 *    the 28th. Clamping would fire a monthly schedule on a date the user
 *    never chose, and it would fire *twice* in a March that follows a clamped
 *    February in some readings. The same rule gives 29 February a run in leap
 *    years only.
 *  - **A wall-clock time that does not exist is normalised forward.** On the
 *    morning a clock jumps from 01:59 to 03:00, a schedule set for 02:30 runs
 *    at 03:30, because that is the instant `Date` resolves it to. When a clock
 *    goes back and 01:30 happens twice, the earlier instant is the occurrence
 *    and the later one is not, so the schedule runs once — the monotonic
 *    occurrence claim in `ScheduleStore` guarantees that even if both instants
 *    are examined.
 *
 * Returns `undefined` only if the cadence is not one this build understands,
 * which `isUsableCadence` has already refused everywhere a record is read.
 */
export function nextOccurrence(cadence: ScheduleCadence, after: number): number | undefined {
  if (!Number.isFinite(after)) return undefined;
  const from = new Date(after);

  switch (cadence.kind) {
    case 'daily': {
      const candidate = new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate(),
        cadence.hour,
        cadence.minute,
        0,
        0,
      );
      if (candidate.getTime() > after) return candidate.getTime();
      return new Date(
        from.getFullYear(),
        from.getMonth(),
        from.getDate() + 1,
        cadence.hour,
        cadence.minute,
        0,
        0,
      ).getTime();
    }

    case 'weekly': {
      for (let step = 0; step <= 7; step += 1) {
        const candidate = new Date(
          from.getFullYear(),
          from.getMonth(),
          from.getDate() + step,
          cadence.hour,
          cadence.minute,
          0,
          0,
        );
        if (candidate.getDay() === cadence.weekday && candidate.getTime() > after) {
          return candidate.getTime();
        }
      }
      return undefined;
    }

    case 'monthly': {
      for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
        const month = from.getMonth() + step;
        const year = from.getFullYear() + Math.floor(month / 12);
        const normalised = ((month % 12) + 12) % 12;
        // Skipped, never clamped: a month without the 31st has no occurrence.
        if (daysInMonth(year, normalised + 1) < cadence.day) continue;
        const candidate = new Date(
          year,
          normalised,
          cadence.day,
          cadence.hour,
          cadence.minute,
          0,
          0,
        );
        if (candidate.getTime() > after) return candidate.getTime();
      }
      return undefined;
    }

    case 'annual': {
      for (let step = 0; step < MAX_SEARCH_STEPS; step += 1) {
        const year = from.getFullYear() + step;
        // 29 February exists in leap years only, and is skipped in the rest.
        if (daysInMonth(year, cadence.month) < cadence.day) continue;
        const candidate = new Date(
          year,
          cadence.month - 1,
          cadence.day,
          cadence.hour,
          cadence.minute,
          0,
          0,
        );
        if (candidate.getTime() > after) return candidate.getTime();
      }
      return undefined;
    }
  }
}

/** A cadence in the extension's own words. Never shown a value from a page. */
export function describeCadence(cadence: ScheduleCadence): string {
  const at = `${String(cadence.hour).padStart(2, '0')}:${String(cadence.minute).padStart(2, '0')}`;
  switch (cadence.kind) {
    case 'daily':
      return `Every day at ${at}`;
    case 'weekly':
      return `Every ${WEEKDAY_NAMES[cadence.weekday] ?? 'week'} at ${at}`;
    case 'monthly':
      return `On day ${cadence.day} of each month at ${at}`;
    case 'annual':
      return `Every ${MONTH_NAMES[cadence.month - 1] ?? 'year'} ${cadence.day} at ${at}`;
  }
}

const WEEKDAY_NAMES: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
