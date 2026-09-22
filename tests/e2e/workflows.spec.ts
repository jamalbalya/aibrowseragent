/**
 * TEST-E2E-012 — recorded workflows in real Chromium (Stage 3 Wave H, P-022).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. The pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, and the
 * model's side of the conversation comes from a local server speaking the Chat
 * Completions protocol. No production service is contacted.
 *
 * What only a real browser can settle:
 *
 * **That the observation hook is really wired.** The recorder sits on the
 * production `ToolRegistry`'s hook in the real service worker. A unit test
 * supplies its own hook; this proves the product's is connected.
 *
 * **That a recording really replays.** The replay drives the real content
 * script against real layout, through the real dispatch path, with the real
 * permission engine deciding each step.
 *
 * **That a recorded workflow stays invisible to the model.** The registry, the
 * skill list and the tool list are the real ones here, so "it is not in
 * skills.list" is a statement about the product rather than about a fixture.
 */
import {
  connectProvider,
  expect,
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

test('recording a real task captures its steps, and saving them runs nothing', async ({
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
    { kind: 'text', text: 'I read the page.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read this page.' });
  // Started immediately, so the first dispatch is observed. The hook under
  // test is the production registry's, not one the test supplied.
  await send('workflow.recordStart', { taskId: task.id });

  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state).toBe('COMPLETED');

  const status = await send('workflow.recordStatus', {});
  expect(status.recording).toBe(true);
  expect(status.stepCount).toBeGreaterThan(0);

  const pageLoadsBefore = target.url();
  const saved = await send('workflow.recordStop', {
    name: 'Read the test page',
    description: 'Recorded from a real task.',
  });

  expect(saved.workflow).not.toBeNull();
  expect(saved.workflow!.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  expect(saved.workflow!.steps.map((step) => step.tool)).toContain('browser.read_page');
  // Saving is storage. The browser did not move.
  expect(target.url()).toBe(pageLoadsBefore);

  const { workflows } = await send('workflow.list', {});
  expect(workflows.map((workflow) => workflow.workflowId)).toContain(saved.workflow!.workflowId);
});

test('a recorded workflow never reaches the skill list or the model’s tools', async ({
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
    { kind: 'text', text: 'Read.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read this page.' });
  await send('workflow.recordStart', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);
  const saved = await send('workflow.recordStop', {
    name: 'Read the test page',
    description: 'Recorded from a real task.',
  });
  expect(saved.workflow).not.toBeNull();

  // The real registry, after a real recording. A recording that could be
  // registered would be a model-invokable tool combination nobody reviewed.
  const { skills } = await send('skill.list', {});
  expect(skills.map((skill) => skill.id)).not.toContain('recorded.workflow');
  expect(skills).toHaveLength(3);

  // And no `workflow.*` tool exists for a model to call.
  const { tools } = await send('tools.list', {});
  expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('workflow.'))).toEqual([]);
});

test('replaying a recording drives the real browser and asks again at each step', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  await connectProvider(send, provider);
  // Manual mode throughout, so nothing is auto-approved and the prompts are
  // real on both the recording pass and the replay.
  await send('session.setPermissionMode', { mode: 'manual' });

  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser.navigate', arguments: { url: `${site.baseUrl}/` } }],
    },
    { kind: 'text', text: 'Navigated.' },
  ]);

  const recordingAnswers = autoAnswer(send, 'approve_once');
  const { task } = await send('task.create', { objective: 'Open the test site.' });
  await send('workflow.recordStart', { taskId: task.id });
  const finished = await waitForTask(send, task.id, 40_000);
  recordingAnswers.stop();
  expect(finished.state).toBe('COMPLETED');

  const saved = await send('workflow.recordStop', {
    name: 'Open the test site',
    description: 'Recorded from a real task.',
  });
  expect(saved.workflow).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;

  // Reviewing re-checks it against the world as it is now, and runs nothing.
  const verdict = await send('workflow.revalidate', { workflowId });
  expect(verdict.ok).toBe(true);

  // Denied first: a stored workflow pre-approves nothing, so the answer given
  // now is the one that counts.
  const denying = autoAnswer(send, 'deny');
  const denied = await send('workflow.replay', { workflowId, inputs: {} });
  denying.stop();
  expect(denied.ok).toBe(false);
  expect(denying.asked.length).toBeGreaterThan(0);

  // Then approved, and the real browser really navigates.
  await target
    .goto(`${site.baseUrl}/nowhere.html`, { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  const approving = autoAnswer(send, 'approve_once');
  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  approving.stop();

  expect(replayed.ok).toBe(true);
  expect(replayed.status).toBe('completed');
  expect(approving.asked).toContain('browser.navigate');

  // The replay ran as a task of its own, visible in the task list.
  const { tasks } = await send('task.list', { limit: 25 });
  const replayTask = tasks.find((entry) => entry.id === replayed.taskId);
  expect(replayTask?.state).toBe('COMPLETED');
  expect(replayTask?.objective).toContain('Open the test site');
});

