/**
 * TEST-SECURITY-081 — withdrawing an authorization when an account is
 * disconnected.
 *
 * `authorization.ts` declared `revokeEndpoint` from the day the Google
 * provider flow was built, and nothing read it: the constant appeared exactly
 * once in the repository, in its own declaration. So `accounts.disconnect`
 * deleted the stored tokens and told Google nothing. For a pasted key that is
 * the whole story. For an authorization it was not — the refresh token was
 * destroyed locally, so this build could no longer use the grant, while the
 * user's Google account went on listing the extension as authorized. Somebody
 * who pressed *Disconnect* to withdraw access had not withdrawn it.
 *
 * These cases are about the two things that can go wrong once it is wired:
 * revoking the wrong thing, and letting a third party stop a person
 * disconnecting.
 */
import { describe, expect, it } from 'vitest';
import {
  revocationBody,
  revokeAuthorization,
  type RevokeDeps,
} from '@/providers/accounts/revoke-authorization';
import { GOOGLE_AUTH } from '@/providers/accounts/authorization';
import type { StoredOAuthTokens } from '@/config/settings';

/** Not credentials: fixed literals that authenticate nothing. */
const ACCESS = 'access-token-under-test';
const REFRESH = 'refresh-token-under-test';

const oauthAccount = { connectionId: 'conn_1', authKind: 'oauth2' as const };
const keyAccount = { connectionId: 'conn_2', authKind: 'api_key' as const };

function deps(
  tokens: StoredOAuthTokens | undefined,
  reply: { status: number } | Error = { status: 200 },
): RevokeDeps & { posted: string[] } {
  const posted: string[] = [];
  return {
    posted,
    tokensFor: () => Promise.resolve(tokens),
    post: (body) => {
      posted.push(body);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
}

describe('the endpoint that was declared and never called', () => {
  it('is the one this uses', () => {
    // The point of the fix: the constant stops being decoration.
    expect(GOOGLE_AUTH.revokeEndpoint).toBe('https://oauth2.googleapis.com/revoke');
  });

  it('sends the token as a form field, encoded', () => {
    // `URLSearchParams` rather than string concatenation, so a token holding a
    // reserved character cannot change the shape of the request.
    expect(revocationBody('abc')).toBe('token=abc');
    expect(revocationBody('a&b=c d/+')).toBe('token=a%26b%3Dc+d%2F%2B');
  });
});

describe('what gets revoked', () => {
  it('sends the refresh token, because that takes the access tokens with it', async () => {
    const d = deps({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scope: 's' });
    const outcome = await revokeAuthorization(oauthAccount, d);
    expect(outcome).toEqual({ attempted: true, revoked: true });
    expect(d.posted).toEqual([`token=${REFRESH}`]);
    // Revoking only the access token would leave the grant alive, which is the
    // mistake worth pinning rather than describing.
    expect(d.posted[0]).not.toContain(ACCESS);
  });

  it('falls back to the access token when no refresh token was issued', async () => {
    // Google issues none when the user has consented before and the request
    // did not force the screen. There is still a grant worth withdrawing.
    const d = deps({ accessToken: ACCESS, expiresAt: 0, scope: 's' });
    expect(await revokeAuthorization(oauthAccount, d)).toEqual({ attempted: true, revoked: true });
    expect(d.posted).toEqual([`token=${ACCESS}`]);
  });

  it('asks nothing for a pasted key, which has no far end to tell', async () => {
    const d = deps({ accessToken: ACCESS, expiresAt: 0, scope: 's' });
    expect(await revokeAuthorization(keyAccount, d)).toEqual({
      attempted: false,
      reason: 'not_an_authorization',
    });
    expect(d.posted).toEqual([]);
  });

  it('asks nothing when there is no token left', async () => {
    for (const tokens of [undefined, { accessToken: '', expiresAt: 0, scope: 's' }]) {
      const d = deps(tokens);
      expect(await revokeAuthorization(oauthAccount, d)).toEqual({
        attempted: false,
        reason: 'no_token',
      });
      expect(d.posted).toEqual([]);
    }
  });
});

describe('a disconnect always disconnects', () => {
  /**
   * The rule that matters more than the revocation. A person asking to
   * withdraw access must not be prevented by the state of a third party, and
   * the security boundary is the deleted credential rather than the grant: a
   * build holding nothing cannot use anything. So every failure below is
   * **reported** and none of them throws.
   */
  it('reports a refusal rather than throwing', async () => {
    const d = deps(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scope: 's' },
      {
        status: 503,
      },
    );
    expect(await revokeAuthorization(oauthAccount, d)).toEqual({
      attempted: true,
      revoked: false,
      status: 503,
    });
  });

  it('reports an unreachable provider rather than throwing', async () => {
    const d = deps(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scope: 's' },
      new Error('network'),
    );
    expect(await revokeAuthorization(oauthAccount, d)).toEqual({
      attempted: true,
      revoked: false,
      status: null,
    });
  });

  it('treats an already-invalid token as withdrawn, because it is', async () => {
    // Google answers 400 for a token it does not recognise. From the user's
    // point of view that is the end state they asked for, so it is not
    // reported as something to act on.
    const d = deps(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scope: 's' },
      {
        status: 400,
      },
    );
    expect(await revokeAuthorization(oauthAccount, d)).toEqual({ attempted: true, revoked: true });
  });

  it('survives a credential store that cannot be read', async () => {
    const outcome = await revokeAuthorization(oauthAccount, {
      tokensFor: () => Promise.reject(new Error('storage')),
      post: () => Promise.reject(new Error('should not be reached')),
    });
    expect(outcome).toEqual({ attempted: false, reason: 'no_token' });
  });
});

describe('the outcome carries no credential', () => {
  it('names a status and never a token', async () => {
    const d = deps(
      { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 0, scope: 's' },
      {
        status: 503,
      },
    );
    const outcome = await revokeAuthorization(oauthAccount, d);
    // The worker logs this object when the attempt failed, so it is the one
    // place a token would escape into a log.
    const serialised = JSON.stringify(outcome);
    expect(serialised).not.toContain(REFRESH);
    expect(serialised).not.toContain(ACCESS);
  });
});
