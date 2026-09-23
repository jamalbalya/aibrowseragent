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
import type { Page } from '@playwright/test';
import {
  connectProvider,
  expect,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';
import type { ScriptedReply } from './fixtures/mock-provider';
import type { PanelResponse } from '@/messaging/protocol';

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
    // One record, one key. The workflow is its own entry, so this edits
    // exactly the bytes a replay would read.
    const key = `workflows:workflows:v1:${id}`;
    const stored = await chrome.storage.local.get(key);
    const envelope = stored[key] as
      { v: number; record: { definition: { steps: unknown[] } } } | undefined;
    if (!envelope) return false;
    envelope.record.definition.steps.push({
      kind: 'tool',
      id: 'injected',
      tool: 'browser.navigate',
      description: 'A step nobody recorded.',
      arguments: { url: { kind: 'literal', value: 'https://elsewhere.test/' } },
    });
    await chrome.storage.local.set({ [key]: envelope });
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

/**
 * Records a click on the catalogue's Search button and returns the workflow.
 *
 * The page is marked first so a later replay can be checked against the DOM
 * rather than against a status string: a step that reports success having
 * clicked nothing, or having clicked something else, is exactly the failure
 * these tests exist to catch.
 */
async function recordAClick(
  send: SendToWorker,
  provider: { script: (replies: readonly ScriptedReply[]) => void },
  name = 'Click search',
): Promise<PanelResponse<'workflow.recordStop'>> {
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

  const { task } = await send('task.create', { objective: 'Read the page, then click Search.' });
  await send('workflow.recordStart', { taskId: task.id });
  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state).toBe('COMPLETED');

  return await send('workflow.recordStop', { name, description: 'Recorded from a real task.' });
}

/** Counts clicks per element id, so a replay can be checked against the DOM. */
async function markClicks(target: Page): Promise<void> {
  await target.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __clicked: string[] }).__clicked = seen;
    document.addEventListener(
      'click',
      (event) => {
        const element = event.target as Element | null;
        seen.push(element?.id ?? element?.tagName ?? 'unknown');
      },
      true,
    );
  });
}

function clicksSeen(target: Page): Promise<string[]> {
  return target.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked ?? []);
}

test('a recorded click is stored as a page-derived binding, never as a handle', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordAClick(send, provider);
  expect(saved.workflow).not.toBeNull();
  const workflow = saved.workflow!;

  // The click is recorded, which is what §49 asks for.
  expect(workflow.steps.map((step) => step.tool)).toEqual(['browser.read_page', 'browser.click']);
  expect(workflow.incomplete).toBe(false);
  expect(workflow.droppedSteps).toEqual([]);

  // As a description of the element, not as the handle that was used. A
  // handle names one page read and would be refused as stale on every replay.
  const click = workflow.steps[1]!;
  expect(click.arguments['elementId']?.kind).toBe('element');
  expect(click.arguments['elementId']?.detail).toContain('button');
  expect(click.arguments['elementId']?.detail).toContain('Search');
  expect(JSON.stringify(workflow)).not.toMatch(/"e\d+-\d+"/);
});

test('a recorded binding carries PAGE_DERIVED provenance in real extension storage', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  await recordAClick(send, provider);

  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('The service worker was not running.');
  const stored = await worker.evaluate(async () => {
    // Every workflow record, gathered from its own key.
    const all = await chrome.storage.local.get(null);
    const prefix = 'workflows:workflows:v1:';
    const records = Object.entries(all)
      .filter(([key]) => key.startsWith(prefix) && !key.endsWith(':index'))
      .map(([, value]) => (value as { record: unknown }).record);
    return JSON.stringify({ workflows: records });
  });

  // The tag is on the binding, and the binding is the only place a
  // page-derived value is allowed to be.
  expect(stored).toContain('"provenance":"PAGE_DERIVED"');
  expect(stored).toContain('"purpose":"ELEMENT_BINDING"');
  expect(stored).not.toContain('KNOWN_UNTAINTED_ELEMENT');

  // Every occurrence of the tag sits on an element binding, never on a
  // literal. A literal is a value something is given; a binding is a
  // predicate something is matched against, and only the second may hold
  // page-derived text.
  const parsed = JSON.parse(stored) as {
    workflows: {
      definition: { steps: { arguments: Record<string, { kind: string; provenance?: string }> }[] };
    }[];
  };
  for (const record of parsed.workflows) {
    for (const step of record.definition.steps) {
      for (const binding of Object.values(step.arguments)) {
        if (binding.provenance !== undefined) expect(binding.kind).toBe('element');
      }
    }
  }
});

