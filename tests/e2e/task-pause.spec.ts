/**
 * TEST-E2E-045 — pause, resume and cancel in real Chromium (§5.1, §57, §76).
 *
 * ## Why this suite exists rather than an integration test
 *
 * There was an integration test asserting that a paused task's stored state is
 * `PAUSED`, and it passed while pausing was destroying tasks in the browser.
 * It read the state at the instant `pause()` returned; the runtime overwrote it
 * with `CANCELLED` a moment later, and nothing looked again.
 *
 * So every assertion here is made **after a delay long enough for the old
 * defect to land**, against the real extension in a real worker. The decisive
 * property is not what `task.pause` returns — the old code returned `PAUSED`
 * too — it is what the task still is a second later, and whether a resume then
 * carries it to completion.
 */
import {
  ask,
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';
import type { BrowserContext } from '@playwright/test';
import type { MockProvider, ScriptedReply } from './fixtures/mock-provider';
import type { TestSite } from './fixtures/test-site';

/** Long enough that the pre-fix CANCELLED write would have landed. */
const SETTLE_MS = 1500;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, SETTLE_MS));

/** A script with enough turns that the task is still running when paused. */
function longScript(): readonly ScriptedReply[] {
  const read: ScriptedReply = {
    kind: 'tool_calls',
    calls: [{ name: 'browser_read_page', arguments: {} }],
  };
  return [read, read, read, read, { kind: 'text', text: 'Done.' }];
}

/** Waits until the task is genuinely executing, not merely created. */
async function reachRunning(send: SendToWorker, taskId: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = (await send('task.get', { taskId })).task?.state;
    if (state === 'RUNNING' || state === 'WAITING_FOR_TOOL') return state;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The task never started running.');
}

const stateOf = async (send: SendToWorker, taskId: string): Promise<string | undefined> =>
  (await send('task.get', { taskId })).task?.state;

async function startLongTask(
  context: BrowserContext,
  send: SendToWorker,
  provider: MockProvider,
  site: TestSite,
  script: readonly ScriptedReply[] = longScript(),
): Promise<string> {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  provider.script(script);
  const { task } = await send('task.create', { objective: 'Read the page several times.' });
  await reachRunning(send, task.id);
  return task.id;
}

test('a paused task is still paused a second later, and stays paused', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);

  expect(await send('task.pause', { taskId })).toMatchObject({ state: 'PAUSED' });

  // The assertion the old integration test could not make. Before the fix the
  // task was CANCELLED by now.
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  // And it is durable rather than briefly true.
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');
});

test('a paused task resumes and reaches its expected completion', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);

  await send('task.pause', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  await send('task.resume', { taskId });
  const finished = await waitForTask(send, taskId, 60_000);
  // The whole point of a resume: the task finishes, rather than being retried
  // from nothing or left stuck.
  expect(finished.state).toBe('COMPLETED');
});

test('a paused task survives worker eviction and still resumes', async ({
  context,
  send,
  serviceWorker,
  extensionId,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);
  await send('task.pause', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);

  // A revived worker reconciles interrupted tasks on startup. PAUSED is not
  // terminal, so it is in that set — and it must come back paused rather than
  // be swept into a terminal state by recovery.
  const revived = await ask<{ task?: { state?: string } }>(panel, 'task.get', { taskId });
  expect(revived.task?.state).toBe('PAUSED');

  await ask(panel, 'task.resume', { taskId });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const now = (await ask<{ task?: { state?: string } }>(panel, 'task.get', { taskId })).task
      ?.state;
    if (now !== undefined && ['COMPLETED', 'PARTIAL', 'FAILED', 'BLOCKED'].includes(now)) {
      // `COMPLETED` is deliberately not demanded here. Killing the worker also
      // severs the content script in a tab that was already open, which this
      // build reports as the page needing a reload — so a task that reads the
      // page after an eviction can legitimately finish PARTIAL. What this test
      // is about is that the pause survived, the resume ran, and the task
      // reached an end of its own rather than being cancelled by the abort
      // that paused it.
      expect(now).not.toBe('CANCELLED');
      expect(['COMPLETED', 'PARTIAL']).toContain(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('The resumed task never finished.');
});

test('cancelling a running task cancels it, and it stays cancelled', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);

  expect(await send('task.cancel', { taskId })).toMatchObject({ state: 'CANCELLED' });
  await settle();
  expect(await stateOf(send, taskId)).toBe('CANCELLED');
});

test('a paused task can still be cancelled, and cancellation is terminal', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);

  await send('task.pause', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  await send('task.cancel', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('CANCELLED');

  // The existing contract: a cancelled task is retried, never resumed.
  await expect(send('task.resume', { taskId })).rejects.toThrow();
});

