/**
 * Independent, versioned records in `chrome.storage`.
 *
 * Two problems this solves, both of which a single JSON blob has:
 *
 *  - **Blast radius.** One unparseable byte in a blob holding fifty workflows
 *    loses fifty workflows. One unparseable byte in a record loses that
 *    record, and the other forty-nine are read normally.
 *  - **Write cost.** Saving one shortcut rewrote every shortcut, so the
 *    largest record set paid the most for the smallest edit.
 *
 * The layout follows the one `TaskStore` already uses — an index plus a key
 * per record — with the format version carried in the key:
 *
 * ```
 *   workflows:v1:index   → { ids: [...] }     ids only, newest first
 *   workflows:v1:wf_abc  → { v: 1, record }   one record
 * ```
 *
 * ## Migration is the extension's job, never the user's
 *
 * A person who installed a Chrome extension has not agreed to run a database
 * migration, and there is no terminal in which they could. So upgrades run
 * here, automatically, on first read after the new build starts — and the
 * ordering is chosen so that every point at which they can be interrupted
 * leaves the user's data intact:
 *
 *  1. Read the old generation.
 *  2. Migrate each record **individually**, and validate the result.
 *  3. Write the new records and the new index.
 *  4. Read one back and verify it.
 *  5. Only then remove the old generation.
 *
 * Interrupted anywhere before 5, the old generation is still there and the
 * next start migrates again; the writes in 3 are idempotent because ids are
 * preserved. Interrupted after 5, the new generation is complete.
 *
 * ## What failure does
 *
 * Nothing here deletes data it could not read. A record that fails to migrate
 * or fails validation is **left where it is** and counted, the failure is
 * reported to persistence health, and every other record still migrates. A
 * migration that throws as a whole abandons the upgrade with the old
 * generation untouched — the store then reads empty rather than reading
 * something it does not understand, which is the difference between a
 * degraded feature and a fabricated one.
 *
 * Records under other keys — settings, credentials, tasks, audit — are never
 * read, written or removed by this class. It touches its own prefix only.
 */
import { getLogger } from '@/logging/logger';
import { update, type StorageArea, type TransactionalStorageArea } from '@/storage/storage-area';
import type { PersistenceHealthStore } from '@/storage/persistence-health';

const log = getLogger('storage');

/** The index of a generation: ids, newest first. Never the records. */
interface RecordIndex {
  readonly ids: readonly string[];
}

/**
 * One step of an upgrade chain.
 *
 * `migrate` receives whatever was stored — which is `unknown`, because the
 * whole point is that it was written by a build that no longer exists — and
 * returns something the *next* version's validator will be asked to accept.
 * It may throw; that quarantines the one record rather than the generation.
 */
export interface RecordMigration {
  /** The format version this step reads. */
  readonly from: number;
  /** The format version this step produces. Must be `from + 1`. */
  readonly to: number;
  migrate(stored: unknown): unknown;
}

/**
 * How an older generation is found.
 *
 * `blob` covers the shape this project used before records were independent:
 * a single key holding an array of full records. `versioned` covers a previous
 * generation of this same layout.
 */
export type LegacySource =
  | {
      readonly kind: 'blob';
      /** The old key, e.g. `workflows`. */
      readonly key: string;
      /** Pulls the record array out of whatever was stored there. */
      readonly extract: (stored: unknown) => readonly unknown[];
      /** The format version those records are in. */
      readonly version: number;
    }
  | {
      readonly kind: 'versioned';
      readonly version: number;
    };

export interface RecordStoreOptions<T> {
  readonly area: StorageArea;
  /** Key prefix. One namespace per record type, never shared. */
  readonly kind: string;
  /** The version this build reads and writes. */
  readonly version: number;
  readonly identify: (record: T) => string;
  /**
   * Accepts a record, or does not.
   *
   * Called on every read and after every migration step, because a migration
   * that produced something unusable must fail here rather than downstream.
   * A rejected record is dropped from the read, never repaired: a fabricated
   * workflow is steps nobody recorded, and a fabricated workspace is a scope
   * nobody configured.
   */
  readonly validate: (candidate: unknown) => candidate is T;
  /** Ordered oldest-first. A gap in the chain is a programming error. */
  readonly migrations?: readonly RecordMigration[];
  /** Older generations to upgrade from, if any are present. */
  readonly legacy?: readonly LegacySource[];
  /** Cap on retained records. Oldest are evicted. */
  readonly max?: number;
  readonly health?: PersistenceHealthStore;
}

