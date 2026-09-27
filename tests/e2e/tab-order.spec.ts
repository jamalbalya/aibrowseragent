/**
 * TEST-E2E-046 — tabs.move and tabs.get against real Chrome tabs.
 *
 * MOCK PROVIDER E2E. The endpoint is a local server; nothing here is evidence
 * about a commercial provider.
 *
 * The unit and integration suites drive these two tools against a fake
 * adapter, which is exactly as truthful as the fake is. What they cannot show
 * is that `chrome.tabs.move` renumbers the window the way the tool reports,
 * that the index a tab carries in a real workspace group is the index the
 * model was handed, or that an id from outside the group is refused by the
 * shipped service worker rather than by a test harness. These do: every
 * assertion below reads the browser back through `chrome.tabs.query`, not
 * through the task transcript.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

type Worker = { evaluate: <T, A>(fn: (arg: A) => Promise<T> | T, arg: A) => Promise<T> };

/** The ids of the tabs on the site, left to right, as Chrome has them. */
async function tabOrder(worker: Worker, base: string): Promise<number[]> {
  return await worker.evaluate(async (prefix: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((tab) => tab.url?.startsWith(prefix))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((tab) => tab.id ?? -1);
  }, base);
}

async function tabIdFor(worker: Worker, url: string): Promise<number> {
  const id = await worker.evaluate(async (target: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id ?? -1;
  }, url);
  expect(id).toBeGreaterThan(-1);
  return id;
}

/**
 * What the model was told, from the requests the extension really sent.
 *
 * A task step records only a summary — "tabs.get succeeded" — so asserting on
 * `task.steps` cannot show which tab was described or what index came back.
 * The mock provider has the transcript itself. Backslashes are stripped
 * because the tool result arrives as a JSON string nested inside the request
 * body, so every quote in it is escaped twice over.
 */
function toldTheModel(provider: { readonly requests: readonly unknown[] }, from: number): string {
  return JSON.stringify(provider.requests.slice(from)).replace(/\\/g, '');
}

/** Puts a tab into the workspace group the running task is bound to. */
async function addToWorkspace(worker: Worker, tabId: number, base: string): Promise<void> {
  await worker.evaluate(
    async ([id, prefix]: [number, string]) => {
      const tabs = await chrome.tabs.query({});
      const anchor = tabs.find((tab) => tab.url?.startsWith(prefix) && (tab.groupId ?? -1) !== -1);
      await chrome.tabs.group({ tabIds: [id], groupId: anchor!.groupId });
    },
    [tabId, base] as [number, string],
  );
}

test('the model reorders real tabs and is told the position Chrome gave them', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await first.bringToFront();
  await connectProvider(send, provider);

  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  // Two more tabs, put into the workspace the way a user dragging them in
  // would. Three tabs is the smallest window where a move can be wrong in
  // both directions.
  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  const secondId = await tabIdFor(serviceWorker, `${site.baseUrl}/details`);
  await addToWorkspace(serviceWorker, secondId, site.baseUrl);

  const third = await context.newPage();
  await third.goto(`${site.baseUrl}/spa`, { waitUntil: 'domcontentloaded' });
  const thirdId = await tabIdFor(serviceWorker, `${site.baseUrl}/spa`);
  await addToWorkspace(serviceWorker, thirdId, site.baseUrl);

  const before = await tabOrder(serviceWorker, site.baseUrl);
  expect(before).toHaveLength(3);
  expect(before[2]).toBe(thirdId);

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_move', arguments: { tabId: thirdId, index: 0 } }] },
    { kind: 'text', text: 'moved it' },
  ]);
  const moved = await waitForTask(
    send,
    (await send('task.create', { objective: 'Put the SPA tab first.' })).task.id,
  );

  expect(moved.state).toBe('COMPLETED');
  // Chrome's own account of the window, not the tool's.
  const after = await tabOrder(serviceWorker, site.baseUrl);
  expect(after[0]).toBe(thirdId);
  expect(after).toEqual([thirdId, ...before.slice(0, 2)]);

  await third.close();
  await second.close();
  await first.close();
});