test('a workflow whose stored definition was tampered with is refused, not run', async ({
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
    { kind: 'text', text: 'Read.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read this page.' });
  await send('workflow.recordStart', { taskId: task.id });
  await waitForTask(send, task.id, 40_000);
  const saved = await send('workflow.recordStop', {
    name: 'Read the test page',
    description: 'Recorded from a real task.',
  });
  const workflowId = saved.workflow!.workflowId;

  // Edit extension storage directly, which is the threat the hash exists for:
  // something that is not the store changing what a replay would run.
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('The service worker was not running.');
  const edited = await worker.evaluate(async (id: string) => {
    const key = 'workflows:workflows';
    const stored = await chrome.storage.local.get(key);
    const index = stored[key] as {
      workflows: { workflowId: string; definition: { steps: unknown[] } }[];
    };
    const entry = index.workflows.find((workflow) => workflow.workflowId === id);
    if (!entry) return false;
    entry.definition.steps.push({
      kind: 'tool',
      id: 'injected',
      tool: 'browser.navigate',
      description: 'A step nobody recorded.',
      arguments: { url: { kind: 'literal', value: 'https://elsewhere.test/' } },
    });
    await chrome.storage.local.set({ [key]: index });
    return true;
  }, workflowId);
  expect(edited).toBe(true);

  const verdict = await send('workflow.revalidate', { workflowId });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe('INTEGRITY_FAILED');

  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  expect(replayed.ok).toBe(false);
  expect(replayed.reason).toBe('INTEGRITY_FAILED');
  // The injected step never ran: the browser is still where it was.
  expect(target.url()).not.toContain('elsewhere.test');
});

test('a click is left out of a recording rather than stored as a handle that cannot replay', async ({
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
    // `$lastElementId` is substituted with a handle the real page model just
    // produced, so this is a genuine click on a real element.
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser.click', arguments: { elementId: '$lastElementId' } }],
    },
    { kind: 'text', text: 'Clicked.' },
  ]);

  const { task } = await send('task.create', { objective: 'Read the page, then click something.' });
  await send('workflow.recordStart', { taskId: task.id });
  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state).toBe('COMPLETED');

  const saved = await send('workflow.recordStop', {
    name: 'Read then click',
    description: 'Recorded from a real task that really clicked.',
  });
  expect(saved.workflow).not.toBeNull();

  // The read is recorded; the click is not, and the recording says why.
  const tools = saved.workflow!.steps.map((step) => step.tool);
  expect(tools).toContain('browser.read_page');
  expect(tools).not.toContain('browser.click');
  expect(saved.skipped.map((entry) => entry.tool)).toContain('browser.click');

  // A handle is snapshot-scoped, so storing one would produce a step that
  // fails on every replay. Nothing in the stored definition holds one.
  expect(JSON.stringify(saved.workflow)).not.toMatch(/"e\d+-\d+"/);

  // And what was recorded replays cleanly, rather than stopping at a step
  // that could never have run.
  const replayed = await send('workflow.replay', {
    workflowId: saved.workflow!.workflowId,
    inputs: {},
  });
  expect(replayed.ok).toBe(true);
  expect(replayed.status).toBe('completed');
});
