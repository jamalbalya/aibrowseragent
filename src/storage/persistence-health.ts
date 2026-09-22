/**
 * Durable persistence health (D-3).
 *
 * The problem this exists for: a marker in memory does not survive the thing
 * it is supposed to record. MV3 evicts the service worker constantly, so a
 * flag saying "a write failed and records are missing" is gone by the time
 * anyone could act on it — and the state that comes back looks healthy, which
 * is worse than looking broken. A storage failure that erases its own
 * evidence is indistinguishable from no failure at all.
 *
 * So health is written down, and written down in the same storage discipline
 * as everything else it describes.
 *
 * Two properties carry it:
 *
 *  - **Monotone.** Severity only rises. Nothing recovers on its own, and a
 *    later success does not mean the earlier loss did not happen. Only an
 *    explicit acknowledgement from a person lowers it, and that is recorded.
 *  - **Worst of both.** The reported state is the worse of what is persisted
 *    and what this worker has seen since it started. If the marker itself
 *    could not be written, the in-memory floor still holds for this worker's
 *    lifetime, so a total storage failure does not read as healthy *here*
 *    even though it cannot be durably recorded anywhere.
 *
 * The honest limit, stated once: the marker is written to the same storage
 * whose failure it records. Under a total, permanent storage failure it
 * cannot be written either. This raises the floor — it covers quota
 * exhaustion, a rejected write, a corrupt record and a transient fault — and
 * it is not a guarantee. It is not described as one anywhere.
 */
import { getLogger } from '@/logging/logger';
import { update, type StorageArea } from './storage-area';

const log = getLogger('storage');

/**
 * What a domain's persistence is known to be, worst last.
 *
 * The ladder is ordered by how much it should stop, not by how alarming it
 * sounds, because the ordering is what the gate below actually uses.
 */
export const PERSISTENCE_STATES = [
  /** Everything written has been written, and everything read back parsed. */
  'HEALTHY',
  /** A write did not land. What is stored is consistent; something is missing. */
  'DEGRADED',
  /** Something stored did not parse, or failed a check it should have passed. */
  'CORRUPT',
  /** A person has to look before this domain is used again. */
  'RECOVERY_REQUIRED',
  /** Storage itself is unusable: neither reads nor writes are working. */
  'IRRECOVERABLE',
] as const;

export type PersistenceState = (typeof PERSISTENCE_STATES)[number];

/** Severity, for the monotone rule. Higher is worse. */
export function severityOf(state: PersistenceState): number {
  return PERSISTENCE_STATES.indexOf(state);
}

/**
 * The parts of the product whose persistence is tracked separately.
 *
 * Separately because they fail closed in different directions, and collapsing
 * them would force one of the two to be wrong:
 *
 *  - `task-security` holds taint, the salt and the task record. Losing it
 *    means a task's security state is no longer established, so execution
 *    must stop.
 *  - `audit` holds the record of what already happened. Losing it is a gap in
 *    the record of an execution that already ran — it is **not** a failed
 *    execution, and it must not become one. That is P-038's frozen contract,
 *    and it is why this domain does not gate execution.
 *  - `storage` is the substrate. If it is gone, both of the above are too.
 */
export const HEALTH_DOMAINS = ['task-security', 'audit', 'storage'] as const;
export type HealthDomain = (typeof HEALTH_DOMAINS)[number];

/**
 * Domains whose degradation stops work.
 *
 * `audit` is deliberately absent. See the note above: a gap in the record is
 * not a failed execution, and making audit failure stop a task would convert
 * one into the other.
 */
const GATING_DOMAINS: readonly HealthDomain[] = ['task-security', 'storage'];

export interface HealthRecord {
  readonly domain: HealthDomain;
  readonly state: PersistenceState;
  /** A short, fixed phrase. Never a value, a URL, or anything page-derived. */
  readonly reason: string;
  /** When this domain first left `HEALTHY`. */
  readonly since: number;
  /** How many times a report was made at this severity or worse. */
  readonly reports: number;
}

export interface HealthSnapshot {
  readonly records: readonly HealthRecord[];
  /** The worst state across the gating domains. */
  readonly gating: PersistenceState;
  /** True when work must not start or resume. */
  readonly blocked: boolean;
}

const KEY = 'persistence-health';

interface HealthIndex {
  readonly records: readonly HealthRecord[];
}

const healthy = (domain: HealthDomain, now: number): HealthRecord => ({
  domain,
  state: 'HEALTHY',
  reason: 'nothing reported',
  since: now,
  reports: 0,
});

/**
 * Reads and raises persistence health.
 *
 * Every write goes through `update`, so a report is a read-modify-write under
 * the storage mutex rather than a blind `set`: two failures reported at once
 * cannot drop one of them, which is the same reason taint is appended that
 * way.
 */
export class PersistenceHealthStore {
  /**
   * The floor this worker has seen, which no read can go below.
   *
   * This is not a cache. It exists for the case the persisted marker could
   * not be written — a failure severe enough to lose its own record still
   * stops this worker, even though it cannot stop the next one.
   */
  private readonly floor = new Map<HealthDomain, HealthRecord>();

