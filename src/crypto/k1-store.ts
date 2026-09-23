/**
 * K1 lifecycle: off, locked, unlocked — and the failure that is none of them.
 *
 * ## Where the two pieces live, and why
 *
 * The **wrapped** data key is durable, in `chrome.storage.local`. It has to
 * survive a browser restart and it is useless without the passphrase.
 *
 * The **unwrapped** data key is held in `chrome.storage.session`, which Chrome
 * keeps in memory and never writes to disk, with its access level already set
 * to trusted contexts so a content script cannot read it. An in-memory
 * variable in the worker would be the obvious choice and is the wrong one
 * under MV3: the worker is evicted every few minutes, so the user would be
 * asked for their passphrase again on a cadence that would make them turn the
 * feature off. Session storage survives eviction and does not survive a
 * browser restart, which is the behaviour a lock is supposed to have.
 *
 * This is an honest trade and not a guarantee: anything running in the
 * worker's own context can read the unwrapped key while it is unlocked. That
 * is the same boundary that already lets the worker read the plaintext it is
 * about to encrypt, so K1 does not claim to defend against code running
 * inside the extension. What it defends against is somebody reading the
 * profile directory, and the unwrapped key is never in it.
 *
 * ## The state that must never be confused with first use
 *
 * `NEEDS_RECOVERY`. If K1 is enabled and the key metadata is missing or
 * unreadable, the encrypted records are undecryptable and the only honest
 * answers are to restore a backup or to accept the loss. Generating a fresh
 * key there would produce an installation that looks healthy and silently
 * cannot read a single existing record — so nothing in this module writes new
 * metadata over an enabled state, and `initialize` refuses outright.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';
import {
  createWrappedKey,
  DEK_BYTES,
  importDek,
  MIN_PASSPHRASE_LENGTH,
  parseKeyMetadata,
  unwrapKey,
  UnlockError,
  wrapExistingKey,
} from './passphrase-key';
import { fromBase64, toBase64 } from './envelope';

const log = getLogger('storage');

const STATE_KEY = 'k1-state';
const METADATA_KEY = 'k1-key';
const SESSION_KEY = 'k1-unlocked';

export const K1_STATES = ['OFF', 'LOCKED', 'UNLOCKED', 'NEEDS_RECOVERY'] as const;
export type K1State = (typeof K1_STATES)[number];

/**
 * The durable "is K1 on" flag.
 *
 * Separate from the key metadata so that losing the metadata is *detectable*
 * rather than indistinguishable from never having turned K1 on. One record
 * says what the user chose; the other is what makes it work. Both present is
 * healthy, both absent is off, and the flag without the metadata is the
 * recovery state this design exists to name.
 */
interface EnabledFlag {
  readonly enabled: true;
  readonly since: number;
  /** For diagnostics only. Never a key, never an identity. */
  readonly keyId: string;
}

export interface K1Status {
  readonly state: K1State;
  /** Present when K1 has ever been enabled. Safe to show; identifies nothing. */
  readonly keyId?: string;
  readonly since?: number;
}

export class K1Store {
  constructor(
    private readonly durable: StorageArea,
    private readonly memory: StorageArea,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async status(): Promise<K1Status> {
    const flag = await this.readFlag();
    if (!flag) return { state: 'OFF' };

    // Parsed in full rather than sniffed: a record that is recognisably key
    // metadata and is missing its salt cannot unlock anything, and reporting
    // LOCKED for it would describe an installation that can never be
    // unlocked as merely waiting for a passphrase.
    const metadata = parseKeyMetadata(await this.durable.get<unknown>(METADATA_KEY));
    if (metadata === null) {
      // Enabled, and the key is gone or unreadable. Never reported as OFF:
      // that would invite a caller to "initialise" over data it cannot read.
      log.error('K1 is enabled but its key metadata is missing or unreadable.');
      return { state: 'NEEDS_RECOVERY', keyId: flag.keyId, since: flag.since };
    }
    const unlocked = await this.readSessionKey();
    return {
      state: unlocked === null ? 'LOCKED' : 'UNLOCKED',
      keyId: flag.keyId,
      since: flag.since,
    };
  }

  /**
   * Turns K1 on for the first time.
   *
   * Refuses if it is already on, whatever state it is in. Re-initialising over
   * an enabled installation is the one operation that silently destroys data,
   * so it is not reachable by accident: turning K1 off is a separate,
   * explicit call that decrypts first.
   */
  async initialize(passphrase: string): Promise<K1Status> {
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new UnlockError('WRONG_PASSPHRASE');
    }
    if (await this.readFlag()) {
      throw new Error('Protection is already switched on for this installation.');
    }

    const { metadata, dek, keyId } = await createWrappedKey(passphrase, this.now());
    // Metadata before the flag: a crash between them leaves an unused key
    // record and an installation that is still OFF, which the next
    // `initialize` overwrites harmlessly. The other order would leave the
    // recovery state on an installation that has no encrypted data at all.
    await this.durable.set(METADATA_KEY, metadata);
    const readBack = parseKeyMetadata(await this.durable.get<unknown>(METADATA_KEY));
    if (readBack === null) {
      throw new Error('The protection key could not be saved on this device.');
    }
    await this.durable.set<EnabledFlag>(STATE_KEY, {
      enabled: true,
      since: this.now(),
      keyId,
    });
    await this.writeSessionKey(dek);
    log.info('K1 protection was switched on.', { keyId });
    return { state: 'UNLOCKED', keyId, since: this.now() };
  }

