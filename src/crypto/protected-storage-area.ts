/**
 * A `StorageArea` that encrypts what it stores.
 *
 * A decorator rather than a new interface, so a store can be protected without
 * any of its call sites learning about encryption. `CredentialStore` does not
 * know whether it is writing ciphertext, which is what keeps the decision
 * about *what* is protected in one place instead of scattered through every
 * store that holds something sensitive.
 *
 * ## Reads while locked fail; they do not come back empty
 *
 * The most dangerous thing this could do is answer `undefined` for a record it
 * simply cannot read. "You have no API key" and "I cannot read your API key"
 * lead to opposite actions — the first invites the user to reconnect, which
 * overwrites the key they still have. So a locked or unreadable value throws,
 * and the callers above turn that into a message about unlocking.
 *
 * ## Writes while locked fail too
 *
 * A write that silently stored plaintext because the key was unavailable would
 * be a downgrade nobody would notice until somebody read the profile
 * directory.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';
import { EnvelopeError, isEnvelope, open, seal } from './envelope';
import type { K1Store } from './k1-store';

const log = getLogger('storage');

export type ProtectedFailure = 'LOCKED' | 'UNREADABLE';

export class ProtectedStorageError extends Error {
  constructor(readonly failure: ProtectedFailure) {
    super(
      failure === 'LOCKED'
        ? 'This data is protected and the installation is locked.'
        : 'This protected data could not be read on this device.',
    );
    this.name = 'ProtectedStorageError';
  }
}

export class ProtectedStorageArea implements StorageArea {
  constructor(
    private readonly inner: StorageArea,
    private readonly k1: K1Store,
    /** Prefixed into the authenticated location, so two protected areas over
     *  one backing store cannot have their envelopes swapped. */
    private readonly label: string,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const stored = await this.inner.get<unknown>(key);
    if (stored === undefined) return undefined;

    // A plaintext value in a protected area is a record written before K1 was
    // switched on. Returned as-is rather than refused, because migration is
    // what converts it and refusing would break the installation between
    // switching on and finishing. It is not a downgrade: writes always
    // encrypt, so nothing new lands in plaintext.
    if (!isEnvelope(stored)) return stored as T;

    const material = await this.k1.key();
    if (material === null) throw new ProtectedStorageError('LOCKED');
    try {
      return (await open(material.key, this.location(key), stored)) as T;
    } catch (error) {
      // Fail closed, and say which. A caller must never read this as absence.
      log.error('A protected record could not be decrypted.', {
        failure: error instanceof EnvelopeError ? error.failure : 'unknown',
      });
      throw new ProtectedStorageError('UNREADABLE');
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const material = await this.k1.key();
    if (material === null) throw new ProtectedStorageError('LOCKED');
    await this.inner.set(key, await seal(material.key, material.keyId, this.location(key), value));
  }

  remove(key: string): Promise<void> {
    // Deleting needs no key: refusing would leave a user unable to remove a
    // credential they can no longer decrypt, which is the opposite of safe.
    return this.inner.remove(key);
  }

  keys(): Promise<string[]> {
    // Key *names* are not protected. They are structural — `conn:<id>` — and
    // encrypting them would make the store unlistable while locked without
    // hiding anything the account records do not already say in plaintext.
    return this.inner.keys();
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }

  /** What the envelope's tag is taken over. Label included, so two protected
   *  areas sharing a backing store cannot exchange envelopes. */
  private location(key: string): string {
    return `${this.label}/${key}`;
  }
}
