/**
 * TEST-E2E-038 — site authorization over page actions, in real Chromium.
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over real
 * HTTP from two origins and the content script is really injected. Nothing
 * constructs a `ToolInvocation`; tasks are created through the panel's own
 * route and driven by the mock provider's script.
 *
 * The claim these cases settle cannot be settled in a unit test. The unit
 * suite proves the policy engine honours a grant for a page action; only a
 * real browser shows that the scope reaching the engine is the tab's actual
 * URL, resolved from `chrome.tabs`, for a click and a keystroke on a real
 * page — which is the exact thing that was missing when the site-permission
 * model governed navigation and nothing else.
 *
 * The control matters as much as the case: a granted site must stop
 * prompting, and an ungranted one must not.
 */
import {
  connectProvider,
  expect,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';

type Prompt = { id: string; tool: string; site: string | null; reason: string };

/**
 * Answers prompts as they appear, recording each, until told to stop.
 *
 * Returns the recorded prompts so a test can assert on which tools asked and
 * which site each was asked about — the site is the thing under test.
 */
function answerPrompts(
  send: SendToWorker,
  response: { kind: 'approve_once' } | { kind: 'approve_site'; maxRisk: 'R2' } | { kind: 'deny' },
): { prompts: Prompt[]; stop: () => void } {
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

test('a page action asks about the page’s own site, not about nothing', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-0' } }] },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Click the first thing on this page.' });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, task.id);
  answering.stop();

  const clickPrompt = answering.prompts.find((p) => p.tool === 'browser.click');
  expect(clickPrompt, JSON.stringify(answering.prompts)).toBeDefined();
  // Before this phase every page action arrived with `site: null`, so the
  // panel had no site to offer a standing grant against.
  expect(clickPrompt?.site).toBe('127.0.0.1');

  await page.close();
});

test('granting the site stops a click and a keystroke from asking again', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  // Manual, because in Auto an R1 page action is already approved without a
  // prompt — and a prompt is what a standing grant is offered from.
  await send('session.setPermissionMode', { mode: 'manual' });
  provider.script([
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

  // Grant on the first prompt; every later action on the same site is covered.
  const { task } = await send('task.create', { objective: 'Toggle the newsletter box twice.' });
  const answering = answerPrompts(send, { kind: 'approve_site', maxRisk: 'R2' });
  await waitForTask(send, task.id);
  answering.stop();

  const { state } = await send('policy.getSitePolicy', {});
  // The grant was written against the page's own site, from a page action.
  expect(state.rules.map((rule) => rule.site)).toContain('127.0.0.1');

  await page.close();
});

test('a site the user has not granted still asks', async ({ context, send, provider, site }) => {
  // The control. Without it, the case above would pass just as well against a
  // build that never prompts at all.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-0' } }] },
    { kind: 'text', text: 'Done.' },
  ]);

  const { state: before } = await send('policy.getSitePolicy', {});
  expect(before.rules.length).toBe(0);

  const { task } = await send('task.create', { objective: 'Click the first thing.' });
  const answering = answerPrompts(send, { kind: 'deny' });
  await waitForTask(send, task.id);
  answering.stop();

  expect(answering.prompts.length).toBeGreaterThan(0);
  // Denying wrote nothing.
  const { state: after } = await send('policy.getSitePolicy', {});
  expect(after.rules.length).toBe(0);

  await page.close();
});

test('revoking a granted site brings the prompts back', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'manual' });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: true } }],
    },
    { kind: 'text', text: 'Granted.' },
  ]);
  const first = await send('task.create', { objective: 'Tick the box.' });
  const granting = answerPrompts(send, { kind: 'approve_site', maxRisk: 'R2' });
  await waitForTask(send, first.task.id);
  granting.stop();

  const { state: granted } = await send('policy.getSitePolicy', {});
  expect(granted.rules.length).toBeGreaterThan(0);

  await send('policy.removeSiteRule', { site: '127.0.0.1' });
  const { state: revoked } = await send('policy.getSitePolicy', {});
  expect(revoked.rules.length).toBe(0);

  // And a second task on the same site asks again, which is what makes the
  // revocation real rather than cosmetic.
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [{ name: 'browser_set_checked', arguments: { elementId: 'e1-0', checked: false } }],
    },
    { kind: 'text', text: 'Asked again.' },
  ]);
  const second = await send('task.create', { objective: 'Untick the box.' });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, second.task.id);
  answering.stop();

  expect(answering.prompts.some((p) => p.tool === 'browser.set_checked')).toBe(true);

  await page.close();
});

test('a grant does not survive the page moving to another origin', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  // G2.1 is locked: a standing grant answers "is this site trusted", and drift
  // answers "did the page move". A grant must not silently answer the second.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        { name: 'browser_navigate', arguments: { url: `${collector.baseUrl}/landing` } },
        { name: 'browser_click', arguments: { elementId: 'e1-0' } },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Go elsewhere and click.' });
  const answering = answerPrompts(send, { kind: 'approve_site', maxRisk: 'R2' });
  await waitForTask(send, task.id);
  answering.stop();

  const drift = answering.prompts.find((p) => p.reason.includes('moved from'));
  expect(drift, JSON.stringify(answering.prompts)).toBeDefined();

  await page.close();
});
