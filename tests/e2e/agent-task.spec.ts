/**
 * TEST-E2E-003 — A full agent task drives a real page (REQ-BROWSER-003).
 *
 * The specification's required first demo, executed for real: the user starts
 * a task, the model calls canonical tools, the tools drive a live page in
 * Chromium, and the side panel shows the outcome with its evidence.
 *
 * Nothing here is stubbed except the model's choice of tool call.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

test('reads a real page and reports a summary with evidence', async ({
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
    {
      kind: 'text',
      text: 'The page is a widget catalogue offering small, medium and large widgets.',
    },
  ]);

  const { task } = await send('task.create', {
    objective: 'Read the current page and summarise it.',
  });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  expect(finished.result?.completedActions).toContain('browser.read_page');
  expect(finished.result?.summary).toContain('widget');

  // The page's real text reached the model as a tool result, inside the
  // untrusted envelope. Matching on the envelope marker alone would be
  // meaningless: it also appears in every system instruction.
  const toolMessages = provider.requests
    .filter((r) => r.path.endsWith('/chat/completions'))
    .flatMap((r) => (r.body as { messages?: { role?: string; content?: string }[] }).messages ?? [])
    .filter((message) => message.role === 'tool');

  expect(toolMessages.length).toBeGreaterThan(0);
  const readResult = toolMessages.map((m) => m.content ?? '').join('');
  expect(readResult).toContain('three kinds of widget');
  expect(readResult).toContain('UNTRUSTED_EXTERNAL_CONTENT');
  // The password field's value must not have travelled with it.
  expect(readResult).not.toContain('hunter2-do-not-leak');

  // Evidence was stored and is retrievable.
  const { evidence } = await send('evidence.listForTask', { taskId: task.id });
  expect(evidence.length).toBeGreaterThan(0);
  // A task now also records an egress decision per provider request, so the
  // page capture has to be selected by what it is rather than by position.
  const pageEvidence = evidence.find((item) => item.sourceTool === 'browser.read_page');
  expect(pageEvidence).toBeDefined();
  const payload = await send('evidence.getPayload', { evidenceId: pageEvidence!.id });
  expect(payload.content).toContain('widget');
});

test('types into a real field and clicks a real button', async ({
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
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_type', arguments: { elementId: 'e1-0', text: 'medium widget' } }],
    },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-1' } }] },
    { kind: 'text', text: 'Searched for medium widget.' },
  ]);

  const { task } = await send('task.create', { objective: 'Search for a medium widget.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  // The real DOM changed.
  expect(await page.inputValue('#search')).toBe('medium widget');
});

test('navigates to a real page and reads it', async ({ context, send, provider, site }) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_navigate', arguments: { url: `${site.baseUrl}/details` } }],
    },
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'The medium widget weighs 400 grams.' },
  ]);

  const { task } = await send('task.create', { objective: 'Open the details page and read it.' });
  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.state).toBe('COMPLETED');
  expect(page.url()).toContain('/details');

  const turns = provider.requests.map((r) => JSON.stringify(r.body)).join('');
  expect(turns).toContain('400 grams');
});

test('a screenshot is captured, stored and never inlined into model context', async ({
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
    { kind: 'tool_calls', calls: [{ name: 'browser_screenshot', arguments: {} }] },
    { kind: 'text', text: 'Captured the page.' },
  ]);

  const { task } = await send('task.create', { objective: 'Take a screenshot.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');

  const { evidence } = await send('evidence.listForTask', { taskId: task.id });
  const shot = evidence.find((item) => item.type === 'SCREENSHOT');
  expect(shot).toBeDefined();

  const payload = await send('evidence.getPayload', { evidenceId: shot!.id });
  expect(payload.encoding).toBe('base64');
  expect(payload.mimeType).toBe('image/png');
  // A real PNG, not a placeholder.
  expect(payload.content!.length).toBeGreaterThan(500);
  expect(Buffer.from(payload.content!.slice(0, 12), 'base64').toString('hex')).toMatch(/^89504e47/);

  // The image itself must not have entered the conversation.
  const turns = provider.requests.map((r) => JSON.stringify(r.body)).join('');
  expect(turns).not.toContain(payload.content!.slice(0, 200));
});

test('a stale element handle is refused and reported to the model', async ({
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
    // Re-reading invalidates generation 1.
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-1' } }] },
    { kind: 'text', text: 'The handle was stale, so I stopped.' },
  ]);

  const { task } = await send('task.create', { objective: 'Click the search button.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.result?.failedActions.join(' ')).toContain('browser.click');

  const turns = provider.requests.map((r) => JSON.stringify(r.body)).join('');
  expect(turns).toContain('ELEMENT_NOT_FOUND');
  expect(turns).toContain('earlier snapshot');
});

test('the task can be cancelled while it is running', async ({ context, send, provider, site }) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  // A long trajectory, so there is something to interrupt.
  provider.script(
    Array.from({ length: 30 }, () => ({
      kind: 'tool_calls' as const,
      calls: [{ name: 'browser_scroll', arguments: { direction: 'down' } }],
    })),
  );

  const { task } = await send('task.create', { objective: 'Scroll to the end repeatedly.' });
  await new Promise((r) => setTimeout(r, 400));
  const { state } = await send('task.cancel', { taskId: task.id });

  expect(state).toBe('CANCELLED');
  const finished = await send('task.get', { taskId: task.id });
  expect(finished.task?.state).toBe('CANCELLED');
});

test('tasks survive the side panel closing and reopening', async ({
  context,
  send,
  provider,
  site,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Done.' }]);

  const { task } = await send('task.create', { objective: 'A task that outlives the panel.' });
  await waitForTask(send, task.id);

  // Close the panel and open a fresh one, as the user would.
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await reopened.waitForSelector('.app');

  const listed: { ok: boolean; value: { tasks: { id: string; state: string }[] } } =
    await reopened.evaluate(() =>
      chrome.runtime.sendMessage({
        id: 'x',
        type: 'task.list',
        timestamp: Date.now(),
        payload: { limit: 10 },
      }),
    );

  const found = listed.value.tasks.find((t) => t.id === task.id);
  expect(found?.state).toBe('COMPLETED');
});

test('groups real tabs through the Chrome tab-group API', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  // The unit tests drive tabs.group through a fake adapter, which proves the
  // tool's contract and nothing about `chrome.tabs.group` — an API gated on
  // the `tabGroups` permission that a build can simply not have. The
  // capability was recorded as passing on the fake alone; this closes the gap.
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });
  await first.bringToFront();

  await connectProvider(send, provider);

  const ids = await serviceWorker.evaluate(async (prefix: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.url?.startsWith(prefix)).map((tab) => tab.id!);
  }, site.baseUrl);
  expect(ids.length).toBeGreaterThanOrEqual(2);

  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_group', arguments: { tabIds: ids, title: 'Research' } }],
    },
    { kind: 'text', text: 'Grouped the tabs.' },
  ]);

  const { task } = await send('task.create', { objective: 'Group the open tabs.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');

  // Chrome really moved them: one shared group id, and not the "no group"
  // sentinel a silently failing call would leave behind.
  const groups = await serviceWorker.evaluate(async (tabIds: number[]) => {
    const tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
    return tabs.map((tab) => tab.groupId ?? -1);
  }, ids);

  expect(new Set(groups).size).toBe(1);
  expect(groups[0]).not.toBe(-1);
  expect(groups[0]).toBeGreaterThan(-1);

  await first.close();
  await second.close();
});

test('sets checkboxes and radios on a real form', async ({ context, send, provider, site }) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        { name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: true } },
        { name: 'browser_set_checked', arguments: { elementId: 'e1-1', checked: false } },
        { name: 'browser_set_checked', arguments: { elementId: 'e1-3', checked: true } },
      ],
    },
    { kind: 'text', text: 'Preferences set.' },
  ]);

  const { task } = await send('task.create', { objective: 'Set my preferences.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.state).toBe('COMPLETED');
  // The real DOM changed, and the radio group stayed exclusive.
  expect(await page.isChecked('#news')).toBe(true);
  expect(await page.isChecked('#terms')).toBe(false);
  expect(await page.isChecked('#sb')).toBe(true);
  expect(await page.isChecked('#sa')).toBe(false);
});

test('a unified audit trail records decisions and exports without page text', async ({
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

  const { events } = await send('audit.list', { taskId: task.id });
  expect(events.length).toBeGreaterThan(0);
  expect(events.some((e) => e.type === 'egress.decided')).toBe(true);
  // Every egress record points at evidence rather than repeating it.
  const egress = events.find((e) => e.type === 'egress.decided')!;
  expect(egress.evidenceIds?.length).toBeGreaterThan(0);

  const exported = await send('audit.export', {});
  const serialised = JSON.stringify(exported.export);
  expect(exported.export.format).toBe('aiba-audit/1');
  expect(exported.export.eventCount).toBeGreaterThan(0);
  // The trail describes what happened; it does not carry what was read.
  expect(serialised).not.toContain('Widget Catalogue');
  expect(serialised).not.toContain('hunter2');
});
