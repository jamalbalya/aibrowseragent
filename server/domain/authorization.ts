/**
 * Who a request acts as, and what that permits.
 *
 * One rule, and it is the whole of backend authorization at this layer:
 *
 * > `abaUserId` comes from the **session**. It is never read from a request
 * > body, a path parameter, a query string or a header.
 *
 * The mechanism is the `Principal` type. There is no constructor for one that
 * takes a caller-supplied user id — `principalFromSession` is the only way to
 * obtain one, and it derives the id from a session row the store returned.
 * Every service operation takes a `Principal`, so "the client supplied its own
 * user id" is not a mistake that can be made: there is no parameter for it
 * (AUTH-8).
 *
 * A second rule follows from the first and is just as load-bearing: a resource
 * belonging to another account is `NOT_FOUND`, identically to one that does
 * not exist. An authorization error that is distinguishable from a missing
 * resource is an existence oracle, and it is the shape of leak that survives
 * review because it looks like good error reporting.
 */
import { fail, ok, type Result } from './errors';
import type { AbaUserRow, SessionRow } from '../db/store';

/**
 * An authenticated caller.
 *
 * `readonly` and structurally opaque: the brand makes an object literal with
 * the right shape unusable where a `Principal` is expected, so a test — or a
 * future transport — cannot fabricate one from request input without going
 * through session verification.
 */
export interface Principal {
  readonly abaUserId: string;
  readonly sessionId: string;
  /** Which identity established the session, when one is recorded. */
  readonly authIdentityId: string | null;
  readonly __brand: 'Principal';
}

/**
 * Builds a principal from a verified session and its account.
 *
 * Both are required, and the account check is not a formality: a session row
 * can outlive the account it names by the width of one deletion, and a
 * deleted account must never authorise anything — that is the difference
 * between an outage and a revocation which `AUTH-14` exists to keep
 * (IDENTITY_AUTH_ARCHITECTURE §9.1).
 */
export function principalFromSession(session: SessionRow, user: AbaUserRow): Result<Principal> {
  if (user.state === 'deleted') return fail('ACCOUNT_DELETED');
  if (user.id !== session.aba_user_id) {
    // Defence in depth. The store cannot produce this pairing, and if it ever
    // did, continuing would mean acting for one account under another's
    // session.
    return fail('AUTH_REQUIRED');
  }
  return ok({
    abaUserId: session.aba_user_id,
    sessionId: session.id,
    authIdentityId: session.auth_identity_id,
    __brand: 'Principal',
  });
}

/** Does this principal own this resource? */
export function owns(principal: Principal, resource: { readonly aba_user_id: string }): boolean {
  return principal.abaUserId === resource.aba_user_id;
}

/**
 * Returns the resource when the principal owns it, and `NOT_FOUND` otherwise —
 * whether it belongs to someone else or does not exist at all.
 */
export function requireOwned<T extends { readonly aba_user_id: string }>(
  principal: Principal,
  resource: T | null,
): Result<T> {
  if (resource === null || !owns(principal, resource)) return fail('NOT_FOUND');
  return ok(resource);
}
