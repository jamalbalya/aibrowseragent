/**
 * TEST-E2E-039 — the Classic plan in real Chromium (Phase C).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over real
 * HTTP, the content script is really injected, and every task is created
 * through the panel's own route and driven by the mock provider's script.
 * Nothing here constructs a policy request or a tool invocation.
 *
 * What only a real browser can settle: that the site a plan is checked against
 * is the tab's actual URL, resolved from `chrome.tabs` at dispatch, for a real
 * click on a real page — and that an approval written to durable storage is
 * still in force after Chrome evicts the service worker. Both are properties
 * of the wiring rather than of the rule, and the unit suite deliberately does
 * not claim them.
 *
 * The controls carry as much weight as the cases. A plan that covered
 * everything would pass every "does not prompt" case here; the paired
 * "still prompts" cases are what make them mean something.
 */
import type { BrowserContext } from '@playwright/test';
import {
  connectProvider,
  expect,
  killServiceWorker,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';
import type { MockProvider, ScriptedReply } from './fixtures/mock-provider';

type Prompt = { id: string; tool: string; site: string | null; reason: string; taskId: string };
type Answer =
  | { kind: 'approve_once' }
  | { kind: 'approve_task' }
  | { kind: 'approve_site'; maxRisk: 'R2' }
  | { kind: 'deny' };

/** What a Classic task's planning turn replies. */
const planReply = (
  sites: string[],
  approach = 'Read the page and report what is on it.',
): ScriptedReply => ({ kind: 'text', text: JSON.stringify({ approach, sites }) });

/**
 * Answers prompts as they appear, recording each, until told to stop.
 *
 * Returns the recorded prompts so a test can assert on *which* tools asked —
 * which, for a plan, is the whole question.
 */
function answerPrompts(send: SendToWorker, response: Answer) {
  const prompts: Prompt[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const listed = await send('permission.listPending', {}).catch(() => ({ requests: [] }));
      const { requests } = listed as { requests: Prompt[] };
      for (const pending of requests) {
        prompts.push(pending);
        await send('permission.respond', { requestId: pending.id, response }).catch(
          () => undefined,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return {
    prompts,
    stop: () => {
      running = false;
    },
  };
}

/** Polls until a task is parked with a proposal in front of the user. */
async function waitForProposal(send: SendToWorker, taskId: string, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { task } = await send('task.get', { taskId });
    if (task?.state === 'WAITING_FOR_USER' && task.planProposal) return task;
    if (task && ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED'].includes(task.state)) {
      throw new Error(`Task finished as ${task.state} instead of waiting for a plan.`);
    }
    if (Date.now() > deadline) {
      throw new Error(`No proposal within ${timeoutMs}ms (state: ${task?.state}).`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The ordinary opening: a page open, a provider connected, Manual mode. */
async function openSite(
  context: BrowserContext,
  send: SendToWorker,
  provider: MockProvider,
  url: string,
) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  // Manual, because it is the mode where Classic and Cowork visibly differ:
  // in Auto an R1 page action runs without a prompt whatever the plan says,
  // and a case that passed in Auto would prove nothing about the plan.
  await send('session.setPermissionMode', { mode: 'manual' });
  return page;
}

const CLICK_SCRIPT = (sites: string[]): ScriptedReply[] => [
  planReply(sites),
  { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
  { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-0' } }] },
  { kind: 'text', text: 'Done.' },
];

test('01 — a Classic task stops at its proposal and authorises nothing', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script(CLICK_SCRIPT(['127.0.0.1']));

  const { task } = await send('task.create', {
    objective: 'Look at this page.',
    authorizationModel: 'classic',
  });
  const parked = await waitForProposal(send, task.id);

  expect(parked.planProposal?.proposedSites).toEqual(['127.0.0.1']);
  expect(parked.planProposal?.proposedBy).toBe('model');
  expect(parked.planApproval).toBeUndefined();
  // And nothing ran while it waited.
  expect(parked.steps.filter((step) => step.kind === 'tool_call')).toEqual([]);

  await page.close();
});

test('02 — a Cowork task never plans', async ({ context, send, provider, site }) => {
  // The control for case 01: without it, a build that planned for every task
  // would pass, and so would one that planned for none.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script([{ kind: 'text', text: 'Nothing to do.' }]);

  const { task } = await send('task.create', { objective: 'Look at this page.' });
  const finished = await waitForTask(send, task.id);

  expect(finished.planProposal).toBeUndefined();
  expect(finished.planApproval).toBeUndefined();
  expect(finished.state).toBe('COMPLETED');

  await page.close();
});

test('03 — approving the plan starts the run and records a separate approval', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script(CLICK_SCRIPT(['127.0.0.1']));

  const { task } = await send('task.create', {
    objective: 'Click the first thing.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });
  const finished = await waitForTask(send, task.id);

  expect(finished.planApproval?.approvedSites).toEqual(['127.0.0.1']);
  expect(finished.planApproval?.approvalProvenance).toBe('USER_PANEL_ACTION');
  expect(finished.planApproval?.version).toBe(1);
  // The proposal survives next to the approval rather than being replaced.
  expect(finished.planProposal?.proposedSites).toEqual(['127.0.0.1']);

  // An authorization with no trail is a gap, so the approval is recorded the
  // way every other authorization decision is — one record per site.
  const { events } = await send('audit.list', { limit: 200, taskId: task.id });
  const approved = events.filter((event) => event.type === 'plan.approved');
  expect(approved.map((event) => event.site)).toEqual(['127.0.0.1']);
  expect(approved[0]?.outcome).toBe('allowed');

  await page.close();
});

test('04 — inside the approved plan, a click on the page does not ask', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The case. In Manual mode this click would be confirmed; the plan is why it
  // is not, and the site it is checked against is the tab's real URL.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script(CLICK_SCRIPT(['127.0.0.1']));

  const { task } = await send('task.create', {
    objective: 'Click the first thing.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_once' });
  const finished = await waitForTask(send, task.id);
  answering.stop();

  expect(answering.prompts.map((p) => p.tool)).toEqual([]);
  expect(finished.state).toBe('COMPLETED');
  expect(finished.steps.some((step) => step.tool === 'browser.click')).toBe(true);

  await page.close();
});

test('05 — the same click on a site the plan does not name still asks', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The control for case 04. Identical in every respect except the site the
  // model proposed, which is the one thing under test.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script(CLICK_SCRIPT(['vendor.example']));

  const { task } = await send('task.create', {
    objective: 'Click the first thing.',
    authorizationModel: 'classic',
  });
  const parked = await waitForProposal(send, task.id);
  expect(parked.planProposal?.proposedSites).toEqual(['vendor.example']);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, task.id);
  answering.stop();

  expect(answering.prompts.map((p) => p.tool)).toContain('browser.click');
  expect(answering.prompts.find((p) => p.tool === 'browser.click')?.site).toBe('127.0.0.1');

  await page.close();
});

test('06 — "allow for this task" adds the site to the plan and writes no site rule', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await openSite(context, send, provider, `${site.baseUrl}/controls`);
  // Two writes on a site the plan does not name. The first asks; the answer
  // widens the plan; the second is covered by it.
  provider.script([
    planReply(['vendor.example']),
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: true } }],
    },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: false } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Toggle the newsletter box twice.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_task' });
  const finished = await waitForTask(send, task.id);
  answering.stop();

  // Asked once, and then stopped asking.
  const asked = answering.prompts.filter((p) => p.tool === 'browser.set_checked');
  expect(asked.length).toBe(1);
  // The plan gained the site, as a new version.
  expect(finished.planApproval?.approvedSites).toEqual(['vendor.example', '127.0.0.1']);
  expect(finished.planApproval?.version).toBe(2);
  // NEGATIVE CONTROL: and the site policy gained nothing, so nothing outlives
  // this task.
  const { state } = await send('policy.getSitePolicy', {});
  expect(state.rules).toEqual([]);

  // The widening is in the trail, naming the site it added.
  const { events } = await send('audit.list', { limit: 200, taskId: task.id });
  const added = events.filter((event) => event.type === 'plan.site_added');
  expect(added.map((event) => event.site)).toEqual(['127.0.0.1']);

  await page.close();
});

test('07 — "always allow" still writes a standing rule, which is how 06 discriminates', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await openSite(context, send, provider, `${site.baseUrl}/controls`);
  provider.script([
    planReply(['vendor.example']),
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: true } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Tick the box.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_site', maxRisk: 'R2' });
  const finished = await waitForTask(send, task.id);
  answering.stop();

  const { state } = await send('policy.getSitePolicy', {});
  expect(state.rules.map((rule) => rule.site)).toContain('127.0.0.1');
  // And the plan was not touched: the two answers are different authorizations.
  expect(finished.planApproval?.approvedSites).toEqual(['vendor.example']);

  await page.close();
});

test('08 — asking for changes creates no authorization and re-proposes', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script([
    planReply(['first.example']),
    planReply(['second.example']),
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Look at this page.',
    authorizationModel: 'classic',
  });
  const first = await waitForProposal(send, task.id);
  expect(first.planProposal?.proposedSites).toEqual(['first.example']);

  await send('plan.revise', { taskId: task.id, note: 'Use the other site.' });
  // Poll for the *new* proposal, not merely for the parked state: the task is
  // parked with no proposal for the moment between dropping one and writing
  // the next, and a looser wait would read that gap as a result.
  const second = await waitForProposal(send, task.id);

  expect(second.planProposal?.proposedSites).toEqual(['second.example']);
  // NEGATIVE CONTROL: the round trip authorised nothing.
  expect(second.planApproval).toBeUndefined();
  expect(second.steps.filter((step) => step.kind === 'tool_call')).toEqual([]);

  await page.close();
});

