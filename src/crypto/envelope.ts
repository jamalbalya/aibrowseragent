/**
 * The K1 ciphertext envelope.
 *
 * One record shape, one algorithm, and a decoder that refuses anything it does
 * not fully recognise. Everything interesting here is a refusal: the failures
 * are what the format is for.
 *
 * ## Why AAD binds the storage key
 *
 * AES-GCM authenticates the ciphertext, so tampering is caught. What it does
 * not catch on its own is a ciphertext being **moved**: an attacker with write
 * access to the profile could copy the envelope stored under one key over
 * another and every integrity check would still pass, because the bytes are
 * genuinely ones this installation wrote. Binding the storage key as
 * additional authenticated data makes that a decryption failure — the tag is
 * over the location as well as the content.
 *
 * ## What it does not defend against, stated here so nobody assumes otherwise
 *
 * **Rollback of a value to an earlier ciphertext for the same key.** An older
 * envelope for the same key, under the same DEK, is authentic and will
 * decrypt. Detecting it needs a monotonic counter held somewhere the attacker
 * cannot also roll back, and a Chrome extension has nowhere like that: the
 * counter would sit in the same profile directory as the data. Nothing here
 * pretends to solve it.
 */

/** Bumped only for a change that an older build must refuse rather than read. */
export const ENVELOPE_VERSION = 1;

/** The one construction. Not a negotiation — an unknown value is refused. */
export const ENVELOPE_ALGORITHM = 'AES-GCM-256';

/** 96 bits, the size AES-GCM is specified for. */
export const IV_BYTES = 12;

export interface CipherEnvelope {
  readonly v: number;
  readonly alg: string;
  /**
   * Which data key encrypted this, so a rotation can tell an envelope it can
   * still read from one it cannot. Never the key, and never derived from it.
   */
  readonly kid: string;
  /** Base64. Random per encryption; never reused under one key. */
  readonly iv: string;
  /** Base64. AES-GCM output, tag included. */
  readonly ct: string;
}

/** Why a decode or a decrypt refused. Each is a distinct, actionable state. */
export type EnvelopeFailure =
  /** Not an envelope at all — the value was written before K1, or by something else. */
  | 'NOT_AN_ENVELOPE'
  /** An envelope from a newer build. Refused rather than partly read. */
  | 'UNSUPPORTED_VERSION'
  /** An algorithm this build does not implement. */
  | 'UNSUPPORTED_ALGORITHM'
  /** Structurally an envelope, but a field is missing or malformed. */
  | 'MALFORMED'
  /** The tag did not verify: wrong key, tampered bytes, or a moved envelope. */
  | 'AUTHENTICATION_FAILED';

export class EnvelopeError extends Error {
  constructor(readonly failure: EnvelopeFailure) {
    super(`The stored value could not be read (${failure}).`);
    this.name = 'EnvelopeError';
  }
}

/**
 * Is this value an envelope, as opposed to a plaintext record?
 *
 * Deliberately shape-only and deliberately strict: it is what distinguishes
 * "this installation has not been migrated yet" from "this envelope is
 * damaged", and those must never be confused. A value that looks *almost*
 * like an envelope is damaged, not legacy.
 */
export function isEnvelope(value: unknown): value is CipherEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<CipherEnvelope>;
  return typeof record.v === 'number' && typeof record.alg === 'string';
}

export function decodeEnvelope(value: unknown): CipherEnvelope {
  if (!isEnvelope(value)) throw new EnvelopeError('NOT_AN_ENVELOPE');
  const record = value as Partial<CipherEnvelope>;

  // Version before algorithm: a future version may define what the algorithm
  // field even means, so reading it first would be reading a field this build
  // does not know the meaning of.
  if (record.v !== ENVELOPE_VERSION) throw new EnvelopeError('UNSUPPORTED_VERSION');
  if (record.alg !== ENVELOPE_ALGORITHM) throw new EnvelopeError('UNSUPPORTED_ALGORITHM');
  if (
    typeof record.kid !== 'string' ||
    record.kid.length === 0 ||
    typeof record.iv !== 'string' ||
    typeof record.ct !== 'string' ||
    record.ct.length === 0
  ) {
    throw new EnvelopeError('MALFORMED');
  }

  const iv = fromBase64OrThrow(record.iv);
  if (iv.length !== IV_BYTES) throw new EnvelopeError('MALFORMED');
  fromBase64OrThrow(record.ct);

  return { v: record.v, alg: record.alg, kid: record.kid, iv: record.iv, ct: record.ct };
}

/**
 * Encrypts a JSON-serialisable value.
 *
 * `location` is the storage key the envelope will be written under, and it is
 * authenticated rather than stored: moving the result elsewhere makes it
 * undecryptable.
 */
export async function seal(
  key: CryptoKey,
  keyId: string,
  location: string,
  value: unknown,
): Promise<CipherEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify({ value }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(keyId, location) },
    key,
    plaintext,
  );
  return {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALGORITHM,
    kid: keyId,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypts, or throws. There is no lenient path and no partial result.
 *
 * A caller that catches this must treat the value as unreadable rather than
 * absent: "I cannot read your workflows" and "you have no workflows" are
 * different answers and only one of them is safe to act on.
 */
export async function open(key: CryptoKey, location: string, stored: unknown): Promise<unknown> {
  const envelope = decodeEnvelope(stored);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64OrThrow(envelope.iv),
        additionalData: additionalData(envelope.kid, location),
      },
      key,
      fromBase64OrThrow(envelope.ct),
    );
  } catch {
    // Wrong key, tampered ciphertext, tampered IV, tampered key id and a
    // ciphertext copied from another key all arrive here, and the code
    // deliberately does not try to tell them apart: the distinctions are not
    // ones a caller may act on differently, and reporting "wrong key" versus
    // "tampered" is an oracle.
    throw new EnvelopeError('AUTHENTICATION_FAILED');
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as { value: unknown };
    return parsed.value;
  } catch {
    // Authenticated bytes that are not the JSON this module writes. Only
    // reachable through a key collision or a bug, and a refusal either way.
    throw new EnvelopeError('MALFORMED');
  }
}

/**
 * What the tag covers besides the ciphertext.
 *
 * The key id as well as the location, so an envelope cannot be replayed under
 * a different data key by editing `kid` — that edit changes the AAD and the
 * tag stops verifying.
 */
function additionalData(keyId: string, location: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`k1|${ENVELOPE_VERSION}|${keyId}|${location}`);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
  // `atob` accepts some strings that are not canonical base64, so the round
  // trip is checked rather than trusted.
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return toBase64(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function fromBase64OrThrow(value: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64(value);
  if (bytes === null) throw new EnvelopeError('MALFORMED');
  return bytes;
}
