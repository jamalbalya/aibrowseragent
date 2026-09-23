/**
 * The K1 key hierarchy.
 *
 * Two keys, and the separation is the point:
 *
 *   passphrase --PBKDF2--> KEK --AES-GCM--> (wrapped) DEK --AES-GCM--> records
 *
 * The **data encryption key** is 256 random bits and is what every record is
 * encrypted under. The **key encryption key** is derived from the passphrase
 * and does nothing but wrap the DEK. Changing the passphrase therefore
 * re-wraps one small record rather than re-encrypting everything the user
 * owns, and a re-wrap that fails leaves the old wrapping intact.
 *
 * ## Why a passphrase at all
 *
 * Not a preference — an architectural consequence, established by looking at
 * where an extension can put a key.
 *
 * `chrome.storage.local` is a LevelDB directory inside the browser profile.
 * Anybody who can read the ciphertext can read everything else in there, so a
 * key kept in it protects against nothing. `chrome.storage.session` is held in
 * memory and never written to disk, which is exactly right for an *unlocked*
 * key and useless for a persistent one: it is empty after a browser restart.
 * An extension has no access to the OS keychain, and Chrome offers no
 * encrypted-at-rest storage API.
 *
 * So the only key material that is not sitting next to the ciphertext is
 * material the user supplies and this code never stores. That is the whole
 * argument for the passphrase, and it is also why K1 cannot be silently
 * enabled for somebody: without a passphrase there is nothing to claim.
 *
 * ## What is *not* used to derive keys, deliberately
 *
 * The installation identity, any provider or account id, anything about the
 * device, the browser or the profile. All of those live on the same disk as
 * the ciphertext, so deriving from them would be the same non-protection with
 * more steps — and the installation identity in particular is ownership
 * metadata, which becoming key material would quietly turn into a credential.
 */
import { fromBase64, toBase64 } from './envelope';

/**
 * PBKDF2-SHA-256, because it is what Web Crypto actually implements.
 *
 * Argon2id or scrypt would be the better choice against a GPU attacker, and
 * neither is available in the extension runtime. Shipping a JavaScript Argon2
 * would mean auditing a memory-hard primitive nobody here is in a position to
 * audit, so the honest answer is the standard primitive at a high work factor,
 * with the limitation written down rather than hidden.
 *
 * 600,000 iterations is OWASP's 2023 floor for PBKDF2-HMAC-SHA-256. It is a
 * cost the user pays once per unlock, not once per record, because what it
 * protects is the DEK wrapping.
 */
export const KDF = 'PBKDF2-SHA256';
export const KDF_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const DEK_BYTES = 32;

/** The passphrase floor. Advisory strength, not a security claim. */
export const MIN_PASSPHRASE_LENGTH = 8;

/**
 * Everything needed to unwrap the DEK given the passphrase, and nothing that
 * helps without it.
 *
 * Stored in plain `chrome.storage.local`, on purpose: a salt is not a secret,
 * and the wrapped key is useless without the passphrase. There is no
 * passphrase hash here — the wrapped DEK *is* the verifier, because unwrapping
 * it either authenticates or does not.
 */
export interface KeyMetadata {
  readonly v: number;
  readonly kdf: string;
  readonly iterations: number;
  /** Base64, 16 random bytes. */
  readonly salt: string;
  /** Which DEK generation this wrapping is of. Matches an envelope's `kid`. */
  readonly keyId: string;
  /** Base64 AES-GCM IV for the wrapping. */
  readonly wrapIv: string;
  /** Base64 wrapped DEK, tag included. */
  readonly wrapped: string;
  readonly createdAt: number;
}

export const KEY_METADATA_VERSION = 1;

export type UnlockFailure =
  /** The passphrase did not unwrap the key. Indistinguishable from tampering, on purpose. */
  | 'WRONG_PASSPHRASE'
  /** Metadata is present but not readable. Never treated as "no key yet". */
  | 'METADATA_CORRUPT'
  /** Metadata written by a newer build. */
  | 'UNSUPPORTED_VERSION';

export class UnlockError extends Error {
  constructor(readonly failure: UnlockFailure) {
    super(`The protected data could not be unlocked (${failure}).`);
    this.name = 'UnlockError';
  }
}

export function isKeyMetadata(value: unknown): value is KeyMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<KeyMetadata>;
  return typeof record.v === 'number' && typeof record.wrapped === 'string';
}

/**
 * Full validation, returning `null` rather than throwing.
 *
 * `isKeyMetadata` is a deliberately loose shape sniff, and it answers one
 * question: is there a metadata record here at all, as opposed to none? That
 * is what distinguishes "K1 was never switched on" from "the key is gone".
 *
 * It is the wrong question for *using* the record. A value that is
 * recognisably a metadata record and is missing its salt is not usable, and
 * treating it as usable reports a healthy LOCKED state for an installation
 * that can never be unlocked. So anything that is about to rely on the
 * metadata parses it properly instead.
 */
