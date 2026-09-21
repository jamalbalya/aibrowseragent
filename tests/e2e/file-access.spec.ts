/**
 * TEST-E2E-005 — The local filesystem is out of reach (REQ-SECURITY-003).
 *
 * Adding a screenshot capability that needs no host permission raises an
 * obvious question: does the agent now have a way to photograph, read or
 * inspect a local file that the narrow manifest was supposed to deny? This
 * suite answers it in a real Chromium rather than against a fake adapter,
 * because the two layers involved fail in different places and only one of
 * them is ours:
 *
 *   - Chrome refuses `scripting.executeScript` and content-script injection
 *     on `file://` because the manifest asks for `http` and `https` only.
 *     That refusal is the browser's, it happens before any extension code
 *     runs, and it disappears the moment the manifest widens.
 *   - The policy engine refuses `file:` unconditionally through
 *     BLOCKED_SCHEMES, so every tool stops even where Chrome would not.
 *
 * Both are asserted. A test that only proved the second would pass just as
 * happily under `<all_urls>`, which is exactly the configuration this suite
 * exists to keep out.
 */
import type { BrowserContext, Worker } from '@playwright/test';
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

/** A file that exists on any Linux runner and is not secret. */
const LOCAL_FILE = 'file:///etc/hostname';

/** Opens a real file:// tab and returns its Chrome tab id. */
async function openLocalFile(
  context: BrowserContext,
  serviceWorker: Worker,
): Promise<{ tabId: number; close: () => Promise<void> }> {
  const page = await context.newPage();
  await page.goto(LOCAL_FILE).catch(() => undefined);
  await page.bringToFront();

  const tabId = await serviceWorker.evaluate(async (url: string) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id ?? -1;
  }, LOCAL_FILE);

  return { tabId, close: () => page.close() };
}

/** Everything the task refused, as one searchable string. */
function refusals(task: {
  result?: {
    readonly failedActions: readonly string[];
    readonly blockedActions: readonly string[];
  } | null;
}): string {
  return [...(task.result?.failedActions ?? []), ...(task.result?.blockedActions ?? [])].join(' ');
}

/**
 * Whether the extension attached its debugger to a tab.
 *
 * `chrome.debugger.getTargets()` cannot answer this under Playwright: Playwright
 * drives the browser over CDP itself, so every target reports `attached: true`
 * whatever the extension did. DebuggerManager logs each attachment from the
 * service worker, and that log is the extension's own account of itself.
 */
function attachCount(workerLogs: readonly string[], tabId: number): number {
  return workerLogs.filter(
    (line) => line.includes('Debugger attached') && line.includes(String(tabId)),
  ).length;
}

function extensionAttachedTo(workerLogs: readonly string[], tabId: number): boolean {
  return attachCount(workerLogs, tabId) > 0;
}

test('Chrome refuses scripting.executeScript against a local file', async ({
  context,
  serviceWorker,
}) => {
  // Under <all_urls> this call succeeded and returned the file's contents.
  const { tabId, close } = await openLocalFile(context, serviceWorker);
  expect(tabId).toBeGreaterThan(-1);

  const outcome = await serviceWorker.evaluate(async (id: number) => {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => document.body.innerText,
      });
      return { ok: true, error: '', value: String(result?.result ?? '') };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '', value: '' };
    }
  }, tabId);

  expect(outcome.ok).toBe(false);
  expect(outcome.error).toMatch(/cannot access|permission/i);
  expect(outcome.value).toBe('');

  await close();
});

test('no content script is injected into a local file', async ({
  context,
  serviceWorker,
  site,
}) => {
  // content_scripts.matches is http/https only, so the page the agent would
  // read from never gets its reader.
  const { tabId, close } = await openLocalFile(context, serviceWorker);

  const reachable = await serviceWorker.evaluate(
    (id: number) =>
      new Promise<boolean>((resolve) => {
        // The real envelope shape the bus uses; a bare {type} is ignored.
        const message = {
          id: `e2e_${Date.now()}`,
          type: 'content.ping',
          timestamp: Date.now(),
          payload: {},
        };
        chrome.tabs.sendMessage(id, message, (response: unknown) => {
          resolve(chrome.runtime.lastError === undefined && response != null);
        });
      }),
    tabId,
  );

  expect(reachable).toBe(false);

  // Negative control. Without this the assertion above would pass just as
  // happily if `content.ping` had been renamed and nothing answered anywhere.
  const http = await context.newPage();
  await http.goto(site.baseUrl, { waitUntil: 'load' });
  const httpTabId = await serviceWorker.evaluate(async (url: string) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    return tab?.id ?? -1;
  }, site.baseUrl);
  expect(httpTabId).toBeGreaterThan(-1);

  const httpReachable = await serviceWorker.evaluate(
    (id: number) =>
      new Promise<boolean>((resolve) => {
        // The real envelope shape the bus uses; a bare {type} is ignored.
        const message = {
          id: `e2e_${Date.now()}`,
          type: 'content.ping',
          timestamp: Date.now(),
          payload: {},
        };
        chrome.tabs.sendMessage(id, message, (response: unknown) => {
          resolve(chrome.runtime.lastError === undefined && response != null);
        });
      }),
    httpTabId,
  );

  expect(httpReachable).toBe(true);

  await http.close();
  await close();
});

