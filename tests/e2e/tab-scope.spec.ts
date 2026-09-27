/**
 * TEST-E2E-047 — the workspace boundary on every tab tool that takes an id.
 *
 * MOCK PROVIDER E2E. The endpoint is a local server; nothing here is evidence
 * about a commercial provider.
 *
 * Five tools took an explicit `tabId` and checked only that the tab existed.
 * The central workspace check in the registry does not cover them, because it
 * guards the run's *ambient* tab rather than a tool argument. Measured in this
 * browser, before the guards below existed, on a tab the user had never put in
 * scope:
 *
 * - `tabs.wait_for_navigation` returned its URL **and title** — at R0, with no
 *   prompt. The same disclosure `tabs.list` was narrowed to prevent.
 * - `tabs.activate` focused it and returned its URL.
 * - `tabs.reload` re-ran it and reported success, a tool whose own declared
 *   side effect is that it "may resubmit a form".
 * - `tabs.group` put the task's own tab into a new group, which emptied the
 *   workspace group. A group with no tabs ceases to exist, so every later call
 *   in that same task was refused: the model had destroyed its own scope.
 * - `tabs.ungroup` did the same with one call.
 *
 * Each test below is written so that an earlier guard cannot produce the
 * result: the out-of-workspace tab is never the ambient tab, because focus is
 * returned to a member before the task starts. Without that, the registry's
 * central check refuses everything up front and the suite passes while proving
 * nothing — which is how the first version of the Wave 14 equivalent went
 * green.
 */
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

type Worker = { evaluate: <T, A>(fn: (arg: A) => Promise<T> | T, arg: A) => Promise<T> };

/** What the model was handed back, from the requests the extension really sent. */
const toldTheModel = (provider: { readonly requests: readonly unknown[] }, from: number): string =>
  JSON.stringify(provider.requests.slice(from)).replace(/\\/g, '');

async function tabIdFor(worker: Worker, url: string): Promise<number> {
  const id = await worker.evaluate(async (target: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)?.id ?? -1;
  }, url);
  expect(id).toBeGreaterThan(-1);
  return id;
}

const groupOf = async (worker: Worker, tabId: number): Promise<number> =>
  await worker.evaluate(async (id: number) => (await chrome.tabs.get(id)).groupId ?? -1, tabId);

/**
 * A running task with a workspace, plus an ungrouped tab outside it.
 *
 * Returns with a workspace tab focused, so the ambient-tab check cannot be
 * what refuses the calls under test.
 */
async function scopedTask(
  context: {
    newPage: () => Promise<{
      goto: (u: string, o?: unknown) => Promise<unknown>;
      bringToFront: () => Promise<void>;
      close: () => Promise<void>;
    }>;
  },
  worker: Worker,
  send: (t: string, p?: unknown) => Promise<any>,
  provider: { script: (r: readonly unknown[]) => void; readonly requests: readonly unknown[] },
  baseUrl: string,
) {
  const inside = await context.newPage();
  await inside.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await inside.bringToFront();
  await connectProvider(send, provider as never);

  provider.script([{ kind: 'text', text: 'ready' }]);
  await waitForTask(send as never, (await send('task.create', { objective: 'start' })).task.id);
  const insideId = await tabIdFor(worker, `${baseUrl}/`);

  const outside = await context.newPage();
  await outside.goto(`${baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  const outsideId = await tabIdFor(worker, `${baseUrl}/details`);
  await inside.bringToFront();

  return { inside, outside, insideId, outsideId };
}

test('no tab tool will read, focus or reload a tab outside the workspace', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const { inside, outside, outsideId } = await scopedTask(
    context as never,
    serviceWorker,
    send as never,
    provider as never,
    site.baseUrl,
  );

  const from = provider.requests.length;
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_wait_for_navigation', arguments: { tabId: outsideId } }],
    },
    { kind: 'tool_calls', calls: [{ name: 'tabs_activate', arguments: { tabId: outsideId } }] },
    { kind: 'tool_calls', calls: [{ name: 'tabs_reload', arguments: { tabId: outsideId } }] },
    { kind: 'text', text: 'could not' },
  ]);
  const task = await waitForTask(
    send,
    (await send('task.create', { objective: 'Poke the other tab.' })).task.id,
  );

  const transcript = toldTheModel(provider, from);
  expect(task.state).toBe('PARTIAL');
  // All three refused, and none of them leaked what is in that tab.
  expect(transcript).toContain('POLICY_BLOCKED');
  expect(transcript).not.toContain('Widget Details');
  expect(transcript).not.toContain('"reloaded":true');
  expect(transcript).not.toContain('"loaded":true');

  await outside.close();
  await inside.close();
});

test('the model cannot pull its own tab out of its workspace with tabs.group', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const { inside, outside, insideId, outsideId } = await scopedTask(
    context as never,
    serviceWorker,
    send as never,
    provider as never,
    site.baseUrl,
  );
  const workspaceGroup = await groupOf(serviceWorker, insideId);
  expect(workspaceGroup).toBeGreaterThan(-1);

  const from = provider.requests.length;
  provider.script([
    // The out-of-workspace tab is refused outright.
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_group', arguments: { tabIds: [insideId, outsideId] } }],
    },
    // Its own tab is allowed, and must stay where it is.
    {
      kind: 'tool_calls',
      calls: [{ name: 'tabs_group', arguments: { tabIds: [insideId], title: 'Research' } }],
    },
    // Still in scope afterwards: the group did not move.
    { kind: 'tool_calls', calls: [{ name: 'tabs_get', arguments: { tabId: insideId } }] },
    { kind: 'text', text: 'done' },
  ]);
  const task = await waitForTask(
    send,
    (await send('task.create', { objective: 'Reorganise the tabs.' })).task.id,
  );

  const transcript = toldTheModel(provider, from);
  expect(transcript).toContain('POLICY_BLOCKED');
  // The workspace group is the same group it was: joining, not creating.
  expect(await groupOf(serviceWorker, insideId)).toBe(workspaceGroup);
  // And the tab outside was never taken in.
  expect(await groupOf(serviceWorker, outsideId)).toBe(-1);
  // The task kept working, which is what the old behaviour destroyed.
  expect(transcript).toContain(`"tabId":${insideId}`);
  expect(task.state).toBe('PARTIAL');

  await outside.close();
  await inside.close();
});

test('the model cannot empty its own workspace with tabs.ungroup', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const { inside, outside, insideId } = await scopedTask(
    context as never,
    serviceWorker,
    send as never,
    provider as never,
    site.baseUrl,
  );
  const workspaceGroup = await groupOf(serviceWorker, insideId);

  const from = provider.requests.length;
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'tabs_ungroup', arguments: { tabIds: [insideId] } }] },
    // If the ungroup had gone through, the workspace would be gone and this
    // would fail for that reason instead.
    { kind: 'tool_calls', calls: [{ name: 'tabs_get', arguments: { tabId: insideId } }] },
    { kind: 'text', text: 'done' },
  ]);
  await waitForTask(send, (await send('task.create', { objective: 'Release my tab.' })).task.id);

  const transcript = toldTheModel(provider, from);
  expect(transcript).toContain('remove the last tab');
  expect(transcript).toContain('POLICY_BLOCKED');
  expect(await groupOf(serviceWorker, insideId)).toBe(workspaceGroup);
  expect(transcript).toContain(`"tabId":${insideId}`);

  await outside.close();
  await inside.close();
});
