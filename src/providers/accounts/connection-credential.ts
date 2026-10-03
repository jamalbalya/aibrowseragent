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
 *  - **"near expiry" is the caller's question, not this module's.** A caller
 *    says how long it still needs the credential for, because a token with
 *    five minutes left is fine for one request and not for a task allowed to
 *    run for ten minutes on a credential resolved once at the start;
 *  - **that horizon can cause a renewal and never a refusal.** A token that
 *    cannot cover the work ahead but answers requests today is still handed
 *    over; marking the account disconnected over work that has not happened
 *    yet would take away an account that works;
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
  /**
   * Whether this record needs renewing to stay usable for `mustOutlastMs`.
   *
   * The horizon is passed rather than baked in because the caller is the only
   * one who knows how long it needs the credential to keep working. See
   * `needsRefresh`.
   */
  readonly needsRenewal: (tokens: StoredOAuthTokens, mustOutlastMs: number) => boolean;
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

export interface ConnectionCredentialOptions {
  /**
   * How long the credential still has to work for, in milliseconds.
   *
   * Zero — the default — asks only that it works now, which is the right
   * question for one request. A task resolves its credential once and is then
   * allowed to run for its whole budget, so it asks for that budget.
   */
  readonly mustOutlastMs?: number;
}

export async function credentialForConnection(
  connectionId: string,
  deps: ConnectionCredentialDeps,
  options: ConnectionCredentialOptions = {},
): Promise<string | undefined> {
  const mustOutlastMs = options.mustOutlastMs ?? 0;
  const tokens = await deps.tokensFor(connectionId);
  // No OAuth record means a pasted key, which is the overwhelmingly common
  // case and costs one read.
  if (tokens === undefined) return deps.keyFor(connectionId);

  if (!deps.needsRenewal(tokens, mustOutlastMs)) return tokens.accessToken;

  if (tokens.refreshToken === undefined) {
    // Google issues no refresh token when the user has consented before and
    // the request did not force the screen.
    //
    // Nothing can extend this token, so the horizon must not decide the
    // outcome here. A token with five minutes left cannot cover a ten-minute
    // budget, and it can still answer the next request perfectly well —
    // marking the account disconnected over work that has not happened yet
    // would take away an account that works. Only a token that is spent
    // *now* is a refusal, which is what `undefined` tells the caller.
    if (!deps.needsRenewal(tokens, 0)) return tokens.accessToken;
    await deps.onUnusable?.(
      connectionId,
      'This authorization has expired and came without a renewal token. Connect the Google ' +
        'account again.',
    );
    return undefined;
  }

  const renewed = await deps.renew(tokens.refreshToken);
  if (!renewed.ok) {
    // Same rule as above, and it matters more here: the long horizon makes
    // renewals happen earlier, so a refusal — which cannot tell a revoked
    // grant from a lost network — would start reaching tokens that are still
    // good. The horizon may cause a renewal; it must never cause a refusal.
    if (!deps.needsRenewal(tokens, 0)) return tokens.accessToken;
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
