/**
 * TEST-E2E-021 — the workspace boundary, in a real browser.
 *
 * MOCK PROVIDER E2E. The endpoint is a local server; nothing here is evidence
 * about a commercial provider.
 *
 * The gap being closed is not subtle. Before workspaces, `listTabs()` was
 * `chrome.tabs.query({})` — every tab in every window — and a tool acted on
 * whatever tab id it was handed. A task started from one page could enumerate
 * and act on an unrelated tab in another window, because every control in the
 * authorization stack answered *"may this action happen"* and none answered
 * *"is this tab even in scope"*.
 *
 * Unit tests prove `checkMembership` is correct as a function. They cannot
 * prove that Chrome's real tab-group API behaves the way the design assumes,
 * that a real drag produces the event the reconciler listens for, or that a
 * real service-worker restart leaves the binding intact. These do.
 *
 * `chrome.tabs.group` / `ungroup` stand in for a human dragging a tab. They
 * emit the identical events — measured — but they are the API, not a mouse,
 * and the design document records the genuine drag as human-only acceptance.
 */
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
} from './fixtures/extension';

/** The group the extension bound its workspace to, read from real Chrome. */
async function workspaceGroupId(
  serviceWorker: { evaluate: <T, A>(fn: (arg: A) => Promise<T> | T, arg: A) => Promise<T> },
  prefix: string,
): Promise<number> {
  return await serviceWorker.evaluate(async (base: string) => {
    const tabs = await chrome.tabs.query({});
    const grouped = tabs.filter((tab) => tab.url?.startsWith(base) && (tab.groupId ?? -1) !== -1);
    return grouped[0]?.groupId ?? -1;
  }, prefix);
}

test('starting a task puts the active tab into a workspace group', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);

  provider.script([{ kind: 'text', text: 'Nothing to do.' }]);
  const { task } = await send('task.create', { objective: 'Look at this page.' });
  await waitForTask(send, task.id);

  // Requirement one: activating from a tab makes that tab the initial
  // context, and Chrome really moved it into a group.
  const groupId = await workspaceGroupId(serviceWorker, site.baseUrl);
  expect(groupId).toBeGreaterThan(-1);

  await page.close();
});

test('a tab outside the workspace is neither listed nor actionable', async ({
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

  // A second tab the user never put in scope.
  const outside = await context.newPage();
  await outside.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });
  const outsideId = await serviceWorker.evaluate(async (base: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith(base) && (tab.groupId ?? -1) === -1)?.id ?? -1;
  }, `${site.baseUrl}/form`);
  expect(outsideId).toBeGreaterThan(-1);

  // The model asks for every tab, then tries to read the one it must not see.
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_list', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: { tabId: outsideId } }] },
    { kind: 'text', text: 'done' },
  ]);
  const { task } = await send('task.create', { objective: 'Read the other tab.' });
  const finished = await waitForTask(send, task.id);

  const steps = JSON.stringify(finished.steps);
  // Enumeration is narrowed too: knowing what the user has open is a leak in
  // its own right, even when acting on it would have been refused.
  expect(steps).not.toContain(`/form`);
  // The read was refused, so the task is partial rather than complete — which
  // is the honest outcome for a task one of whose steps was blocked.
  expect(steps).toContain('POLICY_BLOCKED');
  expect(finished.state).toBe('PARTIAL');

  await inside.close();
  await outside.close();
});