test('every browser tool refuses a local file, and none of them attaches the debugger', async ({
  context,
  serviceWorker,
  workerLogs,
  send,
  provider,
}) => {
  const { tabId, close } = await openLocalFile(context, serviceWorker);
  expect(tabId).toBeGreaterThan(-1);

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_screenshot', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'debugger_dom', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'debugger_console', arguments: {} }] },
    { kind: 'text', text: 'All four were refused.' },
  ]);

  // The file tab is the active one, which is the tab a task acts on.
  const { task } = await send('task.create', { objective: 'Read the local file that is open.' });
  const finished = await waitForTask(send, task.id);

  const refused = refusals(finished);
  for (const tool of ['browser.read_page', 'browser.screenshot', 'debugger.dom']) {
    expect(refused, `${tool} should have been refused`).toContain(tool);
  }

  // No evidence was produced — nothing about the file was recorded.
  const { evidence } = await send('evidence.listForTask', { taskId: task.id });
  expect(evidence).toHaveLength(0);

  // And the extension never attached its debugger, so it never opened a CDP
  // session on a local file. This is the ordering that matters: the scheme
  // gate has to run before attachment, not after.
  expect(extensionAttachedTo(workerLogs, tabId)).toBe(false);

  await close();
});

test('the agent cannot navigate an existing tab to a local file', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const before = page.url();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_navigate', arguments: { url: LOCAL_FILE } }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: 'ftp://example.com/secret.txt' } }],
    },
    { kind: 'text', text: 'Both refused.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open the hosts file.' });
  const finished = await waitForTask(send, task.id);

  expect(page.url()).toBe(before);
  expect(refusals(finished)).toContain('browser.navigate');
  expect(context.pages().some((p) => p.url().startsWith('file://'))).toBe(false);

  await page.close();
});

test('the agent cannot open a new tab on a local file', async ({ context, send, provider }) => {
  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_create', arguments: { url: LOCAL_FILE } }] },
    { kind: 'text', text: 'Refused.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open a local file in a new tab.' });
  const finished = await waitForTask(send, task.id);

  expect(refusals(finished)).toContain('tabs.create');
  expect(context.pages().some((p) => p.url().startsWith('file://'))).toBe(false);
});

test('a screenshot attaches the debugger and hands it straight back', async ({
  context,
  workerLogs,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  // Screenshot capture is the one browser tool that attaches the debugger, so
  // it is the one that could leave a CDP session open on a page the user is
  // still using. On a page the agent *is* allowed to touch, the attach must
  // happen and the detach must follow it.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  const tabId = await serviceWorker.evaluate(async (url: string) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/*` });
    return tab?.id ?? -1;
  }, site.baseUrl);
  expect(tabId).toBeGreaterThan(-1);

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_screenshot', arguments: {} }] },
    { kind: 'text', text: 'Captured once.' },
    { kind: 'tool_calls', calls: [{ name: 'browser_screenshot', arguments: {} }] },
    { kind: 'text', text: 'Captured twice.' },
  ]);

  const first = await send('task.create', { objective: 'Take a screenshot.' });
  expect((await waitForTask(send, first.task.id)).state).toBe('COMPLETED');
  const attachesAfterFirst = attachCount(workerLogs, tabId);

  const second = await send('task.create', { objective: 'Take another screenshot.' });
  expect((await waitForTask(send, second.task.id)).state).toBe('COMPLETED');

  // attach() returns early when a session already exists, so a second attach
  // log can only mean the first one was torn down. That is the detach
  // assertion, made from behaviour rather than from a debug-level log line.
  expect(attachesAfterFirst).toBe(1);
  expect(attachCount(workerLogs, tabId)).toBe(2);

  await page.close();
});