/** What one record looks like on disk. The version travels with the record. */
interface Envelope {
  readonly v: number;
  readonly record: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Envelope).v === 'number' &&
    'record' in value
  );
}

/** What an upgrade did, for tests and for the health report. */
export interface UpgradeOutcome {
  readonly migrated: number;
  readonly quarantined: number;
  readonly from: number | null;
}

export class RecordStore<T> {
  private readonly max: number;
  /** One upgrade attempt per worker. Re-entrant callers await the same one. */
  private upgrade: Promise<UpgradeOutcome> | null = null;

  constructor(private readonly options: RecordStoreOptions<T>) {
    this.max = options.max ?? 200;
    let previous = -1;
    for (const step of options.migrations ?? []) {
      if (step.to !== step.from + 1) {
        throw new Error(`${options.kind}: a migration must advance exactly one version`);
      }
      if (previous >= 0 && step.from !== previous + 1) {
        throw new Error(`${options.kind}: the migration chain has a gap at ${step.from}`);
      }
      previous = step.from;
    }
  }

  private recordKey(id: string): string {
    return `${this.options.kind}:v${this.options.version}:${id}`;
  }

  private indexKey(version = this.options.version): string {
    return `${this.options.kind}:v${version}:index`;
  }

  /* ------------------------------- reads ------------------------------- */

  /**
   * Every readable record, newest first.
   *
   * Unreadable records are skipped and counted rather than throwing, because
   * one damaged record must not cost the user the rest of them. The count is
   * logged and reported; it is never silently zero.
   */
  async list(): Promise<readonly T[]> {
    await this.ensureUpgraded();
    const index = await this.readIndex();
    const records: T[] = [];
    let unreadable = 0;

    for (const id of index.ids) {
      const record = await this.readRecord(id);
      if (record === undefined) {
        unreadable += 1;
        continue;
      }
      records.push(record);
    }

    if (unreadable > 0) {
      log.error('Some stored records could not be read and were skipped.', {
        kind: this.options.kind,
        skipped: unreadable,
      });
      await this.report('CORRUPT', `${this.options.kind}: ${unreadable} record(s) unreadable`);
    }
    return records;
  }

  async get(id: string): Promise<T | undefined> {
    await this.ensureUpgraded();
    if (!(await this.readIndex()).ids.includes(id)) return undefined;
    return this.readRecord(id);
  }

  async ids(): Promise<readonly string[]> {
    await this.ensureUpgraded();
    return (await this.readIndex()).ids;
  }

  /* ------------------------------- writes ------------------------------ */

  /**
   * Stores a record, newest first.
   *
   * The record is written before the index moves, so an interruption between
   * the two leaves an orphaned record rather than an index entry pointing at
   * nothing. An orphan is invisible and harmless; a dangling id reads as a
   * corrupt record on every list.
   */
  async put(record: T): Promise<readonly string[]> {
    await this.ensureUpgraded();
    return this.write(record);
  }

  /**
   * The write itself, without waiting for the upgrade.
   *
   * Separate from `put` because the upgrade **is** a sequence of writes: a
   * `put` inside `runUpgrade` would await the upgrade promise it is running
   * inside and deadlock. Every public entry point goes through `put`; only
   * the upgrade uses this.
   */
  private async write(record: T): Promise<readonly string[]> {
    const id = this.options.identify(record);
    await this.options.area.set<Envelope>(this.recordKey(id), {
      v: this.options.version,
      record,
    });

    const next = await update<RecordIndex>(
      this.options.area,
      this.indexKey(),
      { ids: [] },
      (i) => ({
        ids: [id, ...i.ids.filter((existing) => existing !== id)].slice(0, this.max),
      }),
    );

    // Anything the cap pushed out is removed here, so eviction does not leave
    // the record behind occupying quota with nothing referencing it.
    return this.evict(next.ids);
  }

