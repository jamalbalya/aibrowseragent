/**
 * TEST-E2E-022 — the workspace control surface, in a real browser.
 *
 * MOCK PROVIDER E2E. Nothing here is evidence about a commercial provider.
 *
 * W-6 adds the routes a person uses to change what the agent can see. These
 * drive those routes against real Chrome tab groups: a workspace that really
 * exists, tabs Chrome really moved, and a guard that really refuses.
 *
 * `chrome.tabs.group` / `ungroup` stand in for a human dragging a tab. They
 * emit the identical events — measured — but they are the API, not a mouse,
 * and the genuine drag stays classified HUMAN/ENVIRONMENT in the design
 * document rather than being claimed here.
 */
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
} from './fixtures/extension';

test('the panel reports the active workspace and its live tabs', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);

  const created = await send('workspace.create', {});
  expect(created.attached).toBe(true);

  const state = await send('workspace.state', {});
  expect(state.activeWorkspaceId).toBe(created.workspaceId);
  expect(state.workspaces.find((w) => w.isActive)?.state).toBe('attached');
  // Live, from Chrome: the tab the workspace was started from.
  expect(state.tabs.length).toBe(1);
  expect(state.currentTab?.inActiveWorkspace).toBe(true);

  await page.close();
});

test('an outside tab is reported as outside, and is not added by looking at it', async ({
  context,
  send,
  provider,
  site,
}) => {
  const inside = await context.newPage();
  await inside.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await inside.bringToFront();
  await connectProvider(send, provider);
  await send('workspace.create', {});

  const outside = await context.newPage();
  await outside.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });
  await outside.bringToFront();

  const before = await send('workspace.state', {});
  // Said, not done: the agent's reach did not change because the user
  // switched tabs, and the workspace did not follow them either.
  expect(before.currentTab?.inActiveWorkspace).toBe(false);
  expect(before.tabs.length).toBe(1);

  const added = await send('workspace.addCurrentTab', {});
  expect(added.added).toBe(true);

  const after = await send('workspace.state', {});
  expect(after.currentTab?.inActiveWorkspace).toBe(true);
  expect(after.tabs.length).toBe(2);

  await inside.close();
  await outside.close();
});

test('removing a tab detaches it and leaves everything else intact', async ({
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
  const { workspaceId } = await send('workspace.create', {});
  const { task } = await send('task.create', { objective: 'start' });
  await waitForTask(send, task.id);

  const state = await send('workspace.state', {});
  const tabId = state.tabs[0]!.tabId;
  const removed = await send('workspace.removeTab', { tabId });
  expect(removed.removed).toBe(true);

  const after = await send('workspace.state', {});
  // Detach, never delete: the workspace and the task are both still there.
  expect(after.workspaces.some((w) => w.workspaceId === workspaceId)).toBe(true);
  expect((await send('task.get', { taskId: task.id })).task?.id).toBe(task.id);
  expect(after.tabs.length).toBe(0);

  await page.close();
});

test('two workspaces in one window stay isolated, and neither can target the other', async ({
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
  const a = await send('workspace.create', {});

  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });
  await second.bringToFront();
  const b = await send('workspace.create', {});

  expect(a.workspaceId).not.toBe(b.workspaceId);

  // Workspace B is active and sees only its own tab.
  const inB = await send('workspace.state', {});
  expect(inB.activeWorkspaceId).toBe(b.workspaceId);
  expect(inB.tabs.length).toBe(1);
  const bTabId = inB.tabs[0]!.tabId;

  // Switch to A: it must not see B's tab, and must not be able to remove it.
  await send('workspace.switch', { workspaceId: a.workspaceId });
  const inA = await send('workspace.state', {});
  expect(inA.tabs.length).toBe(1);
  expect(inA.tabs.map((t) => t.tabId)).not.toContain(bTabId);

  const refused = await send('workspace.removeTab', { tabId: bTabId });
  expect(refused.removed).toBe(false);
  expect(refused.error).toBeDefined();

  // And Chrome still has B's tab in B's group, untouched by the attempt.
  const stillGrouped = await serviceWorker.evaluate(
    async (id: number) => (await chrome.tabs.get(id)).groupId,
    bTabId,
  );
  expect(stillGrouped).toBeGreaterThan(-1);

  await first.close();
  await second.close();
});

test('switching workspace leaves the AI brain exactly where it was', async ({
  context,
  send,
  provider,
  site,
}) => {
  const first = await context.newPage();
  await first.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await first.bringToFront();
  await connectProvider(send, provider);

  const account = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-brain-aaaaaaaa',
    model: 'mock-model',
  });
  await send('accounts.setBrain', {
    connectionId: account.account!.connectionId,
    modelId: 'mock-model',
  });
  const brainBefore = (await send('accounts.list', {})).brain;

  const a = await send('workspace.create', {});
  const second = await context.newPage();
  await second.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });
  await second.bringToFront();
  await send('workspace.create', {});
  await send('workspace.switch', { workspaceId: a.workspaceId });

  // Two independent dimensions. Switching one moves nothing in the other.
  expect((await send('accounts.list', {})).brain).toEqual(brainBefore);
  expect((await send('workspace.state', {})).activeWorkspaceId).toBe(a.workspaceId);

  await first.close();
  await second.close();
});

test('the tab list follows a real drag in and a real drag out', async ({
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
  await send('workspace.create', {});
  const groupId = (await send('workspace.state', {})).tabs[0]
    ? await serviceWorker.evaluate(
        async (id: number) => (await chrome.tabs.get(id)).groupId,
        (await send('workspace.state', {})).tabs[0]!.tabId,
      )
    : -1;
  expect(groupId).toBeGreaterThan(-1);

  const other = await context.newPage();
  await other.goto(`${site.baseUrl}/form`, { waitUntil: 'domcontentloaded' });

  // Dragged in.
  const movedId = await serviceWorker.evaluate(
    async ([base, group]: [string, number]) => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => t.url?.startsWith(base) && (t.groupId ?? -1) === -1);
      await chrome.tabs.group({ tabIds: [target!.id!], groupId: group });
      return target!.id!;
    },
    [`${site.baseUrl}/form`, groupId] as [string, number],
  );
  expect((await send('workspace.state', {})).tabs.map((t) => t.tabId)).toContain(movedId);

  // Dragged back out.
  await serviceWorker.evaluate(async (id: number) => {
    await chrome.tabs.ungroup([id]);
  }, movedId);
  expect((await send('workspace.state', {})).tabs.map((t) => t.tabId)).not.toContain(movedId);

  await page.close();
  await other.close();
});

test('a closed tab stops being listed without taking the workspace with it', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  const { workspaceId } = await send('workspace.create', {});

  await page.close();

  const state = await send('workspace.state', {});
  // The workspace survives; it is simply detached, because Chrome deletes a
  // group when its last tab leaves.
  expect(state.workspaces.some((w) => w.workspaceId === workspaceId)).toBe(true);
  expect(state.tabs.length).toBe(0);
});

test('workspace identity survives a real service-worker termination', async ({
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
  const { workspaceId } = await send('workspace.create', {});

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  const state = await panel.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'workspace.state',
      payload: {},
      requestId: 'probe-1',
    });
    return response as { ok: boolean; value?: { activeWorkspaceId: string | null } };
  });
  expect(state.value?.activeWorkspaceId).toBe(workspaceId);

  await page.close();
});

test('the workspace UI added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.host_permissions).not.toContain('<all_urls>');
  expect(manifest.permissions?.sort()).toEqual(
    [
      'activeTab',
      'alarms',
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