export function parseKeyMetadata(value: unknown): KeyMetadata | null {
  try {
    return validate(value);
  } catch {
    return null;
  }
}

function validate(value: unknown): KeyMetadata {
  if (!isKeyMetadata(value)) throw new UnlockError('METADATA_CORRUPT');
  const record = value as Partial<KeyMetadata>;
  if (record.v !== KEY_METADATA_VERSION) throw new UnlockError('UNSUPPORTED_VERSION');
  if (
    record.kdf !== KDF ||
    typeof record.iterations !== 'number' ||
    record.iterations < 1 ||
    typeof record.salt !== 'string' ||
    typeof record.keyId !== 'string' ||
    record.keyId.length === 0 ||
    typeof record.wrapIv !== 'string' ||
    typeof record.wrapped !== 'string' ||
    typeof record.createdAt !== 'number'
  ) {
    throw new UnlockError('METADATA_CORRUPT');
  }
  if (fromBase64(record.salt) === null || fromBase64(record.wrapIv) === null) {
    throw new UnlockError('METADATA_CORRUPT');
  }
  if (fromBase64(record.wrapped) === null) throw new UnlockError('METADATA_CORRUPT');
  return record as KeyMetadata;
}

async function deriveKek(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    // Not extractable: nothing needs the KEK's bytes, and a KEK that cannot be
    // exported cannot be exported by mistake.
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A new generation, labelled so envelopes can say which one wrote them. */
export function mintKeyId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `k${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Creates a data key and wraps it under a passphrase.
 *
 * The DEK is generated here and returned alongside its wrapping, because the
 * caller needs it to encrypt with and the wrapping to store. It is never
 * derived from the passphrase: a derived DEK would make a passphrase change a
 * re-encryption of everything rather than a re-wrap of one record.
 */
export async function createWrappedKey(
  passphrase: string,
  now: number,
): Promise<{ metadata: KeyMetadata; dek: Uint8Array<ArrayBuffer>; keyId: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const keyId = mintKeyId();
  const metadata = await wrapExistingKey(passphrase, dek, keyId, salt, now);
  return { metadata, dek, keyId };
}

/**
 * Re-wraps a data key — used to change the passphrase without touching data.
 *
 * A fresh salt every time, so two wrappings of one key under two passphrases
 * share nothing an attacker can compare.
 */
export async function wrapExistingKey(
  passphrase: string,
  dek: Uint8Array<ArrayBuffer>,
  keyId: string,
  salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
  now: number = Date.now(),
): Promise<KeyMetadata> {
  const kek = await deriveKek(passphrase, salt, KDF_ITERATIONS);
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv, additionalData: wrapAad(keyId) },
    kek,
    dek,
  );
  return {
    v: KEY_METADATA_VERSION,
    kdf: KDF,
    iterations: KDF_ITERATIONS,
    salt: toBase64(salt),
    keyId,
    wrapIv: toBase64(wrapIv),
    wrapped: toBase64(new Uint8Array(wrapped)),
    createdAt: now,
  };
}

/**
 * Unwraps the data key, or says why it could not.
 *
 * A wrong passphrase and a tampered wrapping both surface as
 * `WRONG_PASSPHRASE`, because AES-GCM cannot tell them apart and reporting a
 * guess would be an oracle. What is kept distinct is *corrupt metadata*, which
 * is not a passphrase problem and must not be answered by asking the user to
 * type it again.
 */
export async function unwrapKey(
  passphrase: string,
  stored: unknown,
): Promise<{ dek: Uint8Array<ArrayBuffer>; keyId: string }> {
  const metadata = validate(stored);
  const salt = fromBase64(metadata.salt);
  const wrapIv = fromBase64(metadata.wrapIv);
  const wrapped = fromBase64(metadata.wrapped);
  if (salt === null || wrapIv === null || wrapped === null) {
    throw new UnlockError('METADATA_CORRUPT');
  }

  const kek = await deriveKek(passphrase, salt, metadata.iterations);
  try {
    const dek = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapIv, additionalData: wrapAad(metadata.keyId) },
      kek,
      wrapped,
    );
    const bytes = new Uint8Array(dek);
    if (bytes.length !== DEK_BYTES) throw new UnlockError('METADATA_CORRUPT');
    return { dek: bytes, keyId: metadata.keyId };
  } catch (error) {
    if (error instanceof UnlockError) throw error;
    throw new UnlockError('WRONG_PASSPHRASE');
  }
}

/** Imports raw DEK bytes for use with the envelope functions. */
export async function importDek(dek: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', dek, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** The key id is authenticated, so editing it in metadata breaks the unwrap. */
function wrapAad(keyId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`k1-wrap|${KEY_METADATA_VERSION}|${keyId}`);
}
