/**
 * Deciding what is due, and what was merely missed.
 *
 * Pure arithmetic over a schedule and a clock. It reads no storage, runs
 * nothing, and has no opinion about whether an action is safe — that is the
 * policy engine's job and this module never duplicates it. It answers one
 * question: given that we have just woken up, which occurrences of this
 * schedule have gone past, and which single one (if any) is still worth
 * running now.
 *
 * ## Why a grace window exists at all
 *
 * A Chrome extension's service worker is evicted whenever Chrome likes, and
 * `chrome.alarms` wakes it again — but not to the second, and not at all
 * while the browser is closed. So "it is 08:00" and "the alarm for 08:00 has
 * been delivered" are different events that can be minutes apart, and a
 * scheduler that insisted on the first would never run anything.
 *
 * The window is therefore the definition of *late but still wanted*. Inside
 * it, an occurrence runs. Outside it, the occurrence is **missed** — recorded,
 * never replayed. Replaying it would mean an agent taking actions on the web
 * hours after the moment the user chose, with nobody present to see it start;
 * the whole point of a scheduled run is that it happens when it was supposed
 * to.
 */
import { nextOccurrence, type ScheduleRecord } from './schedule-model';

/**
 * How late an occurrence may be and still run.
 *
 * Ten minutes. Long enough to cover Chrome's own alarm slack and a worker
 * that took its time waking, short enough that nothing runs at a time the
 * user would not recognise as the one they picked.
 */
export const RUN_GRACE_MS = 10 * 60 * 1000;

/**
 * How many past occurrences are enumerated before the walk gives up.
 *
 * A daily schedule left alone for a year has 365 of them, and enumerating
 * every one to mark it missed is pointless work and a pointless flood of
 * records. Beyond the cap, the walk stops and the schedule is re-anchored to
 * the next future occurrence, with one missed record standing for the gap.
 */
export const MAX_ENUMERATED_OCCURRENCES = 32;

export interface DueVerdict {
  /**
   * Occurrences that went past and will not be run.
   *
   * Oldest first. Each one is recorded as missed and claimed, so it can never
   * be picked up by a later wake-up.
   */
  readonly missed: readonly number[];
  /**
   * The one occurrence to run now, if there is one.
   *
   * At most one, ever. Two occurrences due at the same wake-up means the
   * earlier one is late, and late means missed.
   */
  readonly due?: number;
  /** Where the schedule's clock should be left. */
  readonly nextRunAt: number;
  /**
   * True when the walk hit the cap and the missed list is a sample rather
   * than the complete set. Recorded so a reader can tell a quiet period from
   * a truncated one.
   */
  readonly truncated: boolean;
}

/**
 * What this wake-up should do about one schedule.
 *
 * A paused schedule produces nothing at all: no due run and no missed
 * records. A schedule that was not expected to fire cannot have missed
 * anything, and filling a person's history with records for a schedule they
 * deliberately switched off would be noise dressed as diligence.
 */
export function occurrencesDue(schedule: ScheduleRecord, now: number): DueVerdict {
  if (!schedule.enabled) {
    return { missed: [], nextRunAt: schedule.nextRunAt, truncated: false };
  }

  // Never look at an instant the schedule has already claimed. This is the
  // second half of the idempotency guarantee: the store refuses a repeated
  // claim, and the clock does not propose one.
  const floor = Math.max(schedule.lastClaimedOccurrenceAt, 0);
  let cursor =
    schedule.nextRunAt > floor ? schedule.nextRunAt : nextOccurrence(schedule.cadence, floor);
  if (cursor === undefined) {
    return { missed: [], nextRunAt: schedule.nextRunAt, truncated: false };
  }

  const past: number[] = [];
  let truncated = false;
  while (cursor !== undefined && cursor <= now) {
    if (past.length >= MAX_ENUMERATED_OCCURRENCES) {
      truncated = true;
      break;
    }
    past.push(cursor);
    cursor = nextOccurrence(schedule.cadence, cursor);
  }

  if (truncated) {
    // Re-anchor rather than walk a year of history. The most recent
    // occurrence is the one that matters, and it is still evaluated against
    // the grace window below like any other.
    const recent = lastOccurrenceAtOrBefore(schedule, now);
    const keep = past.slice(0, MAX_ENUMERATED_OCCURRENCES - 1);
    if (recent !== undefined && !keep.includes(recent)) keep.push(recent);
    past.length = 0;
    past.push(...keep.sort((a, b) => a - b));
    cursor = nextOccurrence(schedule.cadence, past[past.length - 1] ?? now);
  }

  const nextRunAt = cursor ?? schedule.nextRunAt;
  if (past.length === 0) {
    return { missed: [], nextRunAt, truncated };
  }

  const latest = past[past.length - 1] as number;
  const runnable = now - latest <= RUN_GRACE_MS;
  const missed = runnable ? past.slice(0, -1) : past;

  return {
    missed,
    ...(runnable ? { due: latest } : {}),
    nextRunAt,
    truncated,
  };
}

/**
 * The last occurrence at or before `now`, found by stepping forward from a
 * point known to be behind it.
 *
 * Used only on the truncated path, where walking every occurrence would be
 * wasteful. It steps in the cadence's own units, so it inherits the same
 * skip-not-clamp and daylight-saving behaviour `nextOccurrence` documents.
 */
function lastOccurrenceAtOrBefore(schedule: ScheduleRecord, now: number): number | undefined {
  // Start a little before now and walk forward; the step is generous enough
  // that one iteration lands for every cadence this build supports.
  const window =
    schedule.cadence.kind === 'daily'
      ? 2 * 24 * 60 * 60 * 1000
      : schedule.cadence.kind === 'weekly'
        ? 8 * 24 * 60 * 60 * 1000
        : schedule.cadence.kind === 'monthly'
          ? 32 * 24 * 60 * 60 * 1000
          : 367 * 24 * 60 * 60 * 1000;

  let candidate = nextOccurrence(schedule.cadence, now - window);
  let found: number | undefined;
  let steps = 0;
  while (candidate !== undefined && candidate <= now && steps < 64) {
    found = candidate;
    candidate = nextOccurrence(schedule.cadence, candidate);
    steps += 1;
  }
  return found;
}

/**
 * When the next alarm should be set for, across every schedule.
 *
 * One alarm, not one per schedule. Chrome caps how many alarms an extension
 * may hold and delivers them independently, and a single "wake me at the next
 * interesting moment" alarm is both inside every quota and simpler to reason
 * about: every wake-up reconciles every schedule, so a missed alarm costs at
 * most a delay rather than a lost schedule.
 *
 * Returns `undefined` when nothing is scheduled, which is how the alarm gets
 * cleared rather than left ticking over an empty list.
 */
export function nextWakeUp(schedules: readonly ScheduleRecord[]): number | undefined {
  let earliest: number | undefined;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    if (!Number.isFinite(schedule.nextRunAt)) continue;
    if (earliest === undefined || schedule.nextRunAt < earliest) earliest = schedule.nextRunAt;
  }
  return earliest;
}
