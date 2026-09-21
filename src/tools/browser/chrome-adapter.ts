/**
 * Chrome API adapter (specification section 92).
 *
 * Every Chrome API the tools need sits behind this interface. That keeps the
 * Chrome-specific surface in one file, makes the tools unit-testable without a
 * browser, and leaves room for a future desktop or cloud browser runtime to
 * supply a different implementation.
 */
import { sendToContent } from '@/messaging/bus';
import type { ContentRequest, ContentRequestType, ContentResponse } from '@/messaging/protocol';

export interface TabInfo {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly windowId: number;
  readonly index: number;
  readonly status: string;
  readonly groupId: number;
}

export interface CreateTabOptions {
  readonly url: string;
  readonly active?: boolean;
  readonly windowId?: number;
}

/**
 * The browser surface the tools depend on.
 * Implemented by `ChromeBrowserAdapter` in the extension, and by a fake in tests.
 */
export interface BrowserAdapter {
  listTabs(): Promise<TabInfo[]>;
  getTab(tabId: number): Promise<TabInfo | null>;
  getActiveTab(): Promise<TabInfo | null>;
  createTab(options: CreateTabOptions): Promise<TabInfo>;
  closeTab(tabId: number): Promise<void>;
  activateTab(tabId: number): Promise<TabInfo>;
  reloadTab(tabId: number): Promise<void>;
  navigate(tabId: number, url: string): Promise<void>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;
  /** Resolves once the tab reaches `complete`, or rejects on timeout. */
  waitForLoad(tabId: number, timeoutMs: number): Promise<TabInfo>;
  captureVisibleTab(windowId: number): Promise<{ dataUrl: string }>;
  groupTabs(tabIds: readonly number[], title?: string): Promise<number>;
  ungroupTabs(tabIds: readonly number[]): Promise<void>;
  moveTab(tabId: number, index: number): Promise<void>;
  /** Ensures the content script is present, injecting it if needed. */
  ensureContentScript(tabId: number): Promise<void>;
  callContent<T extends ContentRequestType>(
    tabId: number,
    type: T,
    payload: ContentRequest<T>,
    timeoutMs?: number,
  ): Promise<ContentResponse<T>>;
}

/**
 * Narrows a list to the non-empty tuple the tab-group APIs require.
 * Callers validate `min(1)` in their schema; this makes that fact visible to
 * the type system rather than asserting it away.
 */
function toNonEmpty(tabIds: readonly number[]): [number, ...number[]] {
  const [first, ...rest] = tabIds;
  if (first === undefined) {
    throw new Error('At least one tab id is required.');
  }
  return [first, ...rest];
}

function toTabInfo(tab: chrome.tabs.Tab): TabInfo {
  return {
    id: tab.id ?? -1,
    url: tab.url ?? tab.pendingUrl ?? '',
    title: tab.title ?? '',
    active: tab.active,
    windowId: tab.windowId,
    index: tab.index,
    status: tab.status ?? 'unknown',
    groupId: tab.groupId ?? -1,
  };
}

export class ChromeBrowserAdapter implements BrowserAdapter {
  async listTabs(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.id !== undefined).map(toTabInfo);
  }

  async getTab(tabId: number): Promise<TabInfo | null> {
    try {
      return toTabInfo(await chrome.tabs.get(tabId));
    } catch {
      return null;
    }
  }

  async getActiveTab(): Promise<TabInfo | null> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id === undefined ? null : toTabInfo(tab);
  }

  async createTab(options: CreateTabOptions): Promise<TabInfo> {
    const tab = await chrome.tabs.create({
      url: options.url,
      active: options.active ?? false,
      ...(options.windowId === undefined ? {} : { windowId: options.windowId }),
    });
    return toTabInfo(tab);
  }

  async closeTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
  }

  async activateTab(tabId: number): Promise<TabInfo> {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (!tab) throw new Error(`Tab ${tabId} could not be activated.`);
    await chrome.windows.update(tab.windowId, { focused: true });
    return toTabInfo(tab);
  }

  async reloadTab(tabId: number): Promise<void> {
    await chrome.tabs.reload(tabId);
  }

  async navigate(tabId: number, url: string): Promise<void> {
    await chrome.tabs.update(tabId, { url });
  }

  async goBack(tabId: number): Promise<void> {
    await chrome.tabs.goBack(tabId);
  }

  async goForward(tabId: number): Promise<void> {
    await chrome.tabs.goForward(tabId);
  }

  /**
   * Waits for a tab to finish loading.
   *
   * Uses the `onUpdated` event rather than polling, and registers the listener
   * before the status re-check so a load that completes in between is not
   * missed.
   */
  waitForLoad(tabId: number, timeoutMs: number): Promise<TabInfo> {
    return new Promise<TabInfo>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        fn();
      };

      const onUpdated = (
        updatedTabId: number,
        changeInfo: chrome.tabs.OnUpdatedInfo,
        tab: chrome.tabs.Tab,
      ): void => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
        finish(() => resolve(toTabInfo(tab)));
      };

      const onRemoved = (removedTabId: number): void => {
        if (removedTabId !== tabId) return;
        finish(() => reject(new Error(`Tab ${tabId} was closed while loading.`)));
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Tab ${tabId} did not finish loading in ${timeoutMs}ms.`)));
      }, timeoutMs);

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);

      // Re-check after registering, in case the load already finished.
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === 'complete') finish(() => resolve(toTabInfo(tab)));
        },
        () => finish(() => reject(new Error(`Tab ${tabId} does not exist.`))),
      );
    });
  }

  async captureVisibleTab(windowId: number): Promise<{ dataUrl: string }> {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: 'png',
    });
    return { dataUrl };
  }

  async groupTabs(tabIds: readonly number[], title?: string): Promise<number> {
    const groupId = await chrome.tabs.group({ tabIds: toNonEmpty(tabIds) });
    if (title !== undefined) {
      await chrome.tabGroups.update(groupId, { title });
    }
    return groupId;
  }

  async ungroupTabs(tabIds: readonly number[]): Promise<void> {
    await chrome.tabs.ungroup(toNonEmpty(tabIds));
  }

  async moveTab(tabId: number, index: number): Promise<void> {
    await chrome.tabs.move(tabId, { index });
  }

  /**
   * Makes sure the content script is running in a tab.
   *
   * The manifest registers it at `document_idle`, but a tab that was already
   * open when the extension loaded has no script, so it is injected on demand.
   */
  async ensureContentScript(tabId: number): Promise<void> {
    try {
      await sendToContent(tabId, 'content.ping', {}, { timeoutMs: 1500 });
      return;
    } catch {
      // Not present; fall through to injection.
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
    await sendToContent(tabId, 'content.ping', {}, { timeoutMs: 3000 });
  }

  callContent<T extends ContentRequestType>(
    tabId: number,
    type: T,
    payload: ContentRequest<T>,
    timeoutMs?: number,
  ): Promise<ContentResponse<T>> {
    return sendToContent(tabId, type, payload, timeoutMs === undefined ? {} : { timeoutMs });
  }
}
