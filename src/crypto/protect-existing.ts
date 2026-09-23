/**
 * Encrypting what is already on disk when protection is switched on.
 *
 * The record being converted is a provider API key — something the user paid
 * for and may not be able to re-issue — so the ordering is the same one the
 * account migration uses, for the same reason: **never remove a value that has
 * not first been proved readable in its new form.**
 *
 * Here that is simpler than it sounds, because encrypting happens *in place*:
 * the ciphertext is written under the key the plaintext was at. There is no
 * moment where the plaintext has been deleted and the ciphertext has not
 * landed. Either the write succeeded, in which case a read-back returns the
 * original value, or it did not, in which case the plaintext is untouched and
 * the next run tries again.
 *
 * ## Restart safety
 *
 * Idempotent by construction rather than by a marker. Each record is examined
 * on its own: a plaintext value is encrypted, an envelope is left alone. A run
 * interrupted after three of five records simply converts the remaining two
 * next time, and re-running when everything is already encrypted does
 * nothing. There is no state to get out of step.
 *
 * ## What it refuses to do
 *
 * A record that is *already* an envelope and *cannot be decrypted* is not
 * treated as legacy plaintext to be re-encrypted. That is the one confusion
 * that would destroy data: sealing an unreadable envelope inside a second
 * envelope makes it permanently unreadable and reports success.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';
import { isEnvelope } from './envelope';

const log = getLogger('storage');

export interface ProtectOutcome {
  /** Records that were plaintext and are now encrypted. */
  readonly encrypted: number;
  /** Records that were already encrypted. Not an error; the common re-run. */
  readonly alreadyProtected: number;
  /** Records whose write did not land. The plaintext is still there. */
  readonly failed: number;
  /** Envelopes that could not be decrypted. Left exactly as they were. */
  readonly unreadable: number;
}

/**
 * Converts every plaintext record in `plain` to ciphertext through
 * `protectedArea`, which must be the same storage under a
 * `ProtectedStorageArea`.
 *
 * Two views of one store rather than a copy between two stores, so a record
 * can never exist in one and not the other.
 */
export async function protectExistingRecords(
  plain: StorageArea,
  protectedArea: StorageArea,
): Promise<ProtectOutcome> {
  let encrypted = 0;
  let alreadyProtected = 0;
  let failed = 0;
  let unreadable = 0;

  for (const key of await plain.keys()) {
    const stored = await plain.get<unknown>(key);
    if (stored === undefined) continue;

    if (isEnvelope(stored)) {
      // Already protected — but prove it can be read before counting it so.
      // An envelope that will not open is a record in trouble, and quietly
      // calling it "already protected" would hide that until the user needed
      // the key.
      try {
        await protectedArea.get(key);
        alreadyProtected += 1;
      } catch {
        unreadable += 1;
        log.error('A record was already encrypted and could not be read back.');
      }
      continue;
    }

    try {
      await protectedArea.set(key, stored);
      // The read-back the whole ordering exists for. In-place encryption means
      // a failed write leaves the plaintext, so this proves the ciphertext is
      // both present and openable before anything is counted as done.
      const readBack = await protectedArea.get<unknown>(key);
      if (JSON.stringify(readBack) !== JSON.stringify(stored)) {
        failed += 1;
        log.error('A record was encrypted but did not read back as itself.');
        continue;
      }
      encrypted += 1;
    } catch {
      failed += 1;
      log.error('A record could not be encrypted and was left as it was.');
    }
  }

  return { encrypted, alreadyProtected, failed, unreadable };
}

/**
 * The reverse, for switching protection off.
 *
 * Every record has to be readable before any of them is written back as
 * plaintext: half a store decrypted and half still encrypted under a key that
 * is about to be deleted is worse than either end state. So this reads
 * everything first and refuses as a whole if anything will not open.
 */
export async function unprotectExistingRecords(
  plain: StorageArea,
  protectedArea: StorageArea,
): Promise<{ ok: true; decrypted: number } | { ok: false; unreadable: number }> {
  const recovered: { key: string; value: unknown }[] = [];
  let unreadable = 0;

  for (const key of await plain.keys()) {
    const stored = await plain.get<unknown>(key);
    if (stored === undefined) continue;
    if (!isEnvelope(stored)) continue;
    try {
      recovered.push({ key, value: await protectedArea.get(key) });
    } catch {
      unreadable += 1;
    }
  }
  if (unreadable > 0) return { ok: false, unreadable };

  for (const { key, value } of recovered) await plain.set(key, value);
  return { ok: true, decrypted: recovered.length };
}
