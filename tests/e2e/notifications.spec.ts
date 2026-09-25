/**
 * TEST-E2E-044 — Task-ending notifications, in real Chromium (§53).
 *
 * ## What this can and cannot observe
 *
 * Headless Chromium draws no notifications, so nothing here looks at a toast.
 * What it does do is watch the boundary: `chrome.notifications.create` is
 * replaced inside the **real service worker** with a recorder, and then a real
 * task is driven to a real terminal state through the real runtime.
 *
 * So the extension's own code is untouched — the policy engine, the task
 * manager, the lifecycle observer and the notifier all run exactly as shipped.
 * The only substitution is at the browser API itself, which is the one thing
 * this environment genuinely cannot surface. That is a narrower claim than
 * "the user saw a toast" and a much wider one than the unit suite's, which
 * cannot show that the worker is wired to the lifecycle at all.
 *
 * `chromeNotificationPort` dereferences `chrome.notifications.create` at call
 * time rather than capturing it, so patching it after the worker has loaded is
 * enough — and if that ever stops being true, these tests see zero
 * notifications rather than passing quietly.
 */
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
  ask,
} from './fixtures/extension';
import type { Worker } from '@playwright/test';

interface Recorded {
  readonly title: string;
  readonly message: string;
}

/** Replaces the browser's notification API with a recorder, in the worker. */
async function recordNotifications(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const scope = globalThis as unknown as { __abaNotices?: unknown[] };
    scope.__abaNotices = [];
    chrome.notifications.create = (options: unknown) => {
      (scope.__abaNotices as unknown[]).push(options);
      return Promise.resolve('recorded');
    };
  });
}

async function recorded(worker: Worker): Promise<Recorded[]> {
  return await worker.evaluate(
    () => (globalThis as unknown as { __abaNotices?: Recorded[] }).__abaNotices ?? [],
  );
}

/** Everything the worker was asked to show, as one string. */
const asText = (notices: readonly Recorded[]): string => JSON.stringify(notices);

test('a task that finishes tells the user, once', async ({
  context,
  send,
  serviceWorker,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await recordNotifications(serviceWorker);
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'The catalogue lists three widget sizes.' }]);

  const { task } = await send('task.create', { objective: 'Summarise the catalogue.' });
  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state).toBe('COMPLETED');

  const notices = await recorded(serviceWorker);
  const endings = notices.filter((notice) => notice.title.startsWith('Task'));
  expect(endings).toHaveLength(1);
  expect(endings[0]?.title).toBe('Task finished');
});

test('the notification carries nothing the task read, typed or was told', async ({
  context,
  send,
  serviceWorker,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await recordNotifications(serviceWorker);
  await connectProvider(send, provider);
  // A page read, so real page text is genuinely in the task by the time it
  // ends — otherwise the assertion below would hold for the wrong reason.
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'Widgets: small, medium and large. Reference model-marker-8821.' },
  ]);

  // Distinctive but not secret-shaped. A key-shaped objective is refused by
  // the field and secret guards long before the task ends, so using one here
  // would prove only that the task failed — the wrong thing, for the wrong
  // reason. What is under test is that an ordinary objective, an ordinary
  // model reply and real page text all stay out of the toast.
  const objective = 'Read the catalogue and note its sizes, reference typed-marker-3390.';
  const { task } = await send('task.create', { objective });
  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state).toBe('COMPLETED');
  // The page really was read, so the task really does hold page text.
  expect(finished.result?.completedActions ?? []).toContain('browser.read_page');

  const text = asText(await recorded(serviceWorker));
  // Nothing the user typed, nothing the model wrote, nothing from the page.
  expect(text).not.toContain('typed-marker-3390');
  expect(text).not.toContain('model-marker-8821');
  expect(text).not.toContain('widget');
  expect(text).not.toContain('Widgets');
  expect(text).not.toContain(site.baseUrl);
  expect(text).not.toContain(task.id);
});

test('a task the user cancelled says nothing, because they already know', async ({
  context,
  send,
  serviceWorker,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await recordNotifications(serviceWorker);
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Working.' }]);

  const { task } = await send('task.create', { objective: 'Summarise the catalogue.' });
  await send('task.cancel', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const endings = (await recorded(serviceWorker)).filter((n) => n.title.startsWith('Task'));
  expect(endings).toEqual([]);
});

test('the user turning notifications off is honoured by the worker', async ({
  context,
  send,
  serviceWorker,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await recordNotifications(serviceWorker);
  await send('settings.setNotificationsEnabled', { enabled: false });
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Done.' }]);

  const { task } = await send('task.create', { objective: 'Summarise the catalogue.' });
  expect((await waitForTask(send, task.id, 40_000)).state).toBe('COMPLETED');

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const endings = (await recorded(serviceWorker)).filter((n) => n.title.startsWith('Task'));
  expect(endings).toEqual([]);
});

test('a finished task is not announced again by a revived worker', async ({
  context,
  send,
  serviceWorker,
  extensionId,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Done.' }]);
  const { task } = await send('task.create', { objective: 'Summarise the catalogue.' });
  expect((await waitForTask(send, task.id, 40_000)).state).toBe('COMPLETED');

  // The guard against a second toast is in memory, and this is the claim that
  // makes that sufficient: a revived worker reconciles only interrupted tasks,
  // so an already-finished one is never transitioned again and never reaches
  // the notifier a second time. Recording *after* the restart means anything
  // the new worker announces is necessarily a duplicate.
  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);
  const revived = context.serviceWorkers()[0]!;
  await recordNotifications(revived);

  // Wake the worker and let recovery finish, then look.
  await ask(panel, 'task.list', {});
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const endings = (await recorded(revived)).filter((n) => n.title.startsWith('Task'));
  expect(endings).toEqual([]);
});

test('the panel offers a switch, and turning it off actually silences the worker', async ({
  context,
  panel,
  send,
  serviceWorker,
  provider,
  site,
}) => {
  // The setting was readable by the notifier from the first wave and writable
  // by nothing, so it was on for everyone, permanently. That mattered little
  // when the only notifications were an approval being asked for; it matters
  // now that every task ending produces one.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });

  await panel.getByRole('button', { name: 'Settings' }).click();
  const toggle = panel.getByTestId('notifications-enabled');
  await toggle.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(toggle).toBeChecked();

  await toggle.uncheck();
  // Read back from the worker, not from the checkbox: a control that reports
  // a setting it failed to save is worse than no control.
  await expect
    .poll(async () => (await send('settings.getNotificationsEnabled', {})).enabled, {
      timeout: 10_000,
    })
    .toBe(false);

  await page.bringToFront();
  await recordNotifications(serviceWorker);
  await connectProvider(send, provider);
  provider.script([{ kind: 'text', text: 'Done.' }]);

  const { task } = await send('task.create', { objective: 'Summarise the catalogue.' });
  expect((await waitForTask(send, task.id, 40_000)).state).toBe('COMPLETED');

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const endings = (await recorded(serviceWorker)).filter((n) => n.title.startsWith('Task'));
  expect(endings).toEqual([]);
});
