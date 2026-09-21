/**
 * TEST-E2E-005 — MV3 lifecycle and deep browser inspection.
 *
 * Stage 1 simulated service-worker eviction by rebuilding the stores over the
 * same storage. That proves the recovery logic, not that Chrome's real restart
 * path reaches it. `chrome.runtime.reload()` tears the extension down and
 * brings it back for real: same extension id, same storage, brand new worker.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';
import type { BrowserContext, Page, Worker } from '@playwright/test';

/**
 * Kills the service worker the way Chrome's eviction does.
 *
 * `chrome.runtime.reload()` is not usable here: for an extension loaded with
 * `--load-extension` it unloads the extension permanently rather than
 * restarting it. Closing the worker's CDP target terminates just the worker,
 * leaving the extension installed, its storage intact, and Chrome free to
 * spin up a fresh worker on the next event — which is exactly the MV3
 * lifecycle the runtime has to survive.
 */
async function killServiceWorker(context: BrowserContext, worker: Worker): Promise<void> {
  const cdp = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(
    (info) => info.type === 'service_worker' && info.url === worker.url(),
  );
  if (!target) throw new Error('No service worker target to terminate.');

  await cdp.send('Target.closeTarget', { targetId: target.targetId });
  await cdp.detach();
  await new Promise((r) => setTimeout(r, 800));
}

/**
 * Opens a fresh side panel, which wakes the worker if it is not running, and
 * returns a sender bound to it. The previous panel's port dies with the
 * worker, so a restarted test cannot keep using it.
 */
async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.waitForSelector('.app', { timeout: 15_000 });
  // Give the revived worker's startup() time to finish recovery.
  await new Promise((r) => setTimeout(r, 1200));
  return panel;
}

interface PanelEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly userMessage: string };
}

/** Sends one message from a specific panel page. */
async function ask<T>(panel: Page, type: string, payload: unknown = {}): Promise<T> {
  const envelope: PanelEnvelope = await panel.evaluate(
    ([messageType, messagePayload]) =>
      chrome.runtime.sendMessage({
        id: `e2e_${Math.random().toString(36).slice(2)}`,
        type: messageType,
        timestamp: Date.now(),
        payload: messagePayload,
      }),
    [type, payload] as const,
  );
  if (!envelope?.ok) {
    throw new Error(
      `${type} failed: ${envelope?.error?.code} ${envelope?.error?.userMessage ?? ''}`,
    );
  }
  return envelope.value as T;
}

test('a task interrupted by a real worker restart is parked, not resumed blind', async ({
  context,
  serviceWorker,
  extensionId,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Finished quickly.' }]);

  const { task } = await send('task.create', { objective: 'A task to interrupt.' });
  await waitForTask(send, task.id);

  // Put the stored record back into a live state, exactly as an eviction
  // mid-execution would leave it.
  await serviceWorker.evaluate(async (taskId) => {
    const key = `tasks:task:${taskId}`;
    const stored = await chrome.storage.local.get(key);
    const record = stored[key] as { state: string; finishedAt?: number };
    record.state = 'RUNNING';
    delete record.finishedAt;
    await chrome.storage.local.set({ [key]: record });
  }, task.id);

  await killServiceWorker(context, serviceWorker);

  const panel = await openPanel(context, extensionId);
  const recovered = await ask<{ task: { state: string; currentStepSummary?: string } }>(
    panel,
    'task.get',
    { taskId: task.id },
  );

  expect(recovered.task.state).toBe('PAUSED');
  expect(recovered.task.currentStepSummary).toContain('restarted');
});

test('settings and provider configuration survive a real restart', async ({
  context,
  serviceWorker,
  extensionId,
  send,
  provider,
}) => {
  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });

  await killServiceWorker(context, serviceWorker);

  const panel = await openPanel(context, extensionId);
  const { connection } = await ask<{
    connection: { modelId: string; capabilities?: { toolCalling: boolean } } | null;
  }>(panel, 'provider.getConnection');
  const { session } = await ask<{ session: { permissionMode: string } }>(panel, 'session.get');

  expect(connection?.modelId).toBe('mock-model');
  expect(connection?.capabilities?.toolCalling).toBe(true);
  expect(session.permissionMode).toBe('manual');
});

test('a task can still run after the worker has restarted', async ({
  context,
  serviceWorker,
  extensionId,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  await killServiceWorker(context, serviceWorker);

  // The credential is reloaded from storage, so a new task must reach the
  // provider without the user reconnecting.
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it after the restart.' },
  ]);

  const panel = await openPanel(context, extensionId);

  // A task acts on whatever tab is active when it starts. In this harness the
  // panel is a real tab, so it has to be pushed back behind the page under
  // test; in production the side panel is not a tab and never competes. Skip
  // this and the agent correctly refuses to automate a chrome-extension: page.
  await page.bringToFront();

  const { task } = await ask<{ task: { id: string } }>(panel, 'task.create', {
    objective: 'Read the page after a restart.',
  });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const got = await ask<{ task: { state: string; result?: { summary: string } } }>(
      panel,
      'task.get',
      { taskId: task.id },
    );
    if (['COMPLETED', 'PARTIAL', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(got.task.state)) {
      expect(got.task.state, JSON.stringify(got.task.result)).toBe('COMPLETED');
      expect(got.task.result?.summary).toContain('restart');
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('The task did not finish after the restart.');
});

test('the debugger captures real console and network activity', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'debugger_console', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'debugger_network', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'debugger_page_state', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'debugger_detach', arguments: {} }] },
    { kind: 'text', text: 'Inspected the page.' },
  ]);

  const { task } = await send('task.create', { objective: 'Debug this page.' });

  // Produce activity while the debugger is attached.
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => {
    // Runs in the page, not in the extension, so the project's no-console rule
    // does not apply; the point is to give the debugger something to capture.
    // eslint-disable-next-line no-console
    console.error('deliberate failure for the test');
    void fetch('/details').catch(() => undefined);
  });

  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.state).toBe('COMPLETED');
  expect(finished.result!.completedActions).toContain('debugger.console');
  expect(finished.result!.completedActions).toContain('debugger.network');
  expect(finished.result!.completedActions).toContain('debugger.page_state');

  // Console and network evidence was stored.
  const { evidence } = await send('evidence.listForTask', { taskId: task.id });
  expect(evidence.map((e) => e.type)).toContain('CONSOLE');
  expect(evidence.map((e) => e.type)).toContain('NETWORK');
});

test('a closed tab does not leave the debugger in a broken state', async ({
  context,
  send,
  provider,
  site,
}) => {
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await first.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'debugger_console', arguments: {} }] },
    { kind: 'text', text: 'Attached to the first tab.' },
  ]);

  const attach = await send('task.create', { objective: 'Check the console.' });
  await waitForTask(send, attach.task.id);

  // Closing the inspected tab must release the session. Asserting on
  // `chrome.debugger.getTargets().attached` would prove nothing here, because
  // Playwright holds its own CDP session on every page. Instead the check is
  // behavioural: a later inspection on a different tab must still work, which
  // it would not if a stale session were leaking.
  await first.close();
  await new Promise((r) => setTimeout(r, 600));

  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await second.bringToFront();

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'debugger_console', arguments: {} }] },
    { kind: 'text', text: 'Attached to the second tab.' },
  ]);

  const again = await send('task.create', { objective: 'Check the console again.' });
  const finished = await waitForTask(send, again.task.id, 40_000);

  expect(finished.state).toBe('COMPLETED');
  expect(finished.result!.completedActions).toContain('debugger.console');
});
