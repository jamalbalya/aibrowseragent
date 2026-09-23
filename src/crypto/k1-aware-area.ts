/**
 * A storage area that is protected only while K1 is switched on.
 *
 * K1 is opt-in, and most installations will never turn it on. Wiring
 * `ProtectedStorageArea` in unconditionally would mean every read of a
 * credential on an unprotected installation went through a key lookup that can
 * only ever return `null`, and every write would fail. So the decision is made
 * per call, against the durable state:
 *
 *   OFF             → straight through to the plain area
 *   LOCKED          → refuse; the caller must not read absence
 *   UNLOCKED        → encrypt and decrypt
 *   NEEDS_RECOVERY  → refuse; the key is gone and nothing here can fix it
 *
 * Per call rather than cached, because the state changes underneath: the
 * worker is evicted constantly, a lock can happen in another panel, and a
 * cached "off" would keep writing plaintext after the user switched
 * protection on.
 */
import type { StorageArea } from '@/storage/storage-area';
import type { K1Store } from './k1-store';
import { ProtectedStorageArea, ProtectedStorageError } from './protected-storage-area';

export class K1AwareArea implements StorageArea {
  private readonly protectedArea: StorageArea;

  constructor(
    private readonly plain: StorageArea,
    private readonly k1: K1Store,
    label: string,
  ) {
    this.protectedArea = new ProtectedStorageArea(plain, k1, label);
  }

  private async route(): Promise<StorageArea> {
    const { state } = await this.k1.status();
    if (state === 'OFF') return this.plain;
    if (state === 'UNLOCKED') return this.protectedArea;
    // LOCKED and NEEDS_RECOVERY both mean the records cannot be read, and the
    // difference matters to the person rather than to this call.
    throw new ProtectedStorageError(state === 'LOCKED' ? 'LOCKED' : 'UNREADABLE');
  }

  async get<T>(key: string): Promise<T | undefined> {
    return await (await this.route()).get<T>(key);
  }

  async set<T>(key: string, value: T): Promise<void> {
    await (await this.route()).set(key, value);
  }

  /** Always permitted: a record nobody can read must still be removable. */
  remove(key: string): Promise<void> {
    return this.plain.remove(key);
  }

  keys(): Promise<string[]> {
    return this.plain.keys();
  }

  clear(): Promise<void> {
    return this.plain.clear();
  }
}
