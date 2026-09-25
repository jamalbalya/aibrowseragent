/**
 * TEST-E2E-042 — what a replay earns again, in real Chromium (P-022).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. The pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, the
 * settings and site policy are the shipped stores, and the service worker is
 * really terminated where a case says so.
 *
 * TEST-SECURITY-075 settles the same claims against the real dispatch path
 * with fake tools, which is where the reasoning belongs. Three things only a
 * browser can settle are here instead:
 *
 * **That a recording is really durable.** A workflow lives in extension
 * storage across the constant eviction MV3 subjects a worker to. A suite with
 * an in-memory store proves its own store.
 *
 * **That the grant and the mode the replay meets are the shipped ones.** The
 * settings store and the site policy store are the real ones here, read by the
 * real worker, so "the mode in force is the replay's" is a statement about the
 * product rather than about a fixture's variable.
 *
 * **That a refused step really leaves the page alone.** Checked against the
 * DOM, because a step that reports failure having already acted is exactly the
 * failure a status string cannot show.
 */
import type { Page } from '@playwright/test';
import {
  connectProvider,
  expect,
  killServiceWorker,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';
import type { ScriptedReply } from './fixtures/mock-provider';
import type { PanelResponse } from '@/messaging/protocol';

type Prompt = { id: string; tool: string; site: string | null; reason: string };
type Scriptable = { script: (replies: readonly ScriptedReply[]) => void };

/** Answers prompts as they appear, recording each, until told to stop. */
function answerPrompts(
  send: SendToWorker,
  decide:
    | { kind: 'approve_once' }
    | { kind: 'approve_site'; maxRisk: 'R2' }
    | { kind: 'deny' }
    | ((tool: string) => { kind: 'approve_once' } | { kind: 'deny' }),
): { prompts: Prompt[]; stop: () => void } {
  const prompts: Prompt[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const listed = await send('permission.listPending', {}).catch(() => ({ requests: [] }));
      const { requests } = listed as { requests: Prompt[] };
      for (const pending of requests) {
        prompts.push(pending);
        const response = typeof decide === 'function' ? decide(pending.tool) : decide;
        await send('permission.respond', { requestId: pending.id, response }).catch(
          () => undefined,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  return {
    prompts,
    stop: () => {
      running = false;
    },
  };
}

/** Drives one real task that reads the page and then acts, and keeps it. */
async function record(
  send: SendToWorker,
  provider: Scriptable,
  options: {
    readonly objective: string;
    readonly calls: readonly { name: string; arguments: Record<string, unknown> }[];
    readonly name: string;
  },
): Promise<PanelResponse<'workflow.recordStop'>> {
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    ...options.calls.map((call) => ({ kind: 'tool_calls' as const, calls: [call] })),
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: options.objective });
  await send('workflow.recordStart', { taskId: task.id });
  const finished = await waitForTask(send, task.id, 40_000);
  expect(finished.state, `the recording task did not complete: ${finished.state}`).toBe(
    'COMPLETED',
  );
  return await send('workflow.recordStop', {
    name: options.name,
    description: 'Recorded from a real task.',
  });
}

/** The live state of a form control, read out of the real document. */
function controlState(
  target: Page,
  selector: string,
): Promise<{ checked: boolean; value: string }> {
  return target.evaluate((css: string) => {
    const element = document.querySelector<HTMLInputElement>(css);
    if (!element) throw new Error(`No element matched ${css}.`);
    return { checked: element.checked, value: element.value };
  }, selector);
}

/** Both checkboxes on the controls page, as the DOM has them now. */
function boxes(target: Page): Promise<{ news: boolean; terms: boolean }> {
  return target.evaluate(() => ({
    news: document.querySelector<HTMLInputElement>('#news')!.checked,
    terms: document.querySelector<HTMLInputElement>('#terms')!.checked,
  }));
}

/** Records the two-checkbox workflow every failure case below replays. */
async function recordTwoBoxes(
  send: SendToWorker,
  provider: Scriptable,
): Promise<PanelResponse<'workflow.recordStop'>> {
  return await record(send, provider, {
    objective: 'Tick the newsletter box and clear the terms box.',
    calls: [
      {
        name: 'browser.set_checked',
        arguments: { elementId: '$element(checkbox,Newsletter)', checked: true },
      },
      {
        name: 'browser.set_checked',
        arguments: { elementId: '$element(checkbox,Accept terms)', checked: false },
      },
    ],
    name: 'Set both boxes',
  });
}

// ---------------------------------------------------------------------------
// A. the recording itself is durable
// ---------------------------------------------------------------------------

test('a recorded workflow survives a real worker termination and still replays', async ({
  context,
  send,
  provider,
  site,
  serviceWorker,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordTwoBoxes(send, provider);
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;
  const hash = saved.workflow!.definitionHash;

  // The worker is really killed, the way Chrome's eviction kills it. The
  // extension stays installed and its storage stays where it was.
  await killServiceWorker(context, serviceWorker);

  // Polled, because the revived worker rebuilds its stores inside `startup()`
  // and a single read can land before the listing has anything in it — a
  // startup race, not the record being lost, and asserting on an empty list
  // would report the wrong failure.
  const deadline = Date.now() + 20_000;
  let listed: { workflowId: string; definitionHash: string } | undefined;
  for (;;) {
    const { workflows } = await send('workflow.list', {});
    listed = workflows.find((entry) => entry.workflowId === workflowId);
    if (listed !== undefined) break;
    if (Date.now() > deadline) throw new Error('The workflow never came back after the restart.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // The same record, not a rebuilt one: the hash is re-derived from the bytes
  // on disk, so a record that came back altered would not match.
  expect(listed.definitionHash).toBe(hash);
  expect((await send('workflow.revalidate', { workflowId })).ok).toBe(true);

  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#news')!.checked = false;
    document.querySelector<HTMLInputElement>('#terms')!.checked = true;
  });

  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);
  expect(await boxes(target)).toEqual({ news: true, terms: false });

  await target.close();
});

// ---------------------------------------------------------------------------
// B. the authorization a replay meets is the current one
// ---------------------------------------------------------------------------

test('revoking the site grant between recording and replay brings the confirmation back', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // An R2 write in the default mode, which is the one combination where a
  // standing grant decides anything: below R2 the mode approves without ever
  // consulting a grant.
  const granting = answerPrompts(send, { kind: 'approve_site', maxRisk: 'R2' });
  const saved = await record(send, provider, {
    objective: 'Search for small widgets.',
    calls: [
      {
        name: 'browser.type',
        arguments: { elementId: '$element(textbox,Search widgets)', text: 'small', submit: true },
      },
    ],
    name: 'Search for small widgets',
  });
  granting.stop();

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;
  expect((await send('policy.getSitePolicy', {})).state.rules.map((rule) => rule.site)).toEqual([
    '127.0.0.1',
  ]);

  // The control: while the grant stands, the replay runs without asking.
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#search')!.value = '';
  });
  const quiet = answerPrompts(send, { kind: 'deny' });
  const granted = await send('workflow.replay', { workflowId, inputs: {} });
  quiet.stop();
  expect(granted.ok, granted.detail ?? granted.reason ?? '').toBe(true);
  expect(quiet.prompts).toEqual([]);
  expect((await controlState(target, '#search')).value).toBe('small');

  // The user changes their mind. The recording banked nothing, so it has
  // nothing to fall back on.
  await send('policy.removeSiteRule', { site: '127.0.0.1' });
  expect((await send('policy.getSitePolicy', {})).state.rules).toEqual([]);
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#search')!.value = '';
  });

  const denying = answerPrompts(send, { kind: 'deny' });
  const revoked = await send('workflow.replay', { workflowId, inputs: {} });
  denying.stop();

  expect(revoked.ok).toBe(false);
  expect(denying.prompts.map((prompt) => prompt.tool)).toContain('browser.type');
  expect((await controlState(target, '#search')).value).toBe('');

  await target.close();
});

