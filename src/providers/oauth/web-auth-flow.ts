/**
 * `chrome.identity.launchWebAuthFlow`, behind the port the connectors use.
 *
 * ## Why this exists beside the tab-watching flow rather than replacing it
 *
 * `connectors/oauth/auth-flow-port.ts` opens the authorization page in a tab
 * and watches that tab, and its header explains at length why it does **not**
 * use `chrome.identity`. That reasoning stands, and every connector still uses
 * it: it needs no permission at all.
 *
 * It cannot be used for Google. Google registers exactly one redirect for a
 * Chrome Extension client — `https://<extension-id>.chromiumapp.org/` — and
 * that address resolves nowhere. A tab navigated to it does not land on a page
 * this extension can observe; only `launchWebAuthFlow` intercepts it. The
 * alternatives are both closed: `chrome-extension://` is not an accepted
 * Google redirect, and the loopback redirect belongs to desktop clients, which
 * Google's own Gemini OAuth guide pairs with a downloaded `client_secret.json`
 * this extension must never hold.
 *
 * So the choice is this port or no Google authorization, and the permission is
 * taken in the narrowest form available:
 *
 *  - **optional, not required.** `identity` is absent from the manifest's
 *    `permissions` and is requested the moment the user asks to connect
 *    Google. Chrome shows its own dialog, the user can decline, and the
 *    permission can be revoked afterwards. A user who never connects Google
 *    never grants it.
 *  - **`getAuthToken` is left without a client id.** That is the method the
 *    original objection was about — it can mint a token for the browser
 *    profile's own Google account — and it reads its client id and scopes from
 *    the manifest's `oauth2` key. This manifest declares none, so there is
 *    nothing for it to use. Asserted in real Chromium rather than argued.
 *
 * ## What this does not do
 *
 * It does not interact with the browser profile's Google account, read a
 * signed-in identity, or mint anything. It opens a window at a URL and returns
 * the URL Chrome was redirected to. Everything that makes that URL meaningful
 * — the state check, the PKCE verifier, the exact-match on the redirect — is
 * in `google-provider-auth.ts`, which treats what comes back as untrusted.
 */

import { getLogger } from '@/logging/logger';
import { isCallbackUrl } from '@/connectors/oauth/oauth-flow';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';

const log = getLogger('security');

/** The one method this needs, named so a test can supply it. */
export interface WebAuthFlowLike {
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
}

/** The permission a Google authorization needs, and the only one. */
export const IDENTITY_PERMISSION = 'identity' as const;

/**
 * The permission surface this needs, for the same reason.
 *
 * The request is typed to the one permission this module may ask for, so there
 * is no shape in which it could ask for another — a port taking `string[]`
 * would make "it only requests `identity`" a convention rather than a type.
 * Declared with method syntax so Chrome's own overloaded signatures satisfy it
 * without a cast at the call site.
 */
export interface PermissionsLike {
  contains(permissions: { permissions: [typeof IDENTITY_PERMISSION] }): Promise<boolean>;
  request(permissions: { permissions: [typeof IDENTITY_PERMISSION] }): Promise<boolean>;
}

/**
 * Asks for the optional `identity` permission, once, and only when needed.
 *
 * Checked before it is requested so a user who already granted it is not shown
 * a dialog again. The request must be made from a user gesture, which is why
 * the panel's button is what reaches this rather than anything on a timer or a
 * restore path — a request made without a gesture is refused by Chrome, and a
 * refusal would read to the user as a bug.
 */
export async function ensureIdentityPermission(permissions: PermissionsLike): Promise<boolean> {
  try {
    if (await permissions.contains({ permissions: [IDENTITY_PERMISSION] })) return true;
  } catch {
    // A browser that cannot answer the question is treated as not having
    // granted it, and the request below is what settles it.
  }
  try {
    return await permissions.request({ permissions: [IDENTITY_PERMISSION] });
  } catch {
    return false;
  }
}

/** Whether the permission is held, without asking for it. */
export async function hasIdentityPermission(permissions: PermissionsLike): Promise<boolean> {
  try {
    return await permissions.contains({ permissions: [IDENTITY_PERMISSION] });
  } catch {
    return false;
  }
}

export class WebAuthFlow implements AuthFlowPort {
  constructor(private readonly identity: WebAuthFlowLike) {}

  async run(
    request: { authorizationUrl: string; redirectUri: string; timeoutMs: number },
    signal: AbortSignal,
  ): Promise<AuthFlowOutcome> {
    if (signal.aborted) {
      return { kind: 'cancelled', reason: 'The authorization was cancelled before it started.' };
    }

    let redirected: string | undefined;
    try {
      // `interactive: true` because the point is for the user to see Google's
      // consent screen. Chrome owns the window and closes it on redirect; this
      // extension never gets a handle on it, which is one fewer thing that can
      // be left open on a failure path.
      redirected = await this.identity.launchWebAuthFlow({
        url: request.authorizationUrl,
        interactive: true,
      });
    } catch (error) {
      // Chrome rejects for every ordinary refusal: the window closed, the user
      // declined, the permission is absent. None of them is exceptional and
      // none should surface as a crash.
      log.info('A web auth flow did not complete.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { kind: 'cancelled', reason: 'The authorization window was closed.' };
    }

    if (redirected === undefined || redirected.length === 0) {
      return { kind: 'cancelled', reason: 'The authorization window returned nothing.' };
    }
    // Checked here as well as in the caller. Chrome only resolves on a URL
    // matching the extension's own virtual redirect, so this should always
    // hold — and a port that returned an arbitrary URL as a callback would be
    // handing the caller something it is entitled to assume about.
    if (!isCallbackUrl(redirected, request.redirectUri)) {
      return {
        kind: 'cancelled',
        reason: 'The authorization returned to an unexpected address.',
      };
    }
    return { kind: 'callback', url: redirected };
  }
}