  constructor(
    private readonly area: StorageArea,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Raises a domain's state. Never lowers it.
   *
   * Returns the state in force afterwards. Never throws: this is called from
   * failure paths, and a reporter that threw would replace the failure being
   * reported with a different one.
   */
  async report(domain: HealthDomain, state: PersistenceState, reason: string): Promise<void> {
    const at = this.now();
    // The floor first, so it holds even if the write below does not.
    const previousFloor = this.floor.get(domain);
    if (!previousFloor || severityOf(state) > severityOf(previousFloor.state)) {
      this.floor.set(domain, {
        domain,
        state,
        reason,
        since: previousFloor?.since ?? at,
        reports: (previousFloor?.reports ?? 0) + 1,
      });
    }

    try {
      await update<HealthIndex>(this.area, KEY, { records: [] }, (index) => {
        const existing = index.records.find((record) => record.domain === domain);
        if (existing && severityOf(existing.state) >= severityOf(state)) {
          // Already at least this bad. The count still moves, so a repeated
          // failure is visible as repeated rather than as one event.
          return {
            records: index.records.map((record) =>
              record.domain === domain ? { ...record, reports: record.reports + 1 } : record,
            ),
          };
        }
        const raised: HealthRecord = {
          domain,
          state,
          reason,
          since: existing?.since ?? at,
          reports: (existing?.reports ?? 0) + 1,
        };
        return {
          records: [...index.records.filter((record) => record.domain !== domain), raised],
        };
      });
    } catch (error) {
      // The one place where failing to record a failure is expected: the
      // storage this writes to is the storage that just failed. The floor
      // above already holds for this worker.
      log.error('Persistence health could not be recorded durably.', {
        domain,
        state,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /**
   * The current state of every domain, worst of persisted and floor.
   *
   * A read that throws is itself evidence: if health cannot be read, storage
   * is not working, and the snapshot says so rather than reporting healthy.
   */
  async snapshot(): Promise<HealthSnapshot> {
    const at = this.now();
    let persisted: readonly HealthRecord[] = [];
    let readFailed = false;
    try {
      persisted = (await this.area.get<HealthIndex>(KEY))?.records ?? [];
    } catch (error) {
      readFailed = true;
      log.error('Persistence health could not be read.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }

    const records = HEALTH_DOMAINS.map((domain) => {
      const stored = persisted.find((record) => record.domain === domain);
      const floor = this.floor.get(domain);
      const candidates = [stored, floor].filter((record): record is HealthRecord =>
        Boolean(record && isHealthRecord(record)),
      );
      if (readFailed && domain === 'storage') {
        candidates.push({
          domain,
          state: 'IRRECOVERABLE',
          reason: 'health could not be read',
          since: at,
          reports: 1,
        });
      }
      if (candidates.length === 0) return healthy(domain, at);
      return candidates.reduce((worst, candidate) =>
        severityOf(candidate.state) > severityOf(worst.state) ? candidate : worst,
      );
    });

    const gating = records
      .filter((record) => GATING_DOMAINS.includes(record.domain))
      .reduce<PersistenceState>(
        (worst, record) => (severityOf(record.state) > severityOf(worst) ? record.state : worst),
        'HEALTHY',
      );

    return { records, gating, blocked: severityOf(gating) >= severityOf('DEGRADED') };
  }

  /** True when work must not start or resume. The one question callers ask. */
  async blocksExecution(): Promise<boolean> {
    return (await this.snapshot()).blocked;
  }

  /**
   * Clears a domain, on a person's explicit instruction.
   *
   * The only way down the ladder, and deliberately not automatic: a later
   * successful write does not mean the earlier loss did not happen, so
   * nothing in the failure paths may call this. It exists so someone who has
   * looked at what was lost can say so.
   */
  async acknowledge(domain: HealthDomain): Promise<HealthSnapshot> {
    this.floor.delete(domain);
    try {
      await update<HealthIndex>(this.area, KEY, { records: [] }, (index) => ({
        records: index.records.filter((record) => record.domain !== domain),
      }));
    } catch (error) {
      log.error('Persistence health could not be cleared.', {
        domain,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    return this.snapshot();
  }
}

/**
 * Whether a stored value is a health record this build can act on.
 *
 * A record that does not parse is not treated as healthy and not treated as
 * absent — it is dropped here and the domain falls back to whatever else says
 * something about it. The caller that stored it is what raises `CORRUPT`;
 * inventing a state from a malformed record would be reading meaning into
 * bytes that have none.
 */
function isHealthRecord(value: unknown): value is HealthRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (HEALTH_DOMAINS as readonly string[]).includes(String(record['domain'])) &&
    (PERSISTENCE_STATES as readonly string[]).includes(String(record['state'])) &&
    typeof record['reason'] === 'string' &&
    typeof record['since'] === 'number'
  );
}

/** What to tell someone whose work is blocked. Never a raw storage error. */
export function describeBlock(snapshot: HealthSnapshot): string {
  const worst = snapshot.records
    .filter((record) => GATING_DOMAINS.includes(record.domain))
    .reduce((a, b) => (severityOf(b.state) > severityOf(a.state) ? b : a));
  switch (worst.state) {
    case 'HEALTHY':
      return 'Storage is working normally.';
    case 'DEGRADED':
      return (
        'Some of this extension’s stored state could not be written, so a task’s security ' +
        'state is no longer established. Starting or resuming work is blocked until you ' +
        'acknowledge this in Settings.'
      );
    case 'CORRUPT':
      return (
        'Some of this extension’s stored state could not be read back as written. Starting ' +
        'or resuming work is blocked until you acknowledge this in Settings.'
      );
    case 'RECOVERY_REQUIRED':
      return 'Stored state needs to be reviewed before work can continue.';
    case 'IRRECOVERABLE':
      return 'This extension’s storage is not usable, so nothing can be started safely.';
  }
}
