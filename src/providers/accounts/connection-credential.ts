/**
 * The credential for one connection, whatever shape it is in.
 *
 * A pasted account holds a key. An account authorized with Google holds a
 * record of tokens, and the access token expires — typically within the hour.
 * This is the one place that difference is resolved, so every caller (the
 * brain resolver, discovery, the capability doctor, the account store's own
 * disconnect path) gets a usable credential or `undefined`, and none of them
 * has to know which kind it was.
 *
 * ## Why it lives here rather than in the worker
 *
 * It was written in the worker first, where nothing could reach it. The three
 * decisions below are the ones worth getting right, and each is a behaviour a
 * test should be able to drive directly:
 *
 *  - **a token near expiry is renewed before it is used**, not after a request
 *    has already failed with it;
 *  - **a renewal that fails is not retried.** A revoked grant does not become
 *    valid by being asked again, and a loop against one is how a client earns
 *    a rate limit;
 *  - **a failure returns `undefined` rather than throwing.** The caller's own
 *    refusal is "no credential on this device", which is the truth and sends
 *    the user to re-authorize, rather than a network error that invites a
 *    retry against a grant that is gone.
 *
 * The renewed token is written back, so one expiry costs one renewal rather
 * than one per request.
 */

import type { StoredOAuthTokens } from '@/config/settings';

/** What a renewal returns: a new token, or a refusal that is final. */
export type RenewOutcome =
  { readonly ok: true; readonly tokens: StoredOAuthTokens } | { readonly ok: false };

export interface ConnectionCredentialDeps {
  /** The pasted key for a connection, or `undefined`. */
  readonly keyFor: (connectionId: string) => Promise<string | undefined>;
  /** The OAuth record for a connection, or `undefined`. */
  readonly tokensFor: (connectionId: string) => Promise<StoredOAuthTokens | undefined>;
  /** Persists a renewed record, so one expiry costs one renewal. */
  readonly storeTokens: (connectionId: string, tokens: StoredOAuthTokens) => Promise<void>;
  /** Exchanges a refresh token for a new access token. */
  readonly renew: (refreshToken: string) => Promise<RenewOutcome>;
  /** Whether this record needs renewing now. */
  readonly needsRenewal: (tokens: StoredOAuthTokens) => boolean;
  /**
   * Called when an authorization can no longer produce a credential.
   *
   * Optional, and the reason it exists is state consistency rather than
   * reporting: without it the panel goes on showing an account as connected
   * while every request refuses, because the worker learned something it never
   * wrote down. The message is the one a person can act on.
   *
   * Awaited, so a caller that records it has recorded it before the refusal
   * reaches the user — a refusal that arrives before the status it explains
   * reads as two unrelated problems.
   */
  readonly onUnusable?: (connectionId: string, reason: string) => Promise<void>;
}

export async function credentialForConnection(
  connectionId: string,
  deps: ConnectionCredentialDeps,
): Promise<string | undefined> {
  const tokens = await deps.tokensFor(connectionId);
  // No OAuth record means a pasted key, which is the overwhelmingly common
  // case and costs one read.
  if (tokens === undefined) return deps.keyFor(connectionId);

  if (!deps.needsRenewal(tokens)) return tokens.accessToken;

  if (tokens.refreshToken === undefined) {
    // Google issues no refresh token when the user has consented before and
    // the request did not force the screen. The access token is spent and the
    // honest state is that this connection needs authorizing again — which is
    // what `undefined` tells the caller.
    await deps.onUnusable?.(
      connectionId,
      'This authorization has expired and came without a renewal token. Connect the Google ' +
        'account again.',
    );
    return undefined;
  }

  const renewed = await deps.renew(tokens.refreshToken);
  if (!renewed.ok) {
    await deps.onUnusable?.(
      connectionId,
      'Google would not renew this authorization — it may have been revoked. Connect the ' +
        'Google account again.',
    );
    return undefined;
  }

  await deps.storeTokens(connectionId, renewed.tokens);
  return renewed.tokens.accessToken;
}