test('a workflow recorded in skip mode still confirms when it is replayed in manual', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // Skip mode asks for nothing, so the recording is made in silence.
  await send('session.setPermissionMode', { mode: 'skip' });
  const silent = answerPrompts(send, { kind: 'deny' });
  const saved = await recordTwoBoxes(send, provider);
  silent.stop();
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  expect(silent.prompts).toEqual([]);
  const workflowId = saved.workflow!.workflowId;

  // That silence is not consent, and it is not carried forward.
  await send('session.setPermissionMode', { mode: 'manual' });
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#news')!.checked = false;
    document.querySelector<HTMLInputElement>('#terms')!.checked = true;
  });

  const denying = answerPrompts(send, { kind: 'deny' });
  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  denying.stop();

  expect(denying.prompts.map((prompt) => prompt.tool)).toContain('browser.set_checked');
  expect(replayed.ok).toBe(false);
  // Refused before anything moved.
  expect(await boxes(target)).toEqual({ news: false, terms: true });

  await target.close();
});

// ---------------------------------------------------------------------------
// C. failure stops where it failed
// ---------------------------------------------------------------------------

test('a replay refused at one step leaves the page as it was and runs nothing after it', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordTwoBoxes(send, provider);
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;
  expect(saved.workflow!.steps.map((step) => step.tool)).toEqual([
    'browser.read_page',
    'browser.set_checked',
    'browser.set_checked',
  ]);

  await send('session.setPermissionMode', { mode: 'manual' });
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#news')!.checked = false;
    document.querySelector<HTMLInputElement>('#terms')!.checked = true;
  });

  // Refuse the first changing step. The one after it must not run: a workflow
  // is ordered, and continuing past a refusal would do something nobody
  // recorded.
  let seen = 0;
  const answering = answerPrompts(send, (tool) => {
    if (tool !== 'browser.set_checked') return { kind: 'approve_once' };
    seen += 1;
    return seen === 1 ? { kind: 'deny' } : { kind: 'approve_once' };
  });
  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  answering.stop();

  expect(replayed.ok).toBe(false);
  expect(seen, 'the second changing step was asked about after the first was refused').toBe(1);
  // Neither box moved: the refused step did nothing, and the step after it was
  // never reached.
  expect(await boxes(target)).toEqual({ news: false, terms: true });

  await target.close();
});