test('09 — an approved plan does not authorise typing into a credential field', async ({
  context,
  send,
  provider,
  site,
}) => {
  // NEGATIVE CONTROL against the whole design. The site is in the plan, the
  // action is an ordinary keystroke, and it is refused anyway — because the
  // refusal happens before the plan is consulted.
  const page = await openSite(context, send, provider, `${site.baseUrl}/shifty-form`);
  await page.evaluate('window.mutate()');

  provider.script([
    planReply(['127.0.0.1']),
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_type', arguments: { elementId: 'e1-2', text: 'hunter2' } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Fill in the form.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_once' });
  const finished = await waitForTask(send, task.id);
  answering.stop();

  const typed = finished.steps.find((step) => step.tool === 'browser.type');
  // `denied` specifically, not merely "not success": a write that failed
  // because the element could not be found would be `error`, and would pass a
  // looser assertion while proving nothing about the refusal.
  expect(typed?.status, JSON.stringify(finished.steps)).toBe('denied');
  // And nothing reached the field.
  const value = await page.evaluate('(document.getElementById("later") || {}).value');
  expect(value ?? '').toBe('');

  await page.close();
});

test('10 — an ordinary field on the same page still accepts a write', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The discriminating half of case 09. Without it, a build where every write
  // failed would pass case 09 perfectly.
  const page = await openSite(context, send, provider, `${site.baseUrl}/shifty-form`);
  provider.script([
    planReply(['127.0.0.1']),
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_type', arguments: { elementId: 'e1-1', text: 'ordinary' } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Fill in the nickname.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_once' });
  const finished = await waitForTask(send, task.id);
  answering.stop();

  expect(finished.steps.find((step) => step.tool === 'browser.type')?.status).toBe('success');
  // Written without a prompt, because the plan covers this site.
  expect(answering.prompts.map((p) => p.tool)).not.toContain('browser.type');

  await page.close();
});

