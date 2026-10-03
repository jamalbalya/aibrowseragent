/**
 * Withdrawing a Google authorization at Google, when an account is disconnected.
 *
 * ## The gap this closes
 *
 * `authorization.ts` has declared `revokeEndpoint: 'https://oauth2.googleapis.com/revoke'`
 * since the Google provider flow was built, and **nothing ever read it**. It
 * appeared exactly once in the repository: in its own declaration.
 *
 * So `accounts.disconnect` deleted the stored tokens and stopped there. For a
 * pasted key that is the whole story — there is nothing at the far end to tell.
 * For an authorization it is not: the refresh token was destroyed locally, so
 * this build could no longer use the grant, while the user's Google account
 * went on listing the extension as authorized indefinitely. A person who
 * pressed *Disconnect* to withdraw access had not withdrawn it.
 *
 * ## Why the ordering is the whole design
 *
 * Revocation needs the token, and disconnecting destroys it. So the attempt
 * happens **first**, and the local removal happens regardless of how it went:
 *
 *  - **A disconnect always disconnects.** If Google is unreachable, refuses, or
 *    takes too long, the credential is still deleted. The alternative — a
 *    person unable to disconnect because a third party is down — is worse than
 *    a grant that outlives its tokens, and it is the user's own machine.
 *  - **One attempt, never retried.** A revoked grant does not become more
 *    revoked by asking twice, and the token is gone locally either way, so a
 *    retry has nothing to retry with.
 *  - **The refresh token is what is sent.** Google's endpoint accepts either
 *    token and revoking a refresh token revokes the access tokens derived from
 *    it; revoking only an access token would leave the grant alive.
 *
 * ## What this is not
 *
 * It is not a security control, and it must not be read as one. The security
 * boundary is the deleted credential: after a disconnect this build holds
 * nothing it could use. Revocation is a courtesy to the user's Google account
 * — and an honest one, because *Disconnect* implies it.
 */

import type { StoredOAuthTokens } from '@/config/settings';
import type { ConnectedAccount } from './account-model';

/** What a revocation attempt needs from the worker. */
export interface RevokeDeps {
  /** The stored authorization for this connection, or `undefined`. */
  readonly tokensFor: (connectionId: string) => Promise<StoredOAuthTokens | undefined>;
  /**
   * Posts a form body to the provider's revocation endpoint.
   *
   * Supplied rather than performed here so this decision can be driven by a
   * test, and so the request goes through the worker's guarded transport on
   * the `provider_auth` egress channel like every other authorization call.
   */
  readonly post: (body: string) => Promise<{ readonly status: number }>;
}

export type RevokeOutcome =
  /** Not an authorization: a pasted key has nothing to revoke. */
  | { readonly attempted: false; readonly reason: 'not_an_authorization' }
  /** An authorization with no token left to revoke with. */
  | { readonly attempted: false; readonly reason: 'no_token' }
  /** Asked, and Google accepted. */
  | { readonly attempted: true; readonly revoked: true }
  /** Asked, and it did not work. The disconnect proceeds anyway. */
  | { readonly attempted: true; readonly revoked: false; readonly status: number | null };

/**
 * The form body Google's revocation endpoint expects.
 *
 * `application/x-www-form-urlencoded` with a single `token` field, which is
 * what the endpoint documents. Encoded with `URLSearchParams` so a token
 * containing a reserved character cannot change the shape of the request.
 */
export function revocationBody(token: string): string {
  return new URLSearchParams({ token }).toString();
}

/**
 * Tries to withdraw the grant, and reports what happened.
 *
 * Never throws: a caller is in the middle of a disconnect and must finish it.
 */
export async function revokeAuthorization(
  account: Pick<ConnectedAccount, 'connectionId' | 'authKind'>,
  deps: RevokeDeps,
): Promise<RevokeOutcome> {
  if (account.authKind !== 'oauth2') {
    return { attempted: false, reason: 'not_an_authorization' };
  }

  let tokens: StoredOAuthTokens | undefined;
  try {
    tokens = await deps.tokensFor(account.connectionId);
  } catch {
    // A credential store that cannot be read is not a reason to block a
    // disconnect.
    return { attempted: false, reason: 'no_token' };
  }

  // The refresh token first, because revoking it takes the access tokens with
  // it. An authorization that came without one still has an access token worth
  // revoking.
  const token = tokens?.refreshToken ?? tokens?.accessToken ?? '';
  if (token.length === 0) return { attempted: false, reason: 'no_token' };

  try {
    const { status } = await deps.post(revocationBody(token));
    // Google answers 200 for a successful revocation. A 400 means the token
    // was already invalid, which is the same end state from the user's point
    // of view, so it is not reported as a failure to act on.
    return status === 200 || status === 400
      ? { attempted: true, revoked: true }
      : { attempted: true, revoked: false, status };
  } catch {
    return { attempted: true, revoked: false, status: null };
  }
}
