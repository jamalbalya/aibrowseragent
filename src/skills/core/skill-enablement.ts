/**
 * Whether a skill is available to be used at all (P-024).
 *
 * Claude documents skills that ship enabled and can be turned off. This is
 * that, and only that: a per-skill on/off switch the user owns. It is not an
 * install surface, it adds no way to obtain a skill, and it changes nothing
 * about what a skill may do when it is on — a disabled skill is simply not
 * there, and an enabled one is exactly the build-shipped, hash-pinned
 * definition it always was.
 *
 * **Disabled means invisible and unreachable, not merely hidden.** The
 * enforcement lives in `SkillRegistry`, so `get`, `latest` and `list` all
 * answer as though a disabled skill were not registered. Filtering only the
 * listing would leave a model able to name a skill it was never shown, which
 * is the version of this feature that looks identical in the UI and is not a
 * control at all.
 *
 * Stored as the set of *disabled* keys rather than enabled ones, so a skill
 * that ships in a later build is available by default and an unreadable store
 * fails towards the build's own defaults rather than towards silence.
 */
import type { StorageArea } from '@/storage/storage-area';
import { getLogger } from '@/logging/logger';

const log = getLogger('storage');

const DISABLED_KEY = 'skills-disabled';

/** `id@version`, the same key the registry indexes by. */
export type SkillKey = string;

export function skillEnablementKey(id: string, version: string): SkillKey {
  return `${id}@${version}`;
}

interface DisabledRecord {
  readonly keys: readonly string[];
}

/**
 * The durable half.
 *
 * Deliberately tiny and deliberately not a general preference bag: the only
 * thing it can express is "this exact version of this skill is off", so there
 * is nothing here that could grow into a policy input.
 */
export class SkillEnablementStore {
  constructor(private readonly area: StorageArea) {}

  async disabledKeys(): Promise<Set<SkillKey>> {
    try {
      const record = await this.area.get<DisabledRecord>(DISABLED_KEY);
      const keys = Array.isArray(record?.keys) ? record.keys : [];
      return new Set(keys.filter((key): key is string => typeof key === 'string'));
    } catch (error) {
      // A store that cannot be read means the user's choices are unknown. The
      // safe direction is the build's default — every shipped skill enabled —
      // because the alternative silently disables working skills and reads to
      // the user as the extension being broken.
      log.warn('Skill enablement could not be read; using the shipped defaults.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return new Set();
    }
  }

  async setEnabled(key: SkillKey, enabled: boolean): Promise<void> {
    const disabled = await this.disabledKeys();
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    await this.area.set(DISABLED_KEY, { keys: [...disabled].sort() } satisfies DisabledRecord);
  }
}