test('11 — the plan survives a service-worker eviction', async ({
  context,
  send,
  provider,
  site,
  serviceWorker,
}) => {
  // Only a real browser settles this. The approval is durable state; a worker
  // that came back without it would silently start asking again, and one that
  // came back with a plan it could not verify would be worse.
  const page = await openSite(context, send, provider, `${site.baseUrl}/controls`);
  provider.script([
    planReply(['127.0.0.1']),
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: true } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Tick the box.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  await killServiceWorker(context, serviceWorker);

  const { task: recovered } = await send('task.get', { taskId: task.id });
  expect(recovered?.planApproval?.approvedSites).toEqual(['127.0.0.1']);
  expect(recovered?.planApproval?.approvalProvenance).toBe('USER_PANEL_ACTION');

  await page.close();
});

test('12 — a task cannot be approved twice', async ({ context, send, provider, site }) => {
  // NEGATIVE CONTROL. A second approval would reset the version and discard
  // every site added during the run.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script(CLICK_SCRIPT(['127.0.0.1']));

  const { task } = await send('task.create', {
    objective: 'Click the first thing.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });
  const second = await send('plan.approve', { taskId: task.id }).then(
    () => null,
    (error: unknown) => String(error),
  );

  // The specific refusal, so a route that failed for any other reason — not
  // registered, wrong class, a thrown type error — would not pass this.
  expect(second).toContain('already running under an approved plan');
  await page.close();
});

test('13 — a live task that never planned cannot be approved', async ({
  context,
  send,
  provider,
  site,
}) => {
  // Live, not finished. A finished task is refused for a different reason —
  // it has finished — and asserting only that *some* error came back would
  // prove that reason instead of this one. The task is held at a permission
  // prompt, which is a state it stays in until somebody answers.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-0' } }] },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Click the first thing.' });
  // Waits for the prompt rather than answering it: while it is pending the
  // task is alive and has no plan, which is the state under test.
  const deadline = Date.now() + 20_000;
  for (;;) {
    const listed = await send('permission.listPending', {});
    if (listed.requests.some((request) => request.taskId === task.id)) break;
    if (Date.now() > deadline) throw new Error('No permission prompt appeared.');
    await new Promise((r) => setTimeout(r, 150));
  }

  const outcome = await send('plan.approve', { taskId: task.id }).then(
    () => null,
    (error: unknown) => String(error),
  );
  expect(outcome).toContain('no plan waiting for approval');

  await send('task.cancel', { taskId: task.id });
  await page.close();
});

test('14 — a retry carries the shape and not the authorization', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script([
    planReply(['127.0.0.1']),
    { kind: 'text', text: 'Done.' },
    planReply(['127.0.0.1']),
    { kind: 'text', text: 'Done again.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Look at this page.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });
  await waitForTask(send, task.id);

  const { task: retried } = await send('task.retry', { taskId: task.id });
  expect(retried.id).not.toBe(task.id);
  expect(retried.authorizationModel).toBe('classic');
  // NEGATIVE CONTROL: a fresh task, and nothing approved for it yet.
  expect(retried.planApproval).toBeUndefined();

  await page.close();
});

test('15 — an approval is not in anything the user can export', async ({
  context,
  send,
  provider,
  site,
}) => {
  // Tasks do not cross the installation boundary at all, so the approval has
  // no route out. Asserted against the real export rather than the table that
  // says so.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script([planReply(['127.0.0.1']), { kind: 'text', text: 'Done.' }]);

  const { task } = await send('task.create', {
    objective: 'Look at this page.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });
  const finished = await waitForTask(send, task.id);
  expect(finished.planApproval).toBeDefined();

  const exported = await send('data.export', {});
  const serialised = JSON.stringify(exported);
  expect(serialised).not.toContain('USER_PANEL_ACTION');
  expect(serialised).not.toContain(finished.planApproval?.planId ?? 'plan_');

  await page.close();
});

test('16 — the planning turn offers the model no tools at all', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The structural claim, checked against what actually went over the wire:
  // a planning turn that could call a tool would be a planning turn that could
  // act before its plan was approved.
  const page = await openSite(context, send, provider, site.baseUrl);
  provider.script([planReply(['127.0.0.1']), { kind: 'text', text: 'Done.' }]);

  const { task } = await send('task.create', {
    objective: 'Look at this page.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);

  const planning = provider.requests.find((entry) =>
    JSON.stringify(entry).includes('Look at this page.'),
  ) as { tools?: unknown[]; tool_choice?: string } | undefined;
  expect(planning).toBeDefined();
  expect(planning?.tools ?? []).toEqual([]);

  await page.close();
});

test('17 — a plan does not clear an origin drift on the site it covers', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  // The asymmetry, in a real browser. The plan names `127.0.0.1`, and the
  // collector is a different origin on that same registrable domain — so the
  // plan covers where the page went. Drift answers a different question from a
  // site grant: the page moved after the model was asked, and the action would
  // land somewhere the agent never saw.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });

  provider.script([
    planReply(['127.0.0.1']),
    {
      // One turn, two calls, and no page read first: a task that has read a
      // page and then crosses origins is also a data transfer, and the egress
      // gate's reason would replace the drift reason in the prompt.
      kind: 'tool_calls',
      calls: [
        { name: 'browser_navigate', arguments: { url: `${collector.baseUrl}/landing` } },
        { name: 'browser_click', arguments: { elementId: 'e1-0' } },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Go to the other origin and click the first thing.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, task.id);
  answering.stop();

  const drift = answering.prompts.find((prompt) => prompt.reason.includes('moved from'));
  expect(drift, JSON.stringify(answering.prompts)).toBeDefined();
  expect(drift?.reason).toContain('Confirm before continuing');

  await page.close();
});

test('18 — an eviction while the plan is still a proposal does not approve it', async ({
  context,
  send,
  provider,
  site,
  serviceWorker,
}) => {
  // Case 11 proves an approval survives a worker restart. This is the inverse,
  // and the one that matters more: a task that was waiting for a person must
  // not come back from an eviction already authorised. Only a real worker
  // termination settles it — the parked state, the proposal and the absence of
  // an approval all have to survive as themselves.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });
  provider.script(CLICK_SCRIPT(['127.0.0.1']));

  const { task } = await send('task.create', {
    objective: 'Click the first thing.',
    authorizationModel: 'classic',
  });
  const parked = await waitForProposal(send, task.id);
  expect(parked.planApproval).toBeUndefined();

  await killServiceWorker(context, serviceWorker);

  const { task: recovered } = await send('task.get', { taskId: task.id });
  expect(recovered?.planApproval).toBeUndefined();
  expect(recovered?.planProposal?.proposedSites).toEqual(['127.0.0.1']);
  // And nothing ran while nobody was watching.
  expect(recovered?.steps.filter((step) => step.kind === 'tool_call')).toEqual([]);

  await page.close();
});

test('19 — an R3 action inside a Classic run still stops and asks', async ({
  context,
  send,
  provider,
  site,
  serviceWorker,
}) => {
  // Closing a tab the *user* opened is R3. What this settles in a real browser
  // is that approving a plan does not buy silence above the floor: the run is
  // authorised, the action is not, and the person is asked.
  //
  // It does not settle the narrower claim that a *covering site scope* fails
  // to clear an R3 action — `tabs.close` is scope `none`, so no plan could
  // cover it either way. TEST-SECURITY-068 case 10 holds that one.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });

  // Chrome's own id for the tab the person opened, asked of the browser
  // rather than guessed: the tool refuses a tab it cannot find, and a wrong id
  // would make this case pass on the wrong refusal.
  const tabId = await serviceWorker.evaluate(
    `chrome.tabs.query({ url: '${site.baseUrl}/*' }).then((tabs) => tabs[0].id)`,
  );
  provider.script([
    planReply(['127.0.0.1']),
    { kind: 'tool_calls', calls: [{ name: 'tabs_close', arguments: { tabId } }] },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', {
    objective: 'Close that tab.',
    authorizationModel: 'classic',
  });
  await waitForProposal(send, task.id);
  await send('plan.approve', { taskId: task.id });

  const answering = answerPrompts(send, { kind: 'deny' });
  await waitForTask(send, task.id);
  answering.stop();

  const asked = answering.prompts.find((prompt) => prompt.tool === 'tabs.close');
  expect(asked, JSON.stringify(answering.prompts)).toBeDefined();

  await page.close();
});