test('replaying a recorded click acts on the element that was originally clicked', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordAClick(send, provider);
  const workflowId = saved.workflow!.workflowId;

  // Marked after recording, so the count below covers the replay alone.
  await markClicks(target);
  expect(await clicksSeen(target)).toEqual([]);

  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  expect(replayed.ok).toBe(true);
  expect(replayed.status).toBe('completed');

  // The claim, checked against the DOM rather than against a status string:
  // the same button really received the event.
  expect(await clicksSeen(target)).toEqual(['submit']);
});

test('a renamed element fails the replay closed, with nothing clicked', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordAClick(send, provider);
  const workflowId = saved.workflow!.workflowId;

  // The page no longer has anything by that name. A recording that fell back
  // to matching on role alone would click this button anyway.
  await target.evaluate(() => {
    const button = document.getElementById('submit');
    if (button) button.textContent = 'Find';
  });
  await markClicks(target);

  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  expect(replayed.ok).toBe(false);
  expect(await clicksSeen(target)).toEqual([]);
});

test('a duplicated element fails the replay closed, with nothing clicked', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordAClick(send, provider);
  const workflowId = saved.workflow!.workflowId;

  // Two buttons now answer to that description. Taking the first would be a
  // coin flip dressed up as a decision, so the binding refuses.
  await target.evaluate(() => {
    const twin = document.createElement('button');
    twin.id = 'submit-twin';
    twin.textContent = 'Search';
    document.body.appendChild(twin);
  });
  await markClicks(target);

  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  expect(replayed.ok).toBe(false);
  expect(await clicksSeen(target)).toEqual([]);
});

test('a secret-shaped accessible name is never stored, and the recording says so', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // Assembled in the page so no scannable credential literal sits on one line
  // of this file either.
  const planted = await target.evaluate(() => {
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const button = document.getElementById('submit');
    if (button) button.textContent = token;
    return token;
  });

  const saved = await recordAClick(send, provider, 'Click a badly named button');
  expect(saved.workflow).not.toBeNull();
  const workflow = saved.workflow!;

  // Secret detection runs before anything is persisted, whatever the
  // provenance, so the step is dropped rather than stored.
  expect(workflow.steps.map((step) => step.tool)).toEqual(['browser.read_page']);
  expect(workflow.incomplete).toBe(true);
  expect(workflow.droppedSteps.map((entry) => entry.tool)).toEqual(['browser.click']);
  // Positioned, not listed at the end: the review UI renders the gap where it
  // actually was, and a gap between two steps means something different from
  // one after the last.
  expect(workflow.droppedSteps[0]?.afterStepId).toBe(workflow.steps[0]?.id);
  expect(workflow.droppedSteps[0]?.reason).toContain('credential');

  // Not truncated, not hashed, not a slot default: nowhere at all, including
  // in what actually reached disk.
  expect(JSON.stringify(workflow)).not.toContain(planted);
  const worker = context.serviceWorkers()[0];
  if (!worker) throw new Error('The service worker was not running.');
  const stored = await worker.evaluate(async () => {
    const all = await chrome.storage.local.get('workflows:workflows');
    return JSON.stringify(all['workflows:workflows'] ?? null);
  });
  expect(stored).not.toContain(planted);
  expect(stored).not.toContain(planted.slice(0, 12));
});

test('an incomplete recording cannot be replayed at all', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  await target.evaluate(() => {
    const button = document.getElementById('submit');
    if (button) button.textContent = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  });

  const saved = await recordAClick(send, provider, 'An incomplete recording');
  const workflowId = saved.workflow!.workflowId;
  expect(saved.workflow!.incomplete).toBe(true);

  // Reviewing says why, and runs nothing.
  const verdict = await send('workflow.revalidate', { workflowId });
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe('INCOMPLETE_RECORDING');

  await markClicks(target);
  const replayed = await send('workflow.replay', { workflowId, inputs: {} });

  // Refused, and not reported as a success. Running the steps that *were*
  // captured would do something different from the task this came from.
  expect(replayed.ok).toBe(false);
  expect(replayed.reason).toBe('INCOMPLETE_RECORDING');
  expect(replayed.status).toBeUndefined();
  expect(await clicksSeen(target)).toEqual([]);
});

test('recording added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  // Read out of the manifest Chrome actually loaded, not off disk.
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
  expect((manifest.host_permissions ?? []).includes('<all_urls>')).toBe(false);
  for (const script of manifest.content_scripts ?? []) {
    expect(script.all_frames ?? false).toBe(false);
  }
});