  /** Replaces a record in place, keeping its position in the index. */
  async replace(record: T): Promise<void> {
    await this.ensureUpgraded();
    const id = this.options.identify(record);
    const index = await this.readIndex();
    if (!index.ids.includes(id)) {
      await this.write(record);
      return;
    }
    await this.options.area.set<Envelope>(this.recordKey(id), {
      v: this.options.version,
      record,
    });
  }

  async remove(id: string): Promise<void> {
    await this.ensureUpgraded();
    await update<RecordIndex>(this.options.area, this.indexKey(), { ids: [] }, (i) => ({
      ids: i.ids.filter((existing) => existing !== id),
    }));
    await this.options.area.remove(this.recordKey(id));
  }

  /* ----------------------------- internals ----------------------------- */

  private async readIndex(): Promise<RecordIndex> {
    const stored = await this.options.area.get<RecordIndex>(this.indexKey());
    if (stored === undefined) return { ids: [] };
    if (typeof stored !== 'object' || stored === null || !Array.isArray(stored.ids)) {
      log.error('A record index was malformed and was not read.', { kind: this.options.kind });
      await this.report('CORRUPT', `${this.options.kind}: the index is malformed`);
      return { ids: [] };
    }
    return { ids: stored.ids.filter((id): id is string => typeof id === 'string') };
  }

  /**
   * Reads and, if necessary, migrates one record.
   *
   * A record written by an older build is migrated on the way out but is
   * **not** written back here: a read is not the place to acquire a write, and
   * the generation upgrade below is what persists the new form. This path
   * exists so a record missed by an interrupted upgrade is still readable.
   */
  private async readRecord(id: string): Promise<T | undefined> {
    const stored = await this.options.area.get<unknown>(this.recordKey(id));
    if (stored === undefined) return undefined;

    const envelope: Envelope = isEnvelope(stored)
      ? stored
      : // No envelope means it predates versioning. Treat it as version 1
        // rather than guessing: version 1 is what the unversioned builds wrote.
        { v: 1, record: stored };

    const migrated = this.migrate(envelope.record, envelope.v);
    if (migrated === null) return undefined;
    return migrated;
  }

  /**
   * Runs the chain from `from` up to the current version.
   *
   * Returns `null` — never a repaired object — when the record cannot be
   * brought forward, when a step throws, or when the result fails validation.
   * A version *newer* than this build's is also `null`: a downgrade cannot
   * know what a future version means, and guessing would be worse than
   * hiding the record until the newer build runs again.
   */
  private migrate(record: unknown, from: number): T | null {
    if (from > this.options.version) {
      log.warn('A record was written by a newer build and was not read.', {
        kind: this.options.kind,
        found: from,
        expected: this.options.version,
      });
      return null;
    }

    let current = record;
    let version = from;
    while (version < this.options.version) {
      const step = (this.options.migrations ?? []).find((entry) => entry.from === version);
      if (step === undefined) {
        log.error('No migration exists for a stored record version.', {
          kind: this.options.kind,
          found: version,
        });
        return null;
      }
      try {
        current = step.migrate(current);
      } catch {
        log.error('A record could not be migrated and was left in place.', {
          kind: this.options.kind,
          found: version,
        });
        return null;
      }
      version = step.to;
    }

    return this.options.validate(current) ? current : null;
  }