test('pause immediately followed by cancel settles as cancelled', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);

  // Issued back to back with no wait between them, which is the ordering a
  // person clicking twice actually produces.
  await send('task.pause', { taskId });
  await send('task.cancel', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('CANCELLED');
});

test('pausing a task that already ended reports what it really is', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);
  await send('task.cancel', { taskId });
  await settle();
  const ended = await stateOf(send, taskId);

  // §76. Pausing something that has already finished must report the state it
  // is actually in, not the state that was asked for — otherwise the caller
  // offers a resume for a task that can never have one. Which terminal state a
  // cancelled-then-torn-down task lands in is not what this asserts; that it
  // is terminal, and that pause says so rather than saying PAUSED, is.
  const afterPause = await send('task.pause', { taskId });
  expect(afterPause).toMatchObject({ state: ended });
  expect(['CANCELLED', 'FAILED', 'COMPLETED', 'PARTIAL', 'BLOCKED']).toContain(ended);
  await settle();
  expect(await stateOf(send, taskId)).toBe(ended);
});

test('pausing twice and resuming twice leaves one coherent task', async ({
  context,
  send,
  provider,
  site,
}) => {
  const taskId = await startLongTask(context, send, provider, site);

  await send('task.pause', { taskId });
  // A second pause is a no-op rather than an error or a different state.
  expect(await send('task.pause', { taskId })).toMatchObject({ state: 'PAUSED' });
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  await send('task.resume', { taskId });
  // A second resume must not start a second run of the same task.
  await send('task.resume', { taskId });
  const finished = await waitForTask(send, taskId, 60_000);
  expect(finished.state).toBe('COMPLETED');
});

test('pausing does not run the cleanup that belongs to a finished task', async ({
  context,
  send,
  provider,
  site,
}) => {
  // A pause is not an ending, so nothing that happens at an ending may happen
  // here: no `task.completed` record, and none of the terminal cleanup hung off
  // that same observation — a paused task's staged files still belong to it.
  const taskId = await startLongTask(context, send, provider, site);

  await send('task.pause', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  const { events } = await send('audit.list', { taskId, limit: 200 });
  const types = events.map((event) => event.type);
  expect(types).not.toContain('task.completed');
  // The pause itself is on the record as an ordinary state change.
  expect(types).toContain('task.state');

  // And once it really does end, the ending is recorded exactly once.
  await send('task.resume', { taskId });
  await waitForTask(send, taskId, 60_000);
  const after = await send('audit.list', { taskId, limit: 200 });
  expect(after.events.filter((event) => event.type === 'task.completed')).toHaveLength(1);
});

test('a pause is not a privilege cache: the mode in force at resume is the one that applies', async ({
  context,
  send,
  provider,
  site,
}) => {
  // §13 of this wave's brief, and the reason it matters: if authority were read
  // from the task record, a task paused under a permissive mode would carry
  // that permission past a user who tightened it. The permission engine reads
  // the live setting at every dispatch instead, and this is that claim made
  // observable rather than asserted from the source.
  // The changing action has to come *after* the pause, because manual mode
  // deliberately lets a read through — `RISK_RANK.R0` returns `LOW_RISK` before
  // the mode is consulted, so a read-only task would prove nothing here.
  const read: ScriptedReply = {
    kind: 'tool_calls',
    calls: [{ name: 'browser_read_page', arguments: {} }],
  };
  const click: ScriptedReply = {
    kind: 'tool_calls',
    calls: [{ name: 'browser_click', arguments: { elementId: 'e1' } }],
  };
  const taskId = await startLongTask(context, send, provider, site, [
    read,
    read,
    click,
    { kind: 'text', text: 'Done.' },
  ]);

  await send('task.pause', { taskId });
  await settle();
  expect(await stateOf(send, taskId)).toBe('PAUSED');

  // Tighten the mode while the task is parked.
  await send('session.setPermissionMode', { mode: 'manual' });
  await send('task.resume', { taskId });

  // The resumed task now has to ask about the click, under a mode it was never
  // started with. If authority were read from the task record instead of from
  // the live setting, it would not.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const { requests } = await send('permission.listPending', {});
    if (requests.length > 0) {
      expect(requests[0]?.tool).toBe('browser.click');
      await send('permission.respond', {
        requestId: requests[0]!.id,
        response: { kind: 'deny' },
      });
      return;
    }
    const now = await stateOf(send, taskId);
    if (now !== undefined && ['COMPLETED', 'PARTIAL', 'FAILED', 'BLOCKED'].includes(now)) {
      throw new Error(`The resumed task finished as ${now} without asking for approval.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The resumed task never asked for approval under manual mode.');
});