  /** Derives the key from the passphrase and holds it for this browser session. */
  async unlock(passphrase: string): Promise<K1Status> {
    const flag = await this.readFlag();
    if (!flag) throw new Error('Protection is not switched on for this installation.');
    const metadata = parseKeyMetadata(await this.durable.get<unknown>(METADATA_KEY));
    if (metadata === null) throw new UnlockError('METADATA_CORRUPT');

    const { dek, keyId } = await unwrapKey(passphrase, metadata);
    await this.writeSessionKey(dek);
    return { state: 'UNLOCKED', keyId, since: flag.since };
  }

  /** Drops the unwrapped key. The durable records are untouched. */
  async lock(): Promise<void> {
    await this.memory.remove(SESSION_KEY);
  }

  /**
   * The key for encrypting and decrypting, or `null` when locked.
   *
   * Callers must treat `null` as "cannot read", never as "nothing stored".
   */
  async key(): Promise<{ key: CryptoKey; keyId: string } | null> {
    const raw = await this.readSessionKey();
    if (raw === null) return null;
    const metadata = parseKeyMetadata(await this.durable.get<unknown>(METADATA_KEY));
    if (metadata === null) return null;
    return { key: await importDek(raw), keyId: metadata.keyId };
  }

  /**
   * Changes the passphrase by re-wrapping the same data key.
   *
   * Nothing stored is re-encrypted, so an interrupted change cannot leave
   * records encrypted under a key nobody holds: either the old wrapping is
   * still there or the new one is, and both open the same DEK.
   */
  async changePassphrase(current: string, next: string): Promise<void> {
    if (next.length < MIN_PASSPHRASE_LENGTH) throw new UnlockError('WRONG_PASSPHRASE');
    const metadata = parseKeyMetadata(await this.durable.get<unknown>(METADATA_KEY));
    if (metadata === null) throw new UnlockError('METADATA_CORRUPT');

    const { dek, keyId } = await unwrapKey(current, metadata);
    const rewrapped = await wrapExistingKey(next, dek, keyId, undefined, this.now());
    // Verified before it replaces anything: a wrapping that cannot be opened
    // with the new passphrase would lock the user out of their own data.
    await unwrapKey(next, rewrapped);
    await this.durable.set(METADATA_KEY, rewrapped);
    await this.writeSessionKey(dek);
  }

  /**
   * Turns K1 off. The caller must have decrypted everything first.
   *
   * This module cannot do that itself — it does not know which stores are
   * protected — so it only clears its own records, and the worker sequences
   * the decrypt before calling it.
   */
  async disable(): Promise<void> {
    await this.lock();
    await this.durable.remove(STATE_KEY);
    await this.durable.remove(METADATA_KEY);
    log.info('K1 protection was switched off.');
  }

  private async readFlag(): Promise<EnabledFlag | null> {
    const stored = await this.durable.get<Partial<EnabledFlag>>(STATE_KEY);
    if (stored?.enabled !== true || typeof stored.keyId !== 'string') return null;
    return {
      enabled: true,
      since: typeof stored.since === 'number' ? stored.since : 0,
      keyId: stored.keyId,
    };
  }

  private async writeSessionKey(dek: Uint8Array<ArrayBuffer>): Promise<void> {
    // Base64 rather than the raw array: `chrome.storage.session` serialises
    // through structured clone, and a typed array comes back as a plain object
    // in some paths. A string round-trips identically everywhere.
    await this.memory.set(SESSION_KEY, toBase64(dek));
  }

  private async readSessionKey(): Promise<Uint8Array<ArrayBuffer> | null> {
    const stored = await this.memory.get<string>(SESSION_KEY);
    if (typeof stored !== 'string') return null;
    const bytes = fromBase64(stored);
    return bytes !== null && bytes.length === DEK_BYTES ? bytes : null;
  }
}
