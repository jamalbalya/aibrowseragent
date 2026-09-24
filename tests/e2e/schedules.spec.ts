/**
 * TEST-E2E-035 — scheduled execution in real Chromium (P-020).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, and the
 * model's side of the conversation comes from a local server speaking the
 * Chat Completions protocol. No production service is contacted.
 *
 * What only a real browser can settle:
 *
 * **That the permission really exists.** `chrome.alarms` is either in the
 * manifest and usable from the shipped worker or it is not, and a unit test
 * cannot tell the difference.
 *
 * **That a schedule survives the worker being killed.** MV3 evicts the
 * service worker constantly. Here the worker is genuinely terminated through
 * CDP and genuinely restarted by Chrome, so "it survives eviction" is a
 * statement about the product rather than about a fake clock.
 *
 * **That an unattended run really drives the page.** The scheduled workflow
 * navigates a real tab through the real content script and the real dispatch
 * path, with the real policy and permission engines deciding every step.
 *
 * **That the confirmation boundary really stops it.** The pair of tests below
 * differs in one thing — the permission mode — and the tab either moves or it
 * does not. Nothing is stubbed in between.
 *
 * The clock is the one thing that cannot be waited for: a daily schedule
 * takes a day. So a schedule's `nextRunAt` is rewritten in `chrome.storage`
 * to an instant that has passed, exactly as if the browser had been closed
 * over it. The occurrence claim, the policy engine, the permission engine and
 * the execution path are all untouched.
 */
import type { Page } from '@playwright/test';
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';
import type { ScriptedReply } from './fixtures/mock-provider';

/**
 * Wakes the worker from a panel that is already open, without focusing it.
 *
 * `openPanel` creates a new tab, which makes the *panel* the active tab — and
 * a run that resolves a workspace around the active tab would then be scoped
 * to an extension page rather than to the site it is meant to drive. Sending
 * a message from a background panel wakes the worker and leaves whatever the
 * test brought to front alone.
 */
async function wakeWorker(panel: Page): Promise<void> {
  await panel.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'session.get', payload: {}, id: 'e2e-wake' });
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

