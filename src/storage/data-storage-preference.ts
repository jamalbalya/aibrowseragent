/**
 * Where the user asked their AI Browser Agent data to live.
 *
 * Deliberately its own store rather than a field on settings, because the
 * answer gates whether anything is uploaded at all and that decision should be
 * readable in one place rather than inferred from a larger record.
 *
 * **The default is LOCAL.** A fresh installation stores everything in
 * `chrome.storage` and uploads nothing, with no account, no backend and no
 * database — that is the product, not a degraded mode waiting to be resolved.
 * Cloud is reachable only by an explicit choice, and installing the extension
 * is not one.
 *
 * Earlier builds defaulted to `undecided`, which behaved identically (it
 * uploaded nothing) but presented local-first as an unanswered question. Those
 * records still exist in real profiles, so they are still read; they resolve
 * to LOCAL rather than being discarded. See `resolveStorageMode`.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';
import {
  DEFAULT_STORAGE_MODE,
  resolveStorageMode,
  type StorageMode,
} from '@/storage/data-classification';

const log = getLogger('storage');

const MODE_KEY = 'data-storage-mode';
const DEVICE_KEY = 'device-id';

export interface DataStoragePreference {
  /** The mode in force. Always one of the two real modes. */
  readonly mode: StorageMode;
  /**
   * When the user explicitly chose, or `null` when they never did.
   *
   * Null does not mean "undecided": the mode is LOCAL either way. It means the
   * extension is running on its default rather than on a decision, which is
   * what the settings panel needs in order to describe the state honestly.
   */
  readonly chosenAt: number | null;
}

const LOCAL_DEFAULT: DataStoragePreference = {
  mode: DEFAULT_STORAGE_MODE,
  chosenAt: null,
};

export class DataStoragePreferenceStore {
  constructor(private readonly area: StorageArea) {}

  /**
   * The current preference.
   *
   * An absent, malformed or legacy record reads as LOCAL. That is the
   * conservative answer in the only direction that matters — it uploads
   * nothing — and it is also the correct one, because LOCAL is what a profile
   * with no explicit choice has always behaved as.
   *
   * Repairing a damaged record into `cloud` would enrol somebody into remote
   * storage on the strength of a corrupt byte, so no branch does.
   */
  async get(): Promise<DataStoragePreference> {
    const stored = await this.area.get<Partial<DataStoragePreference> & { mode?: unknown }>(
      MODE_KEY,
    );
    if (stored === undefined) return LOCAL_DEFAULT;
    if (typeof stored !== 'object' || stored === null) {
      log.error('The data-storage preference is malformed; using local storage.');
      return LOCAL_DEFAULT;
    }

    const mode = resolveStorageMode(stored.mode);
    // A record that resolved away from what it stored was legacy or damaged.
    // Either way the user did not choose the mode now in force, so the
    // timestamp that would claim they did is dropped with it.
    const chose = stored.mode === mode;
    return {
      mode,
      chosenAt: chose && typeof stored.chosenAt === 'number' ? stored.chosenAt : null,
    };
  }

  async mode(): Promise<StorageMode> {
    return (await this.get()).mode;
  }

  /**
   * Records a real choice.
   *
   * Both modes are choices. Choosing LOCAL is not a no-op: it turns the
   * default into a decision, which is what lets the panel stop offering to
   * explain it.
   */
  async choose(mode: StorageMode, now: number): Promise<void> {
    await this.area.set<DataStoragePreference>(MODE_KEY, { mode, chosenAt: now });
    log.info('The user chose where their data is stored.', { mode });
  }

  /**
   * Has the user ever made an explicit choice?
   *
   * The panel uses this to decide whether to offer an explanation of cloud
   * storage, never to decide what to do with data. Nothing about a `false`
   * here changes where anything is stored: it is LOCAL either way.
   */
  async hasChosen(): Promise<boolean> {
    return (await this.get()).chosenAt !== null;
  }

  /**
   * This installation's device identifier.
   *
   * Random, minted once, never derived from anything identifying — not from a
   * Google subject, not from a Chrome runtime id. It exists so a future sync
   * can key per-device state and so a conflict can name which device produced
   * the other side. In LOCAL mode it never leaves this profile.
   */
  async deviceId(mint: () => string = () => crypto.randomUUID()): Promise<string> {
    const existing = await this.area.get<string>(DEVICE_KEY);
    if (typeof existing === 'string' && existing.length > 0) return existing;
    const minted = mint();
    await this.area.set(DEVICE_KEY, minted);
    return minted;
  }
}
