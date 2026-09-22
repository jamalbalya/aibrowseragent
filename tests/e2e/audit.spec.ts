/**
 * TEST-E2E-014 — the unified audit trail in real Chromium (Wave J, P-038).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, and the
 * model's side of the conversation comes from a local server. No production
 * service is contacted.
 *
 * What only a real browser can settle:
 *
 * **That the observer is really wired.** The audit adapter sits on the
 * production registry's hook; a unit test supplies its own.
 *
 * **That the trail survives a real worker death.** MV3 evicts the worker
 * constantly, and a sequence allocated in memory would restart beside a trail
 * that did not.
 *
 * **That the export really writes a file, with nothing forbidden in it.** The
 * bytes are read off disk and searched.
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

test('a genuine browser action leaves a record in the trail', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    { kind: 'text', text: 'Read it.' },
  ]);
  const { task } = await send('task.create', { objective: 'Read this page.' });
  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state).toBe('COMPLETED');

  const page = await send('audit.list', { taskId: task.id, limit: 50 });
  const types = page.events.map((event) => event.type);

  // The execution itself, and the task lifecycle around it — the types that
  // were declared from the start and never written until now.
  expect(types).toContain('tool.invoked');
  expect(types).toContain('task.created');
  const invoked = page.events.find((event) => event.type === 'tool.invoked');
  expect(invoked?.tool).toBe('browser.read_page');
  expect(invoked?.outcome).toBe('allowed');
  expect(invoked?.executed).toBe(true);

  // And nothing about what the page said.
  expect(JSON.stringify(page.events)).not.toContain('Widget Catalogue');
});

test('a permission refusal is recorded, and nothing ran', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });

  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser.navigate', arguments: { url: `${site.baseUrl}/details` } }],
    },
    { kind: 'text', text: 'Could not.' },
  ]);
  const answers = autoAnswer(send, 'deny');
  const { task } = await send('task.create', { objective: 'Open the details page.' });
  await waitForTask(send, task.id, 40_000);
  answers.stop();

  const page = await send('audit.list', { taskId: task.id, limit: 50 });
  const types = page.events.map((event) => event.type);
  expect(types).toContain('permission.decided');
  expect(types).toContain('tool.refused');

  const refused = page.events.find((event) => event.type === 'tool.refused');
  expect(refused?.outcome).toBe('denied');
  expect(refused?.executed).toBe(false);
  // The browser did not move.
  expect(target.url()).toBe(`${site.baseUrl}/`);
});

test('the trail keeps its sequence across a real worker termination', async ({
  context,
  serviceWorker,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    { kind: 'text', text: 'Read.' },
  ]);
  const { task } = await send('task.create', { objective: 'Read this page.' });
  await waitForTask(send, task.id, 40_000);

  const before = await send('audit.list', { limit: 200 });
  const highestBefore = Math.max(...before.events.map((event) => event.seq));
  expect(highestBefore).toBeGreaterThan(0);

  // A real kill, not a reload: the worker's memory is gone.
  await killServiceWorker(context, serviceWorker);

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    { kind: 'text', text: 'Read again.' },
  ]);
  const second = await send('task.create', { objective: 'Read it again.' });
  await waitForTask(send, second.task.id, 40_000);

  const after = await send('audit.list', { limit: 200 });
  const highestAfter = Math.max(...after.events.map((event) => event.seq));

  // The records from before are still there, and the sequence carried on
  // rather than restarting beside them.
  expect(after.total).toBeGreaterThan(before.total);
  expect(highestAfter).toBeGreaterThan(highestBefore);

  const integrity = await send('audit.integrity', {});
  expect(['ok', 'truncated']).toContain(integrity.verdict);
});

test('a workflow replay and a shortcut launch are recorded by their own ids', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser.navigate', arguments: { url: `${site.baseUrl}/` } }],
    },
    { kind: 'text', text: 'Navigated.' },
  ]);
  const { task } = await send('task.create', { objective: 'Open the site.' });
  await send('workflow.recordStart', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);
  const saved = await send('workflow.recordStop', {
    name: 'Open the site',
    description: 'Recorded.',
  });
  const workflowId = saved.workflow!.workflowId;

  await send('shortcut.create', { name: 'open-it', target: { kind: 'workflow', workflowId } });
  await send('shortcut.resolve', { typed: '/open-it' });
  await send('workflow.replay', { workflowId, inputs: {} });

  const page = await send('audit.list', { limit: 200 });
  const types = page.events.map((event) => event.type);
  expect(types).toContain('workflow.recorded');
  expect(types).toContain('workflow.replay');
  expect(types).toContain('shortcut.resolved');

  const replay = page.events.find((event) => event.type === 'workflow.replay');
  expect(replay?.workflowId).toBe(workflowId);
  expect(replay?.skillHash).toMatch(/^[0-9a-f]{64}$/);

  const resolved = page.events.find((event) => event.type === 'shortcut.resolved');
  expect(resolved?.shortcutId).toMatch(/^shortcut/);
  // The name the user typed is theirs, and is not in the trail.
  expect(JSON.stringify(page.events)).not.toContain('open-it');
});

test('two tasks stay apart in the one trail', async ({ context, send, provider, site }) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const ids: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    provider.script([
      { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
      { kind: 'text', text: 'Read.' },
    ]);
    const { task } = await send('task.create', { objective: `Read it, round ${index}.` });
    await waitForTask(send, task.id, 40_000);
    ids.push(task.id);
  }

  const [firstId, secondId] = ids;
  if (firstId === undefined || secondId === undefined) throw new Error('two tasks were expected.');
  const first = await send('audit.list', { taskId: firstId, limit: 100 });
  const second = await send('audit.list', { taskId: secondId, limit: 100 });

  expect(first.total).toBeGreaterThan(0);
  expect(second.total).toBeGreaterThan(0);
  expect(first.events.every((event) => event.taskId === firstId)).toBe(true);
  expect(second.events.every((event) => event.taskId === secondId)).toBe(true);
});

test('the panel exports a file holding decisions and nothing forbidden', async ({
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

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    { kind: 'text', text: 'Read.' },
  ]);
  const { task } = await send('task.create', { objective: 'Read this page.' });
  await waitForTask(send, task.id, 40_000);

  const panel: Page = await openPanel(context, extensionId);
  await panel.getByRole('button', { name: 'Activity' }).click();

  // The real panel, exporting through a blob of this extension's own origin.
  const download = panel.waitForEvent('download', { timeout: 20_000 });
  await panel.getByTestId('audit-export-all').click();
  const file = await download;

  expect(file.suggestedFilename()).toMatch(/^audit-all-\d{14}\.json$/);

  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path, 'utf8');
  const parsed = JSON.parse(bytes) as {
    format: string;
    scope: { kind: string };
    integrity: { verdict: string };
    events: { type: string }[];
  };

  expect(parsed.format).toBe('aiba-audit/2');
  expect(parsed.scope.kind).toBe('all');
  expect(parsed.integrity.verdict).toBeDefined();
  expect(parsed.events.some((event) => event.type === 'tool.invoked')).toBe(true);

  // Nothing forbidden reached the file that landed on disk.
  for (const forbidden of [
    'Widget Catalogue',
    'hunter2',
    'arguments',
    '"result"',
    'selector',
    'taintSignature',
  ]) {
    expect(bytes, forbidden).not.toContain(forbidden);
  }
  await panel.close();
});

test('the panel shows the integrity verdict and never offers a delete', async ({
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

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    { kind: 'text', text: 'Read.' },
  ]);
  const { task } = await send('task.create', { objective: 'Read this page.' });
  await waitForTask(send, task.id, 40_000);

  const panel: Page = await openPanel(context, extensionId);
  await panel.getByRole('button', { name: 'Activity' }).click();
  await expect(panel.getByTestId('audit-integrity')).toContainText(/Consistent|evicted/);
  await expect(panel.getByTestId('audit-list')).toBeVisible();

  // A trail the audited thing can erase is not a trail. Deletion is
  // deliberately not offered here.
  const body = await panel.locator('body').innerText();
  expect(body).not.toMatch(/\bclear\b/i);
  expect(body).not.toMatch(/\bdelete\b/i);
  await panel.close();
});

test('audit added no permission and is invisible to the model', async ({ send, serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions ?? []).toEqual([
    'sidePanel',
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabGroups',
    'scripting',
    'debugger',
    'notifications',
    'activeTab',
  ]);
  expect(manifest.host_permissions ?? []).toEqual(['http://*/*', 'https://*/*']);
  // `downloads` is still optional and still not requested: the export needs
  // no permission at all.
  const granted = await serviceWorker.evaluate(async () => await chrome.permissions.getAll());
  expect(granted.permissions ?? []).not.toContain('downloads');

  const { tools } = await send('tools.list', {});
  expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('audit.'))).toEqual([]);
});