test('an index past the end is reported as the position Chrome clamped it to', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await first.bringToFront();
  await connectProvider(send, provider);

  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  const anchorId = await tabIdFor(serviceWorker, `${site.baseUrl}/`);

  const from = provider.requests.length;
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_move', arguments: { tabId: anchorId, index: 900 } }],
    },
    { kind: 'text', text: 'moved it' },
  ]);
  await waitForTask(
    send,
    (await send('task.create', { objective: 'Move it to the end.' })).task.id,
  );

  // The real Chrome API clamps rather than failing, so the tool has to report
  // where the tab landed. An echoed 900 would be a success report for
  // something that did not happen, which is what §76 forbids.
  const landed = await serviceWorker.evaluate(
    async (id: number) => (await chrome.tabs.get(id)).index,
    anchorId,
  );
  const transcript = toldTheModel(provider, from);
  expect(landed).not.toBe(900);
  expect(transcript).toContain('"clamped":true');
  expect(transcript).toContain(`"index":${landed}`);
  expect(transcript).toContain('"requestedIndex":900');

  await first.close();
});

test('tabs.get answers for the id it was given, and refuses one that is gone', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await first.bringToFront();
  await connectProvider(send, provider);

  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  const secondId = await tabIdFor(serviceWorker, `${site.baseUrl}/details`);
  await addToWorkspace(serviceWorker, secondId, site.baseUrl);
  await first.bringToFront();

  const from = provider.requests.length;
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_get', arguments: { tabId: secondId } }] },
    { kind: 'text', text: 'read it' },
  ]);
  const got = await waitForTask(
    send,
    (await send('task.create', { objective: 'Describe the details tab.' })).task.id,
  );

  const transcript = toldTheModel(provider, from);
  expect(got.state).toBe('COMPLETED');
  // The tab asked about, not the focused one: `first` was brought back to the
  // front above precisely so the two cannot be confused.
  expect(transcript).toContain(`"tabId":${secondId}`);
  expect(transcript).toContain('Widget Details');
  expect(transcript).toContain('"active":false');

  // An id no tab has. A deterministic error, not an empty record the model
  // would read as a tab with no title.
  const before = provider.requests.length;
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_get', arguments: { tabId: 987654 } }] },
    { kind: 'text', text: 'no such tab' },
  ]);
  const missing = await waitForTask(
    send,
    (await send('task.create', { objective: 'Describe a tab that is gone.' })).task.id,
  );
  expect(toldTheModel(provider, before)).toMatch(/TAB_NOT_FOUND|POLICY_BLOCKED/);
  expect(missing.state).toBe('PARTIAL');

  await second.close();
  await first.close();
});

test('neither tool will touch a tab outside the workspace', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const inside = await context.newPage();
  await inside.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await inside.bringToFront();
  await connectProvider(send, provider);

  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  // Left ungrouped: the user never put it in scope.
  const outside = await context.newPage();
  await outside.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  const outsideId = await tabIdFor(serviceWorker, `${site.baseUrl}/details`);
  // Focus goes back to a workspace tab before the task starts. Without this
  // the new tab is the run's ambient tab, the registry's central workspace
  // check refuses every call up front, and the test would pass while proving
  // nothing about the id passed as an argument — measured, not assumed.
  await inside.bringToFront();
  const before = await tabOrder(serviceWorker, site.baseUrl);

  const from = provider.requests.length;
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_get', arguments: { tabId: outsideId } }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_move', arguments: { tabId: outsideId, index: 0 } }],
    },
    { kind: 'text', text: 'could not' },
  ]);
  const task = await waitForTask(
    send,
    (await send('task.create', { objective: 'Rearrange the other tab.' })).task.id,
  );

  const transcript = toldTheModel(provider, from);
  expect(transcript).toContain('POLICY_BLOCKED');
  // Reading one tab at a time is the same leak tabs.list was narrowed to
  // close, so the refusal has to cover the read as well as the move. Checked
  // against what the model received, since a step summary would not carry the
  // title either way.
  expect(transcript).not.toContain('Widget Details');
  expect(task.state).toBe('PARTIAL');
  // And nothing moved.
  expect(await tabOrder(serviceWorker, site.baseUrl)).toEqual(before);

  await outside.close();
  await inside.close();
});
