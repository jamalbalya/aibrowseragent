/**
 * Domain failures, as values rather than exceptions.
 *
 * Every operation in `server/app` returns a result rather than throwing, so a
 * caller cannot forget to handle the failure case: the type will not let the
 * success value be read until the discriminant has been checked.
 *
 * **Codes are the safe vocabulary.** Each one is chosen so that the answer it
 * gives away is one the caller is already entitled to. Two rules shape the
 * list, both from IDENTITY_AUTH_ARCHITECTURE §24:
 *
 *  - a resource belonging to another account answers `NOT_FOUND`, identically
 *    to one that does not exist, so no error is an existence oracle (AUTH-8);
 *  - `IDENTITY_IN_USE` says that an identity is attached somewhere, and never
 *    which account holds it or that any particular account exists (AUTH-28).
 *
 * No message here is assembled from caller input, so no error can echo a value
 * back to whoever supplied it.
 */

export const DOMAIN_ERROR_CODES = [
  /** The resource does not exist, or belongs to someone else. Deliberately one code. */
  'NOT_FOUND',
  /** The session is absent, expired or revoked. */
  'AUTH_REQUIRED',
  /** A refresh token was presented after rotation. The family is revoked. */
  'SESSION_REVOKED',
  /** The account is deleted. Never presented as an outage (AUTH-14). */
  'ACCOUNT_DELETED',
  /** The identity is attached to some account. Never says which (AUTH-28). */
  'IDENTITY_IN_USE',
  /** Unlinking would leave the account with no verified way to sign in (AUTH-25). */
  'LAST_IDENTITY',
  /** The request is malformed — a bad id shape, an unverified address. */
  'INVALID_ARGUMENT',
  /** The device row is retired and must be reactivated first. */
  'DEVICE_RETIRED',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainError {
  readonly code: DomainErrorCode;
  /** Fixed text. Never interpolated from caller input. */
  readonly message: string;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DomainError };

const MESSAGES: Record<DomainErrorCode, string> = {
  NOT_FOUND: 'No such resource.',
  AUTH_REQUIRED: 'Sign in again to continue.',
  SESSION_REVOKED: 'You were signed out. Sign in again.',
  ACCOUNT_DELETED: 'This account no longer exists.',
  IDENTITY_IN_USE: 'That sign-in method is already used by another AI Browser Agent account.',
  LAST_IDENTITY: 'This is the only way you can sign in, so it cannot be removed.',
  INVALID_ARGUMENT: 'That request is not valid.',
  DEVICE_RETIRED: 'This device needs to be reactivated.',
};

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(code: DomainErrorCode): Result<T> {
  return { ok: false, error: { code, message: MESSAGES[code] } };
}
