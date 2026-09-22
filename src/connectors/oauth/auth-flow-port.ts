/**
 * Driving the user through a provider's authorization page.
 *
 * **Why not `chrome.identity`.** `launchWebAuthFlow` is the obvious answer
 * and it was not taken. It requires the `identity` permission, and that same
 * permission also unlocks `chrome.identity.getAuthToken`, which can mint a
 * token for the *browser profile's own signed-in account*. Adding a
 * permission whose main documented use is one this extension must never
 * perform, in order to get a window-opening convenience, is the wrong trade.
 *
 * What is used instead needs no new permission at all. The extension already
 * holds `tabs`, so it opens the authorization page in a tab it created and
 * watches that one tab for the redirect. This is what `launchWebAuthFlow`
 * does internally, minus the permission and minus the account-token API that
 * comes attached to it.
 *
 * Two properties make the watching safe. Only the tab this flow opened is
 * observed, so another tab reaching a similar URL is invisible to it. And a
 * navigation counts as the callback only when its origin *and* path match the
 * registered redirect URI exactly — a prefix match would accept
 * `https://redirect.example.attacker.test/`.
 *
 * **Known limitation.** A `chrome-extension://` or loopback redirect URI works
 * here, and so does any https URI the service will register. Services that
 * only accept a redirect through their own SDK, or that refuse every URI this
 * extension can register, cannot be connected this way — that is recorded in
 * the connector documentation rather than worked around.
 */

import { getLogger } from '@/logging/logger';
import { isCallbackUrl } from './oauth-flow';

const log = getLogger('security');

export type AuthFlowOutcome =
  | { readonly kind: 'callback'; readonly url: string }
  | { readonly kind: 'cancelled'; readonly reason: string };

export interface AuthFlowRequest {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly timeoutMs: number;
}

export interface AuthFlowPort {
  /** Opens the authorization page and resolves when it redirects, or does not. */
  run(request: AuthFlowRequest, signal: AbortSignal): Promise<AuthFlowOutcome>;
}

/** The Chrome APIs this flow needs, named so a test can supply them. */
export interface TabsLike {
  create(options: {
    url: string;
    active: boolean;
  }): Promise<{ id?: number | undefined; url?: string | undefined }>;
  remove(tabId: number): Promise<void>;
  onUpdated: {
    addListener(listener: TabUpdateListener): void;
    removeListener(listener: TabUpdateListener): void;
  };
  onRemoved: {
    addListener(listener: TabRemovedListener): void;
    removeListener(listener: TabRemovedListener): void;
  };
}

export type TabUpdateListener = (
  tabId: number,
  changeInfo: { url?: string; status?: string },
  tab: { url?: string; pendingUrl?: string },
) => void;

export type TabRemovedListener = (tabId: number) => void;

export class TabAuthFlow implements AuthFlowPort {
  constructor(private readonly tabs: TabsLike) {}

  async run(request: AuthFlowRequest, signal: AbortSignal): Promise<AuthFlowOutcome> {
    const tab = await this.tabs.create({ url: request.authorizationUrl, active: true });
    const tabId = tab.id;
    if (tabId === undefined) {
      return { kind: 'cancelled', reason: 'The authorization page could not be opened.' };
    }

    return await new Promise<AuthFlowOutcome>((resolve) => {
      let settled = false;

      const finish = (outcome: AuthFlowOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.tabs.onUpdated.removeListener(onUpdated);
        this.tabs.onRemoved.removeListener(onRemoved);
        signal.removeEventListener('abort', onAbort);
        // The tab has served its purpose, and leaving it open would leave a
        // URL containing an authorization code in the user's history view.
        void this.tabs.remove(tabId).catch(() => undefined);
        resolve(outcome);
      };

      const onUpdated: TabUpdateListener = (updatedId, changeInfo, updated) => {
        // Only the tab this flow opened. Another tab reaching a similar URL
        // is not this authorization, and treating it as one would let any
        // page complete a pending flow by navigating itself.
        if (updatedId !== tabId) return;
        const candidate = changeInfo.url ?? updated.url ?? updated.pendingUrl;
        if (candidate === undefined) return;
        if (!isCallbackUrl(candidate, request.redirectUri)) return;
        finish({ kind: 'callback', url: candidate });
      };

      const onRemoved: TabRemovedListener = (removedId) => {
        // Closing the window is how a person says no.
        if (removedId === tabId) {
          finish({ kind: 'cancelled', reason: 'The authorization window was closed.' });
        }
      };

      const onAbort = (): void => {
        finish({ kind: 'cancelled', reason: 'The authorization was cancelled.' });
      };

      const timer = setTimeout(() => {
        log.info('An authorization flow timed out.', { timeoutMs: request.timeoutMs });
        finish({ kind: 'cancelled', reason: 'The authorization took too long.' });
      }, request.timeoutMs);

      signal.addEventListener('abort', onAbort, { once: true });
      this.tabs.onUpdated.addListener(onUpdated);
      this.tabs.onRemoved.addListener(onRemoved);
    });
  }
}

/** The real Chrome tab surface, adapted to `TabsLike`. */
export function chromeTabs(): TabsLike {
  return {
    create: (options) => chrome.tabs.create(options),
    remove: (tabId) => chrome.tabs.remove(tabId),
    onUpdated: {
      addListener: (listener) =>
        chrome.tabs.onUpdated.addListener(
          listener as unknown as Parameters<typeof chrome.tabs.onUpdated.addListener>[0],
        ),
      removeListener: (listener) =>
        chrome.tabs.onUpdated.removeListener(
          listener as unknown as Parameters<typeof chrome.tabs.onUpdated.removeListener>[0],
        ),
    },
    onRemoved: {
      addListener: (listener) => chrome.tabs.onRemoved.addListener(listener),
      removeListener: (listener) => chrome.tabs.onRemoved.removeListener(listener),
    },
  };
}

/** A flow that refuses, for a connector built without one. */
export function refusingAuthFlow(): AuthFlowPort {
  return {
    run: () =>
      Promise.resolve({
        kind: 'cancelled',
        reason: 'This connector was built without a way to open an authorization page.',
      }),
  };
}