test('replaying again after a failure starts from the beginning and asks again', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordTwoBoxes(send, provider);
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;

  await send('session.setPermissionMode', { mode: 'manual' });
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#news')!.checked = false;
    document.querySelector<HTMLInputElement>('#terms')!.checked = true;
  });

  const denying = answerPrompts(send, { kind: 'deny' });
  const first = await send('workflow.replay', { workflowId, inputs: {} });
  denying.stop();
  expect(first.ok).toBe(false);
  expect(await boxes(target)).toEqual({ news: false, terms: true });

  // There is no "continue where it stopped". Starting again re-asks
  // everything, which is the only state that can be reasoned about — carrying
  // the earlier attempt's decisions into a later moment is exactly what a
  // resume would do.
  const approving = answerPrompts(send, { kind: 'approve_once' });
  const second = await send('workflow.replay', { workflowId, inputs: {} });
  approving.stop();

  expect(second.ok, second.detail ?? second.reason ?? '').toBe(true);
  expect(second.steps?.map((step) => step.ran)).toEqual([
    'browser.read_page',
    'browser.set_checked',
    'browser.set_checked',
  ]);
  expect(approving.prompts.map((prompt) => prompt.tool)).toContain('browser.set_checked');
  expect(await boxes(target)).toEqual({ news: true, terms: false });
  // A separate task, so the trail shows two attempts rather than one resumed.
  expect(second.taskId).not.toBe(first.taskId);

  await target.close();
});

test('a replay leaves no resumable run record behind', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The replayer starts no skill run, so there is nothing for a resume path to
  // find. `skill.runs` is the route that would hand one back, and it is empty
  // for a replay's task whether the replay succeeded or was refused.
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await recordTwoBoxes(send, provider);
  const workflowId = saved.workflow!.workflowId;

  await send('session.setPermissionMode', { mode: 'manual' });
  const denying = answerPrompts(send, { kind: 'deny' });
  const refused = await send('workflow.replay', { workflowId, inputs: {} });
  denying.stop();
  expect(refused.ok).toBe(false);
  expect(refused.taskId).toBeDefined();
  expect((await send('skill.runs', { taskId: refused.taskId! })).runs).toEqual([]);

  await send('session.setPermissionMode', { mode: 'skip' });
  const done = await send('workflow.replay', { workflowId, inputs: {} });
  expect(done.ok, done.detail ?? done.reason ?? '').toBe(true);
  expect((await send('skill.runs', { taskId: done.taskId! })).runs).toEqual([]);

  // The control, without which both assertions above would hold against a
  // route that reported nothing for any task at all: a *skill* run does leave
  // a record, and the same route hands it back.
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }] },
    { kind: 'text', text: 'Inspected.' },
  ]);
  const { task } = await send('task.create', { objective: 'Inspect this page.' });
  await waitForTask(send, task.id, 40_000);
  expect((await send('skill.runs', { taskId: task.id })).runs.length).toBeGreaterThan(0);

  await target.close();
});
