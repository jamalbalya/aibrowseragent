/**
 * Server-generated identifiers.
 *
 * Every id here is minted by the backend from the platform CSPRNG and is
 * **opaque**: nothing about it is derived from, or reveals, the values the
 * architecture forbids as identity inputs — an email address, a Google
 * subject, a device id, a Chrome runtime handle, a provider connection id, or
 * any K1 key material (AUTH-1, AUTH-6, AUTH-7).
 *
 * That property is worth stating as a rule rather than a habit: a derived id
 * leaks its input, and an id derived from an email moves when the email moves,
 * which is precisely what `abaUserId` must not do.
 *
 * There is deliberately **no** function here that accepts a caller-supplied
 * value and returns an id. A client cannot choose its own `abaUserId` because
 * there is no parameter in which to offer one, in this module or in the
 * service that calls it.
 */

const PREFIXES = {
  user: 'usr',
  identity: 'aid',
  session: 'ses',
  family: 'fam',
  challenge: 'chl',
  /**
   * An email OTP challenge.
   *
   * A prefix of its own, although the value is minted exactly as a
   * `login_challenge` id is, because the two live in different stores with
   * different lifetimes: one is a row, the other is a transient in-memory
   * record that is never written anywhere. A shared prefix would make a log
   * line, a test fixture or a future reader unable to tell which of the two a
   * value came from, and "it is only ever in memory" is a claim worth being
   * able to check by looking.
   */
  otp: 'otp',
} as const;

export type IdKind = keyof typeof PREFIXES;

/** 128 bits of CSPRNG output, base32-ish lowercase hex. Opaque by construction. */
function randomSuffix(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomSuffix()}`;
}

export const newAbaUserId = (): string => newId('user');
export const newChallengeId = (): string => newId('challenge');
export const newOtpChallengeId = (): string => newId('otp');

/**
 * Opaque CSPRNG values that are not row identifiers.
 *
 * `state`, `nonce` and the one-time exchange code are all 256-bit secrets
 * rather than 128-bit labels, and they carry **no prefix**: a prefix tells a
 * reader what a value is for, which is helpful for an id in a log and
 * unhelpful for a secret in a URL.
 *
 * The exchange code in particular is deliberately not derived from, and
 * reveals nothing about, the account it will resolve to — the resolution is
 * held on the challenge row, not encoded in the code (§7.1).
 */
function opaqueSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const newState = (): string => opaqueSecret();
export const newNonce = (): string => opaqueSecret();
export const newExchangeCode = (): string => opaqueSecret();
export const newAuthIdentityId = (): string => newId('identity');
export const newSessionId = (): string => newId('session');
export const newSessionFamilyId = (): string => newId('family');

/**
 * Shape check for an id this server minted.
 *
 * Used when a value arrives from outside — a path parameter, a stored record
 * read back — so a malformed one is refused at the boundary rather than
 * becoming a lookup key that matches nothing and is reported as "not found".
 */
export function isServerId(kind: IdKind, value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${PREFIXES[kind]}_[0-9a-f]{32}$`).test(value);
}

/**
 * Shape check for a `deviceId`.
 *
 * Minted by the **client**, so the server validates rather than generates:
 * `dev_` plus a UUID, per K1 §16 and Cloud Sync §5. Validation is a shape
 * check and nothing more — a `deviceId` authorises nothing, so there is no
 * security decision resting on it (AUTH-20). What the check buys is that a
 * tab id, a window id or an extension id cannot be presented as one, because
 * none of them has this shape.
 */
const DEVICE_ID = /^dev_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value);
}