/** Answers every permission prompt, as the side panel would. */
function autoAnswer(
  send: SendToWorker,
  decide: 'approve_once' | 'deny',
): { asked: string[]; stop: () => void } {
  const asked: string[] = [];
  let running = true;

  void (async () => {
    while (running) {
      try {
        const { requests } = await send('permission.listPending', {});
        for (const pending of requests) {
          asked.push(pending.tool);
          await send('permission.respond', { requestId: pending.id, response: { kind: decide } });
        }
      } catch {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  return {
    asked,
    stop: () => {
      running = false;
    },
  };
}

/** Records a one-step navigation workflow and returns its id. */
async function recordWorkflow(
  send: SendToWorker,
  provider: { script: (replies: readonly ScriptedReply[]) => void },
  url: string,
  name = 'Open the test site',
): Promise<string> {
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.navigate', arguments: { url } }] },
    { kind: 'text', text: 'Navigated.' },
  ]);
  const answers = autoAnswer(send, 'approve_once');
  const { task } = await send('task.create', { objective: 'Open the test site.' });
  await send('workflow.recordStart', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);
  answers.stop();

  const saved = await send('workflow.recordStop', {
    name,
    description: 'Recorded from a real task.',
  });
  expect(saved.workflow).not.toBeNull();
  return saved.workflow!.workflowId;
}

/**
 * Points a schedule's clock at an instant that has passed.
 *
 * Written through `chrome.storage.local` from the extension's own panel,
 * which is the only clock a test can move without waiting a day. It changes
 * `nextRunAt` and nothing else — the occurrence claim floor is left exactly
 * where the store put it, so the guard that stops a duplicate run is still
 * the thing deciding.
 */
async function makeDue(panel: Page, scheduleId: string, at: number): Promise<void> {
  const changed = await panel.evaluate(
    async ({ id, when }: { id: string; when: number }) => {
      const key = `schedules:schedules:v1:${id}`;
      const bag = await chrome.storage.local.get(key);
      const stored = bag[key] as { v: number; record: Record<string, unknown> } | undefined;
      if (!stored) return false;
      await chrome.storage.local.set({
        [key]: { ...stored, record: { ...stored.record, nextRunAt: when } },
      });
      return true;
    },
    { id: scheduleId, when: at },
  );
  expect(changed, 'the schedule should be readable in chrome.storage').toBe(true);
}

test('the alarms permission is in the shipped manifest and usable from the worker', async ({
  serviceWorker,
}) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toContain('alarms');

  // Granted, not merely declared: an unusable API here would mean nothing
  // ever wakes the worker for a schedule.
  const usable = await serviceWorker.evaluate(async () => {
    await chrome.alarms.create('aba.e2e-probe', { when: Date.now() + 600_000 });
    const found = await chrome.alarms.get('aba.e2e-probe');
    await chrome.alarms.clear('aba.e2e-probe');
    return found?.name ?? null;
  });
  expect(usable).toBe('aba.e2e-probe');
});

test('creating a schedule arms a real alarm and lists nothing that runs', async ({
  send,
  serviceWorker,
  provider,
  context,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  const tasksBefore = (await send('task.list', { limit: 50 })).tasks.length;

  const created = await send('schedule.create', {
    name: 'Morning check',
    target: { kind: 'workflow', workflowId },
    cadence: { kind: 'daily', hour: 6, minute: 0 },
  });
  expect(created.schedule).not.toBeNull();
  expect(created.schedule!.enabled).toBe(true);
  expect(created.schedule!.nextRunAt).toBeGreaterThan(Date.now());

  // Creating is not running: no task was started.
  expect((await send('task.list', { limit: 50 })).tasks).toHaveLength(tasksBefore);
  expect((await send('schedule.runs', {})).runs).toHaveLength(0);

  const alarm = await serviceWorker.evaluate(() => chrome.alarms.get('aba.schedules'));
  expect(alarm?.name).toBe('aba.schedules');
  expect(alarm?.scheduledTime).toBeGreaterThan(Date.now());
});

test('a due schedule runs unattended after a worker restart, and drives the page', async ({
  context,
  extensionId,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);
  // `browser.navigate` is R1, which Auto mode permits without a prompt. That
  // is the whole of the difference from the next test.
  await send('session.setPermissionMode', { mode: 'auto' });

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  const created = await send('schedule.create', {
    name: 'Morning check',
    target: { kind: 'workflow', workflowId },
    cadence: { kind: 'daily', hour: 6, minute: 0 },
  });
  const scheduleId = created.schedule!.scheduleId;

  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  const panel: Page = await openPanel(context, extensionId);
  await makeDue(panel, scheduleId, Date.now() - 1000);

  // The tab the workflow is meant to drive goes back in front before the
  // worker is revived, so the run resolves a workspace around the site rather
  // than around the panel.
  await target.bringToFront();

  // Genuinely terminate the worker, then let Chrome revive it. Startup is
  // where a schedule that came due while nothing was running is discovered.
  await killServiceWorker(context, serviceWorker);
  await wakeWorker(panel);

  await expect.poll(async () => target.url(), { timeout: 30_000 }).toBe(`${site.baseUrl}/`);

  const runs = await panel.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'schedule.runs',
      payload: {},
      id: 'e2e-runs',
    });
    return response as { ok: boolean; value?: { runs: { status: string; taskId?: string }[] } };
  });
  expect(runs.value?.runs?.[0]?.status).toBe('completed');

  await panel.close();
});

