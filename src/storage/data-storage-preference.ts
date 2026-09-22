/**
 * Where the user asked their AI Browser Agent data to live.
 *
 * Deliberately its own store rather than a field on settings, because the
 * answer gates whether anything is uploaded at all and that decision should be
 * readable in one place rather than inferred from a larger record.
 *
 * The default is `undecided`, and `undecided` uploads nothing. Nobody is
 * silently enrolled into cloud storage by not answering a question, and the
 * prompt stays re-offerable rather than being a one-shot the user can lose by
 * dismissing it.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';
import { DATA_STORAGE_MODES, type DataStorageMode } from '@/storage/data-classification';

const log = getLogger('storage');

const MODE_KEY = 'data-storage-mode';
const DEVICE_KEY = 'device-id';

export interface DataStoragePreference {
  readonly mode: DataStorageMode;
  readonly chosenAt: number | null;
  /** The user dismissed the prompt. Re-offerable from settings, not nagged. */
  readonly dismissedAt: number | null;
}

const UNDECIDED: DataStoragePreference = {
  mode: 'undecided',
  chosenAt: null,
  dismissedAt: null,
};

export class DataStoragePreferenceStore {
  constructor(private readonly area: StorageArea) {}

  /**
   * The current preference.
   *
   * A malformed or absent record reads as `undecided`, which is the
   * conservative answer: it uploads nothing. Repairing it into `cloud` would
   * enrol somebody into remote storage on the strength of a corrupt byte.
   */
  async get(): Promise<DataStoragePreference> {
    const stored = await this.area.get<DataStoragePreference>(MODE_KEY);
    if (stored === undefined) return UNDECIDED;
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !(DATA_STORAGE_MODES as readonly string[]).includes(stored.mode)
    ) {
      log.error('The data-storage preference is malformed; treating it as undecided.');
      return UNDECIDED;
    }
    return {
      mode: stored.mode,
      chosenAt: typeof stored.chosenAt === 'number' ? stored.chosenAt : null,
      dismissedAt: typeof stored.dismissedAt === 'number' ? stored.dismissedAt : null,
    };
  }

  async mode(): Promise<DataStorageMode> {
    return (await this.get()).mode;
  }

  /** Records a real choice. Only `local` and `cloud` are choices. */
  async choose(mode: Exclude<DataStorageMode, 'undecided'>, now: number): Promise<void> {
    await this.area.set<DataStoragePreference>(MODE_KEY, {
      mode,
      chosenAt: now,
      dismissedAt: null,
    });
    log.info('The user chose where their data is stored.', { mode });
  }

  /** "Ask me later". Changes nothing about what is stored or uploaded. */
  async dismiss(now: number): Promise<void> {
    const current = await this.get();
    if (current.mode !== 'undecided') return;
    await this.area.set<DataStoragePreference>(MODE_KEY, {
      mode: 'undecided',
      chosenAt: null,
      dismissedAt: now,
    });
  }

  /** Should the panel offer the choice right now? */
  async shouldPrompt(): Promise<boolean> {
    const current = await this.get();
    return current.mode === 'undecided' && current.dismissedAt === null;
  }

  /**
   * This installation's device identifier.
   *
   * Random, minted once, never derived from anything identifying. It exists so
   * sync can key per-device state — the AI brain, an audit chain — and so a
   * conflict can name which device produced the other side.
   */
  async deviceId(mint: () => string = () => crypto.randomUUID()): Promise<string> {
    const existing = await this.area.get<string>(DEVICE_KEY);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const minted = mint();
    await this.area.set(DEVICE_KEY, minted);
    return minted;
  }
}