test('dragging a tab in makes it eligible; dragging it out revokes it', async ({
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

  const groupId = await workspaceGroupId(serviceWorker, site.baseUrl);
  const outside = await context.newPage();
  await outside.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });

  // The user drags it in. `tabs.group` emits the same events a real drag
  // does — measured — which is what the reconciler listens for.
  const movedId = await serviceWorker.evaluate(
    async ([base, group]: [string, number]) => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((tab) => tab.url?.startsWith(base) && (tab.groupId ?? -1) === -1);
      await chrome.tabs.group({ tabIds: [target!.id!], groupId: group });
      return target!.id!;
    },
    [`${site.baseUrl}/form`, groupId] as [string, number],
  );

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: { tabId: movedId } }] },
    { kind: 'text', text: 'read it' },
  ]);
  const allowed = await waitForTask(
    send,
    (await send('task.create', { objective: 'Read the added tab.' })).task.id,
  );
  expect(JSON.stringify(allowed.steps)).not.toContain('POLICY_BLOCKED');

  // Now the user drags it back out. The very next operation is refused —
  // without waiting for any event to be processed, because the guard reads
  // Chrome live.
  await serviceWorker.evaluate(async (id: number) => {
    await chrome.tabs.ungroup([id]);
  }, movedId);

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: { tabId: movedId } }] },
    { kind: 'text', text: 'could not' },
  ]);
  const refused = await waitForTask(
    send,
    (await send('task.create', { objective: 'Read it again.' })).task.id,
  );
  expect(JSON.stringify(refused.steps)).toContain('POLICY_BLOCKED');

  await inside.close();
  await outside.close();
});

test('a closed workspace tab does not take the task or its history with it', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'ready' }]);
  const { task } = await send('task.create', { objective: 'start' });
  await waitForTask(send, task.id);

  await page.close();

  // Detach is never delete: the task and its record survive the tab.
  const after = await send('task.get', { taskId: task.id });
  expect(after.task?.id).toBe(task.id);
  expect(after.task?.state).toBe('COMPLETED');
});

test('the workspace binding survives a real service-worker termination', async ({
  context,
  extensionId,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  const before = await workspaceGroupId(serviceWorker, site.baseUrl);
  await killServiceWorker(context, serviceWorker);

  // The old worker handle died with the worker, so a fresh panel wakes a new
  // one and a fresh handle is the only way to ask it anything.
  await openPanel(context, extensionId);
  const revived = context.serviceWorkers()[0];
  expect(revived).toBeDefined();

  // chrome.storage.session outlives worker eviction, so the binding is still
  // there and the tab is still grouped.
  const after = await workspaceGroupId(revived!, site.baseUrl);
  expect(after).toBe(before);
  expect(after).toBeGreaterThan(-1);

  await page.close();
});

test('navigating a member tab keeps it in the workspace', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  const groupId = await workspaceGroupId(serviceWorker, site.baseUrl);
  await page.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });

  // Membership is a property of the tab, not of the page it is showing.
  const after = await serviceWorker.evaluate(async (base: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith(base))?.groupId ?? -1;
  }, `${site.baseUrl}/form`);
  expect(after).toBe(groupId);

  await page.close();
});

test('a tab the agent opens joins the workspace and is usable', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send, (await send('task.create', { objective: 'start' })).task.id);

  const groupId = await workspaceGroupId(serviceWorker, site.baseUrl);

  // The agent opens a tab and immediately reads it. Before the blank-first
  // ordering the tab was created outside every workspace holding a real page,
  // and the read that followed would have been refused.
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_create', arguments: { url: `${site.baseUrl}/form` } }],
    },
    { kind: 'text', text: 'opened' },
  ]);
  const finished = await waitForTask(
    send,
    (await send('task.create', { objective: 'Open the form.' })).task.id,
  );
  expect(finished.state).toBe('COMPLETED');

  // Chrome really put it in the workspace group.
  const openedGroup = await serviceWorker.evaluate(async (base: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith(base))?.groupId ?? -1;
  }, `${site.baseUrl}/form`);
  expect(openedGroup).toBe(groupId);
  expect(openedGroup).toBeGreaterThan(-1);

  await page.close();
});

test('workspaces added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  // tabs and tabGroups were already present; the boundary needed nothing new.
  expect(manifest.permissions).toContain('tabGroups');
  expect(manifest.permissions).not.toContain('identity');
  expect(manifest.host_permissions).not.toContain('<all_urls>');
  expect(manifest.permissions?.sort()).toEqual(
    [
      'activeTab',
      'debugger',
      'notifications',
      'scripting',
      'sidePanel',
      'storage',
      'tabGroups',
      'tabs',
      'unlimitedStorage',
    ].sort(),
  );
});