test('a due schedule stops at the confirmation boundary instead of asking', async ({
  context,
  extensionId,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  const created = await send('schedule.create', {
    name: 'Morning check',
    target: { kind: 'workflow', workflowId },
    cadence: { kind: 'daily', hour: 6, minute: 0 },
  });
  const scheduleId = created.schedule!.scheduleId;

  // Manual mode makes the same R1 navigation a confirmation. Nobody is there
  // to answer it, and the run must stop rather than wait or proceed.
  await send('session.setPermissionMode', { mode: 'manual' });

  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  const panel: Page = await openPanel(context, extensionId);
  await makeDue(panel, scheduleId, Date.now() - 1000);
  await target.bringToFront();

  await killServiceWorker(context, serviceWorker);
  await wakeWorker(panel);

  const read = async (): Promise<{ runs: { status: string; reason?: string }[] }> => {
    const response = await panel.evaluate(async () => {
      const result = await chrome.runtime.sendMessage({
        type: 'schedule.runs',
        payload: {},
        id: `e2e-runs-${Math.random()}`,
      });
      return result as { ok: boolean; value?: { runs: { status: string; reason?: string }[] } };
    });
    return { runs: response.value?.runs ?? [] };
  };

  await expect
    .poll(async () => (await read()).runs[0]?.status, { timeout: 30_000 })
    .toBe('blocked');

  const runs = await read();
  expect(runs.runs[0]?.reason).toBe('CONFIRMATION_REQUIRED');

  // The page did not move, and no prompt is sitting in the panel waiting for
  // somebody. Both halves matter: a parked prompt would mean the run is still
  // alive, and a moved page would mean the boundary is not one.
  expect(target.url()).toBe(`${site.baseUrl}/details`);
  const pending = await panel.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({
      type: 'permission.listPending',
      payload: {},
      id: 'e2e-pending',
    });
    return result as { ok: boolean; value?: { requests: unknown[] } };
  });
  expect(pending.value?.requests ?? []).toHaveLength(0);

  await panel.close();
});

test('pausing stops a due schedule from running at all', async ({
  context,
  extensionId,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'auto' });

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  const created = await send('schedule.create', {
    name: 'Morning check',
    target: { kind: 'workflow', workflowId },
    cadence: { kind: 'daily', hour: 6, minute: 0 },
  });
  const scheduleId = created.schedule!.scheduleId;
  await send('schedule.setEnabled', { scheduleId, enabled: false });

  await target.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  const panel: Page = await openPanel(context, extensionId);
  await makeDue(panel, scheduleId, Date.now() - 1000);
  await target.bringToFront();

  await killServiceWorker(context, serviceWorker);
  await wakeWorker(panel);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const runs = await panel.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({
      type: 'schedule.runs',
      payload: {},
      id: 'e2e-runs-paused',
    });
    return result as { ok: boolean; value?: { runs: unknown[] } };
  });
  expect(runs.value?.runs ?? []).toHaveLength(0);
  expect(target.url()).toBe(`${site.baseUrl}/details`);

  await panel.close();
});

test('the schedules screen is in the shipped panel and says what a run will not do', async ({
  context,
  extensionId,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  await send('schedule.create', {
    name: 'Morning check',
    target: { kind: 'workflow', workflowId },
    cadence: { kind: 'daily', hour: 6, minute: 0 },
  });

  const panel: Page = await openPanel(context, extensionId);
  await panel.getByRole('button', { name: 'Schedules' }).click();

  await expect(panel.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  await expect(panel.getByText('Morning check')).toBeVisible();
  // The two honest notes, in the shipped UI rather than in a document.
  await expect(panel.locator('.view__note')).toContainText('it cannot ask you anything');
  await expect(panel.locator('.view__note')).toContainText('never run late');

  // Nothing here offers to remember an approval.
  const body = (await panel.locator('.view').innerText()).toLowerCase();
  expect(body).not.toContain('always allow');
  expect(body).not.toContain('remember this approval');

  await panel.close();
});

test('a model is offered no schedule tool and no schedule appears in its context', async ({
  send,
  provider,
  context,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const workflowId = await recordWorkflow(send, provider, `${site.baseUrl}/`);
  await send('schedule.create', {
    name: 'Morning check',
    target: { kind: 'workflow', workflowId },
    cadence: { kind: 'daily', hour: 6, minute: 0 },
  });

  const { tools } = await send('tools.list', {});
  expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('schedule'))).toEqual([]);

  provider.script([{ kind: 'text', text: 'Nothing to do.' }]);
  const { task } = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, task.id, 40_000);

  const sent = JSON.stringify(provider.requests);
  expect(sent).not.toContain('Morning check');
  expect(sent).not.toContain('schedule.create');
});
