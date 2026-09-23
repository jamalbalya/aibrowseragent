/**
 * Where shortcuts live.
 *
 * The store owns uniqueness, and uniqueness is the security property: two
 * distinct names must never become one executable shortcut, and a name must
 * never quietly start meaning something else. So creation refuses a collision
 * rather than resolving it — on the normalised name, and again on the
 * confusability skeleton — and says which existing shortcut it collided with.
 *
 * Nothing here executes anything. There is no path from this class to
 * `SkillRunner`, `WorkflowReplayer` or `ToolRegistry`; creating, renaming,
 * listing and deleting a shortcut are storage operations. What a shortcut
 * points at runs through the route that already existed for that kind of
 * target.
 */
import { newId } from '@/utils/ids';
import type { TransactionalStorageArea } from '@/storage/storage-area';
import { RecordStore } from '@/storage/record-store';
import type { PersistenceHealthStore } from '@/storage/persistence-health';
import {
  assertShortcutSafe,
  isUsableShortcut,
  SHORTCUT_FORMAT_VERSION,
  type ShortcutRecord,
  type ShortcutTarget,
} from './shortcut-model';
import { normaliseShortcutName, type NameRefusal } from './shortcut-name';

const MAX_SHORTCUTS = 100;

/** The pre-local-first layout: one key holding every shortcut. */
const LEGACY_BLOB_KEY = 'shortcuts';

/**
 * Accepts a stored shortcut, or does not.
 *
 * Both gates, in the order they were always applied: the shape check, and the
 * prohibited-field assertion that keeps a definition or a credential out of a
 * record whose type has nowhere to put one. A record failing either is
 * dropped, never repaired — a half-understood reference is one that could
 * resolve to the wrong thing.
 */
function isStorableShortcut(candidate: unknown): candidate is ShortcutRecord {
  if (!isUsableShortcut(candidate)) return false;
  try {
    assertShortcutSafe(candidate as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
  return true;
}

export type ShortcutRefusal =
  | NameRefusal
  | 'NAME_TAKEN'
  | 'CONFUSABLE_WITH_EXISTING'
  | 'TOO_MANY'
  | 'NOT_FOUND'
  | 'INVALID_TARGET';

export class ShortcutError extends Error {
  constructor(
    readonly reason: ShortcutRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ShortcutError';
  }
}

export interface ShortcutStoreOptions {
  readonly area: TransactionalStorageArea;
  readonly now?: () => number;
  readonly health?: PersistenceHealthStore;
}

export class ShortcutStore {
  private readonly now: () => number;
  private readonly records: RecordStore<ShortcutRecord>;

  constructor(options: ShortcutStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.records = new RecordStore<ShortcutRecord>({
      area: options.area,
      kind: 'shortcuts',
      version: SHORTCUT_FORMAT_VERSION,
      identify: (record) => record.shortcutId,
      validate: isStorableShortcut,
      max: MAX_SHORTCUTS,
      // The previous build kept every shortcut in one value. Upgrading is
      // automatic and runs on first read; a shortcut that does not survive
      // validation is left where it is rather than being rewritten into
      // something this build guessed at.
      legacy: [
        {
          kind: 'blob',
          key: LEGACY_BLOB_KEY,
          version: SHORTCUT_FORMAT_VERSION,
          extract: (stored) =>
            typeof stored === 'object' &&
            stored !== null &&
            Array.isArray(
              (
                stored as {
                  shortcuts?: unknown;
                }
              ).shortcuts,
            )
              ? (stored as { shortcuts: readonly unknown[] }).shortcuts
              : [],
        },
      ],
      ...(options.health === undefined ? {} : { health: options.health }),
    });
  }

  /**
   * Creates a shortcut, or refuses. Executes nothing.
   *
   * The target is **not** validated here: existence and type are the
   * resolver's job, and it re-checks them at every invocation anyway. Putting
   * the check only here would let a shortcut created when its target existed
   * keep working after the target was deleted.
   */
  async create(displayName: string, target: ShortcutTarget): Promise<ShortcutRecord> {
    const verdict = normaliseShortcutName(displayName);
    if (!verdict.ok) throw new ShortcutError(verdict.reason, verdict.detail);

    const existing = await this.list();
    if (existing.length >= MAX_SHORTCUTS) {
      throw new ShortcutError('TOO_MANY', `There is room for ${MAX_SHORTCUTS} shortcuts.`);
    }

    // Refused, never merged and never auto-renamed. A user who types a name
    // that already exists has to be told, because the alternative is their
    // new shortcut silently running someone else's target.
    const sameName = existing.find((entry) => entry.name === verdict.name);
    if (sameName) {
      throw new ShortcutError(
        'NAME_TAKEN',
        `/${verdict.name} already exists. Choose a different name or delete the existing one.`,
      );
    }
    const confusable = existing.find((entry) => entry.skeleton === verdict.skeleton);
    if (confusable) {
      throw new ShortcutError(
        'CONFUSABLE_WITH_EXISTING',
        `/${verdict.name} is too easy to mistake for /${confusable.name}, which already exists. ` +
          'Choose a name that reads differently.',
      );
    }

    const record: ShortcutRecord = {
      shortcutId: newId('shortcut'),
      formatVersion: SHORTCUT_FORMAT_VERSION,
      displayName: displayName.trim().slice(0, 120),
      name: verdict.name,
      skeleton: verdict.skeleton,
      target,
      createdAt: this.now(),
      updatedAt: this.now(),
    };

    // The last gate before disk. The type has nowhere to put a definition or
    // a credential, and this refuses a record that grew one anyway.
    assertShortcutSafe(record as unknown as Record<string, unknown>);

    await this.records.put(record);
    return record;
  }

  /**
   * Points an existing shortcut at a different target. Executes nothing.
   *
   * The name is not changed here: renaming is a delete and a create, so that
   * a new name goes through the same collision checks a first one did.
   */
  async retarget(shortcutId: string, target: ShortcutTarget): Promise<ShortcutRecord> {
    const existing = (await this.list()).find((entry) => entry.shortcutId === shortcutId);
    if (!existing) throw new ShortcutError('NOT_FOUND', 'That shortcut no longer exists.');

    const record: ShortcutRecord = { ...existing, target, updatedAt: this.now() };
    assertShortcutSafe(record as unknown as Record<string, unknown>);

    // In place: retargeting must not reorder the list, because the order is
    // what the user sees and nothing about changing a target moved it.
    await this.records.replace(record);
    return record;
  }

  /**
   * Every usable shortcut.
   *
   * A record that does not survive `isUsableShortcut` is dropped rather than
   * repaired: it was written by something other than this class, and a
   * half-understood reference is one that could resolve to the wrong thing.
   */
  async list(): Promise<ShortcutRecord[]> {
    return [...(await this.records.list())];
  }

  /**
   * Finds a shortcut by what someone typed.
   *
   * Exact equality on the normalised name, and nothing else. No prefix match,
   * no closest match, no skeleton lookup — a skeleton is a collision key, and
   * resolving through one would run a shortcut the user did not name.
   */
  async find(typed: string): Promise<ShortcutRecord | undefined> {
    const verdict = normaliseShortcutName(typed);
    if (!verdict.ok) return undefined;
    return (await this.list()).find((entry) => entry.name === verdict.name);
  }

  async get(shortcutId: string): Promise<ShortcutRecord | undefined> {
    return this.records.get(shortcutId);
  }

  async remove(shortcutId: string): Promise<void> {
    await this.records.remove(shortcutId);
  }
}