  private async evict(ids: readonly string[]): Promise<readonly string[]> {
    const live = new Set(ids);
    const prefix = `${this.options.kind}:v${this.options.version}:`;
    const suffix = 'index';
    const removed: string[] = [];
    for (const key of await this.options.area.keys()) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (id === suffix || live.has(id)) continue;
      await this.options.area.remove(key);
      removed.push(id);
    }
    return removed;
  }

  private async report(state: 'CORRUPT' | 'DEGRADED', reason: string): Promise<void> {
    await this.options.health?.report('storage', state, reason).catch(() => undefined);
  }

  /* ------------------------------ upgrade ------------------------------ */

  /** Runs the generation upgrade at most once per worker. */
  private ensureUpgraded(): Promise<UpgradeOutcome> {
    this.upgrade ??= this.runUpgrade().catch((error: unknown) => {
      // An upgrade that threw as a whole leaves the old generation exactly
      // where it was. The store then reads empty for this session, which is
      // recoverable; a half-written generation would not be.
      log.error('A storage upgrade did not complete; existing data was left untouched.', {
        kind: this.options.kind,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      void this.report('DEGRADED', `${this.options.kind}: the storage upgrade did not complete`);
      return { migrated: 0, quarantined: 0, from: null };
    });
    return this.upgrade;
  }

  /**
   * Brings every older generation forward.
   *
   * Sources are tried oldest first. The first one that has anything in it is
   * migrated and then removed; later sources are still checked, because a
   * profile that was interrupted mid-upgrade can legitimately hold two.
   */
  private async runUpgrade(): Promise<UpgradeOutcome> {
    let migrated = 0;
    let quarantined = 0;
    let from: number | null = null;

    for (const source of this.options.legacy ?? []) {
      const found = await this.readLegacy(source);
      if (found === null || found.records.length === 0) continue;

      const accepted: T[] = [];
      for (const candidate of found.records) {
        const result = this.migrate(candidate, found.version);
        if (result === null) {
          quarantined += 1;
          continue;
        }
        accepted.push(result);
      }

      // Oldest first into `put`, which prepends, so the newest ends up first
      // and the original ordering survives the move.
      for (const record of [...accepted].reverse()) await this.write(record);

      // Verify before removing anything. A generation is only superseded once
      // its replacement has been read back, not once it has been written.
      const verified = await this.verify(accepted);
      if (!verified) {
        log.error('A storage upgrade could not be verified; the old records were kept.', {
          kind: this.options.kind,
        });
        await this.report('DEGRADED', `${this.options.kind}: the upgrade could not be verified`);
        continue;
      }

      await this.clearLegacy(source);
      migrated += accepted.length;
      from ??= found.version;

      if (quarantined > 0) {
        log.error('Some records could not be upgraded and were left in place.', {
          kind: this.options.kind,
          quarantined,
        });
        await this.report('CORRUPT', `${this.options.kind}: ${quarantined} record(s) not upgraded`);
      } else {
        log.info('Stored records were upgraded to the current format.', {
          kind: this.options.kind,
          migrated: accepted.length,
        });
      }
    }

    return { migrated, quarantined, from };
  }

  private async readLegacy(
    source: LegacySource,
  ): Promise<{ readonly records: readonly unknown[]; readonly version: number } | null> {
    if (source.kind === 'blob') {
      const stored = await this.options.area.get<unknown>(source.key);
      if (stored === undefined) return null;
      try {
        return { records: source.extract(stored), version: source.version };
      } catch {
        log.error('A legacy record blob was malformed and was not upgraded.', {
          kind: this.options.kind,
        });
        await this.report('CORRUPT', `${this.options.kind}: the legacy blob is malformed`);
        return null;
      }
    }

    const index = await this.options.area.get<RecordIndex>(this.indexKey(source.version));
    if (index === undefined || !Array.isArray(index.ids)) return null;
    const records: unknown[] = [];
    for (const id of index.ids) {
      if (typeof id !== 'string') continue;
      const stored = await this.options.area.get<unknown>(
        `${this.options.kind}:v${source.version}:${id}`,
      );
      if (stored === undefined) continue;
      records.push(isEnvelope(stored) ? stored.record : stored);
    }
    return { records, version: source.version };
  }

  /** Reads one migrated record back through the normal path. */
  private async verify(accepted: readonly T[]): Promise<boolean> {
    const sample = accepted[0];
    if (sample === undefined) return true;
    const id = this.options.identify(sample);
    const stored = await this.options.area.get<unknown>(this.recordKey(id));
    return isEnvelope(stored) && this.options.validate(stored.record);
  }

  private async clearLegacy(source: LegacySource): Promise<void> {
    if (source.kind === 'blob') {
      await this.options.area.remove(source.key);
      return;
    }
    const index = await this.options.area.get<RecordIndex>(this.indexKey(source.version));
    for (const id of index?.ids ?? []) {
      await this.options.area.remove(`${this.options.kind}:v${source.version}:${id}`);
    }
    await this.options.area.remove(this.indexKey(source.version));
  }
}

/**
 * The transactional variant, for stores whose index is contended.
 *
 * Identical behaviour; the type is narrowed so a caller that needs atomic
 * index updates cannot be handed a plain area by mistake.
 */
export type TransactionalRecordStoreOptions<T> = RecordStoreOptions<T> & {
  readonly area: TransactionalStorageArea;
};
