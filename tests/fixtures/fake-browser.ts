/**
 * In-memory BrowserAdapter used by tool and integration tests.
 *
 * Models the parts of Chrome's tab behaviour the tools actually depend on:
 * tab identity, URL changes, load completion, and content-script dispatch.
 */
import type { BrowserAdapter, CreateTabOptions, TabInfo } from '@/tools/browser/chrome-adapter';
import type { ContentRequest, ContentRequestType, ContentResponse } from '@/messaging/protocol';
import { MessagingError } from '@/messaging/bus';
import { createError } from '@/types/result';

export type ContentHandler = (type: string, payload: unknown, tabId: number) => unknown;

export class FakeBrowserAdapter implements BrowserAdapter {
  readonly tabs = new Map<number, TabInfo>();
  readonly calls: { type: string; tabId: number; payload: unknown }[] = [];
  private nextTabId = 1;
  private contentHandler: ContentHandler | null = null;
  ensureContentScriptCalls = 0;
  /** Set to make waitForLoad reject, simulating a navigation timeout. */
  failLoad = false;

  addTab(partial: Partial<TabInfo> & { url: string }): TabInfo {
    const id = partial.id ?? this.nextTabId++;
    const tab: TabInfo = {
      id,
      url: partial.url,
      title: partial.title ?? 'Test page',
      active: partial.active ?? this.tabs.size === 0,
      windowId: partial.windowId ?? 1,
      index: partial.index ?? this.tabs.size,
      status: partial.status ?? 'complete',
      groupId: partial.groupId ?? -1,
    };
    this.tabs.set(id, tab);
    return tab;
  }

  /** Simulates the page navigating out from under the agent. */
  setUrl(tabId: number, url: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) this.tabs.set(tabId, { ...tab, url });
  }

  onContent(handler: ContentHandler): void {
    this.contentHandler = handler;
  }

  listTabs(): Promise<TabInfo[]> {
    return Promise.resolve([...this.tabs.values()]);
  }

  getTab(tabId: number): Promise<TabInfo | null> {
    return Promise.resolve(this.tabs.get(tabId) ?? null);
  }

  getActiveTab(): Promise<TabInfo | null> {
    return Promise.resolve([...this.tabs.values()].find((tab) => tab.active) ?? null);
  }

  createTab(options: CreateTabOptions): Promise<TabInfo> {
    return Promise.resolve(this.addTab({ url: options.url, active: options.active ?? false }));
  }

  closeTab(tabId: number): Promise<void> {
    this.tabs.delete(tabId);
    return Promise.resolve();
  }

  activateTab(tabId: number): Promise<TabInfo> {
    for (const [id, tab] of this.tabs) this.tabs.set(id, { ...tab, active: id === tabId });
    const tab = this.tabs.get(tabId);
    if (!tab) return Promise.reject(new Error('no such tab'));
    return Promise.resolve(tab);
  }

  reloadTab(): Promise<void> {
    return Promise.resolve();
  }

  navigate(tabId: number, url: string): Promise<void> {
    this.setUrl(tabId, url);
    return Promise.resolve();
  }

  goBack(): Promise<void> {
    return Promise.resolve();
  }

  goForward(): Promise<void> {
    return Promise.resolve();
  }

  waitForLoad(tabId: number): Promise<TabInfo> {
    if (this.failLoad) return Promise.reject(new Error('navigation timeout'));
    const tab = this.tabs.get(tabId);
    return tab ? Promise.resolve(tab) : Promise.reject(new Error('no such tab'));
  }

  groupTabs(): Promise<number> {
    return Promise.resolve(99);
  }

  ungroupTabs(): Promise<void> {
    return Promise.resolve();
  }

  moveTab(): Promise<void> {
    return Promise.resolve();
  }

  ensureContentScript(): Promise<void> {
    this.ensureContentScriptCalls += 1;
    return Promise.resolve();
  }

  callContent<T extends ContentRequestType>(
    tabId: number,
    type: T,
    payload: ContentRequest<T>,
  ): Promise<ContentResponse<T>> {
    this.calls.push({ type, tabId, payload });
    if (!this.contentHandler) {
      return Promise.reject(new Error(`No content handler configured for ${type}`));
    }
    const result = this.contentHandler(type, payload, tabId);
    if (result instanceof MessagingError) return Promise.reject(result);
    if (result instanceof Error) {
      // The real bus converts a missing content script into a structured
      // PAGE_NOT_READY; the fake must do the same or tests would assert
      // against behaviour the production path never produces.
      return Promise.reject(
        new MessagingError(
          createError('PAGE_NOT_READY', result.message, {
            userMessage: 'The page is not ready for automation yet.',
            retryable: true,
          }),
        ),
      );
    }
    return Promise.resolve(result as ContentResponse<T>);
  }
}
