/**
 * TEST-E2E-052 — executing the §84 condition 3 procedures that nothing covered.
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Pages are served over real
 * HTTP from 127.0.0.1 and the content script is really injected. Nothing
 * constructs a `ToolInvocation`; every task is created through the panel's own
 * route and driven by the mock provider's script.
 *
 * `docs/testing/acceptance/84-capabilities.md` answers §84 condition 3 for each
 * of the forty capabilities. Auditing those answers against the suite showed
 * that most of the written procedures were already executed, step for step, by
 * tests that run on every build — and that a handful were not. This file is
 * those, executed rather than left waiting for somebody.
 *
 * Which is the better outcome, and the repository already has the precedent:
 * `RESULTS.md` records three §89 procedures that were executed by hand once,
 * turned into automated tests, and now run on every build instead of waiting
 * for anybody to remember.
 *
 * What this file deliberately does **not** do is absorb a procedure whose
 * criterion needs a person. P-001's "the page underneath is never obscured or
 * reflowed" is a claim about Chrome's own side-panel chrome, which Playwright
 * loads as an ordinary page; no assertion here could be about the thing the
 * procedure names. Those stay `HUMAN_EXECUTION_REQUIRED` and say why.
 */
import {
  connectProvider,
  expect,
  test,
  waitForTask,
  type SendToWorker,
} from './fixtures/extension';

type Pending = { id: string; tool: string; site: string | null; reason: string };

/** Answers prompts as they appear, recording each, until told to stop. */
function answerPrompts(
  send: SendToWorker,
  response: { kind: 'approve_once' } | { kind: 'approve_site'; maxRisk: 'R2' } | { kind: 'deny' },
): { prompts: Pending[]; stop: () => void } {
  const prompts: Pending[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const listed = await send('permission.listPending', {}).catch(() => ({ requests: [] }));
      const { requests } = listed as { requests: Pending[] };
      for (const pending of requests) {
        prompts.push(pending);
        await send('permission.respond', { requestId: pending.id, response }).catch(
          () => undefined,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return { prompts, stop: () => void (running = false) };
}

// ---------------------------------------------------------------------------
// P-007 Scroll
// ---------------------------------------------------------------------------

test('84-P-007a — a target far below the fold is reached, and the model is told where the page is', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/tall`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // The control for everything below: the target really is off-screen to begin
  // with. Without this the case would pass on a page that never needed
  // scrolling at all.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(
    await page.evaluate(() => document.querySelector('#far')!.getBoundingClientRect().top),
  ).toBeGreaterThan(await page.evaluate(() => window.innerHeight));

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'auto' });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_scroll', arguments: { direction: 'bottom' } }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'text', text: 'At the bottom.' },
  ]);

  const { task } = await send('task.create', { objective: 'Reach the bottom of this page.' });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, task.id);
  answering.stop();

  // The document really moved — asserted in the page, not in the tool result.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

  // And P-007-C3: scroll position and document height are part of what the
  // model was given, so it can tell a short page from a long one.
  const sawAsSent = JSON.stringify(provider.requests).replace(/\\"/g, '"');
  expect(sawAsSent).toContain('documentHeight');
  await page.close();
});

test('84-P-007b — a target inside a nested scrolling container is reached too', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/tall`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  // The distinguishing case. `#box` is its own scroller, so a tool that
  // assumes the document is always the thing that scrolls reaches nothing
  // here while passing the case above.
  expect(await page.evaluate(() => document.querySelector('#box')!.scrollTop)).toBe(0);

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'auto' });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-0' } }] },
    { kind: 'text', text: 'Clicked.' },
  ]);

  const { task } = await send('task.create', { objective: 'Press the inner target.' });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, task.id);
  answering.stop();

  // The page's own handler is what settles it: the click landed on the element
  // inside the container, not on whatever happened to be at those coordinates.
  expect(await page.locator('#log').textContent()).toBe('inner clicked');
  await page.close();
});

// ---------------------------------------------------------------------------
// P-006 Forms
// ---------------------------------------------------------------------------

test('84-P-006 — five control kinds are filled and submitted, and the server got all five', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(`${site.baseUrl}/five-field`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'auto' });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        { name: 'browser_type', arguments: { elementId: 'e1-0', text: 'Ada Lovelace' } },
        { name: 'browser_select', arguments: { elementId: 'e1-1', value: 'pro' } },
        { name: 'browser_set_checked', arguments: { elementId: 'e1-2', checked: true } },
        { name: 'browser_set_checked', arguments: { elementId: 'e1-4', checked: true } },
        { name: 'browser_type', arguments: { elementId: 'e1-5', text: 'leave at reception' } },
      ],
    },
    { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-6' } }] },
    { kind: 'text', text: 'Saved.' },
  ]);

  const { task } = await send('task.create', { objective: 'Fill the booking form and save it.' });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  await waitForTask(send, task.id, 60_000);
  answering.stop();

  // Read off the receiving side. A page can hold a value it never submitted,
  // so asserting on the inputs would not settle what the criterion asks.
  await page.waitForURL(/collect-local/, { timeout: 10_000 });
  const body = (await page.locator('#body').textContent()) ?? '';
  expect(body).toContain('who=Ada+Lovelace');
  expect(body).toContain('tier=pro');
  expect(body).toContain('agree=on');
  expect(body).toContain('delivery=pickup');
  expect(body).toContain('notes=leave+at+reception');
  await page.close();
});

// ---------------------------------------------------------------------------
// P-027 Permission modes
// ---------------------------------------------------------------------------

test('84-P-027a — manual asks about an ordinary page action and auto does not', async ({
  context,
  send,
  provider,
  site,
}) => {
  const run = async (mode: 'manual' | 'auto'): Promise<string[]> => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/tall`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await send('session.setPermissionMode', { mode });
    provider.script([
      { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
      { kind: 'tool_calls', calls: [{ name: 'browser_click', arguments: { elementId: 'e1-0' } }] },
      { kind: 'text', text: 'Clicked.' },
    ]);
    const { task } = await send('task.create', { objective: `Press the inner target (${mode}).` });
    const answering = answerPrompts(send, { kind: 'approve_once' });
    await waitForTask(send, task.id);
    answering.stop();
    await page.close();
    return answering.prompts.map((prompt) => prompt.tool);
  };

  await connectProvider(send, provider);
  expect(await run('manual')).toContain('browser.click');
  // The difference between the modes, and the only thing this case claims. A
  // click is R1; auto reviews it and lets it through without asking.
  expect(await run('auto')).not.toContain('browser.click');
});

test('84-P-027b — every mode still stops at R3, skip included', async ({
  context,
  panel,
  send,
  provider,
  site,
}) => {
  // The criterion the procedure was written for, corrected to name an action
  // that really is R3. `84-capabilities.md` originally said "the submission",
  // and a same-site form submission is R2 — confirmed in manual and auto and
  // not in skip, which is the mode switch working rather than a prohibition.
  // `browser.attach_file` is R3 by declaration, so it is the action that tests
  // what the clause actually says.
  await connectProvider(send, provider);

  const run = async (mode: 'manual' | 'auto' | 'skip'): Promise<string[]> => {
    const page = await context.newPage();
    await page.goto(`${site.baseUrl}/upload`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await send('session.setPermissionMode', { mode });
    provider.script([
      { kind: 'tool_calls', calls: [{ name: 'browser_read_page', arguments: {} }] },
      { kind: 'tool_calls', calls: [{ name: 'files_select', arguments: { purpose: 'a CV' } }] },
      {
        kind: 'tool_calls',
        calls: [
          {
            name: 'browser_attach_file',
            arguments: { elementId: 'e1-0', fileIds: ['$lastFileId'] },
          },
        ],
      },
      { kind: 'text', text: 'Done.' },
    ]);
    const { task } = await send('task.create', { objective: `Attach my CV (${mode}).` });
    const answering = answerPrompts(send, { kind: 'approve_once' });

    const input = panel.locator('.prompt__file-input');
    await input.waitFor({ state: 'attached', timeout: 30_000 });
    await input.setInputFiles([
      { name: 'cv.txt', mimeType: 'text/plain', buffer: Buffer.from('BODY', 'utf8') },
    ]);

    await waitForTask(send, task.id, 60_000);
    answering.stop();
    await page.close();
    return answering.prompts.map((prompt) => prompt.tool);
  };

  for (const mode of ['manual', 'auto', 'skip'] as const) {
    expect(await run(mode), `R3 was not confirmed in ${mode} mode`).toContain(
      'browser.attach_file',
    );
  }
});

// ---------------------------------------------------------------------------
// P-037 Loop detection
// ---------------------------------------------------------------------------

test('84-P-037 — the agent stops rather than repeating an action that changes nothing', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();

  await connectProvider(send, provider);
  await send('session.setPermissionMode', { mode: 'auto' });

  // A button that changes nothing, pressed over and over. The provider is
  // scripted to be as unhelpful as a model in a genuine loop is: it never
  // varies the call and never concludes. If nothing detected the repetition
  // the task would run until a budget stopped it, which is the outcome the
  // clause exists to prevent.
  const click = {
    kind: 'tool_calls' as const,
    calls: [{ name: 'browser_click', arguments: { elementId: 'e1-1' } }],
  };
  const scripted = [
    { kind: 'tool_calls' as const, calls: [{ name: 'browser_read_page', arguments: {} }] },
    ...Array.from({ length: 12 }, () => click),
    { kind: 'text' as const, text: 'Never reached.' },
  ];
  provider.script(scripted);

  // Counted from here, not from zero. `connectProvider` runs the capability
  // doctor, and the doctor's probes reach this same mock provider — so a total
  // request count measures the task *plus* however many probes the doctor
  // currently performs. That made this assertion quietly depend on an
  // unrelated number: when the doctor gained one probe, the count reached the
  // scripted length and the case failed while the behaviour under test was
  // unchanged. The task's own turns are what the clause is about.
  const beforeTask = provider.requests.length;

  const { task } = await send('task.create', {
    objective: 'Press search until something changes.',
  });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  const finished = await waitForTask(send, task.id, 60_000);
  answering.stop();

  // Executing this procedure is what found the defect it now guards. The
  // detector fired from the very first run — the worker logged "Loop detected;
  // stopping the task" — and the task then sat in WAITING_FOR_TOOL for good,
  // because `WAITING_FOR_TOOL -> PARTIAL` was not in the transition table and
  // the terminal write was rejected with "Rejected an invalid terminal
  // transition". No terminal state means no §53 task-failed notification and
  // no Retry, which are the two things the runtime's own comment says this
  // path relies on.
  //
  // So the assertion is the terminal state itself rather than "it stopped
  // somehow": the behaviour this replaced would satisfy anything weaker by
  // never finishing at all.
  expect(finished.state).toBe('PARTIAL');
  expect(finished.result?.summary ?? '').toContain('identical arguments');
  // And it stopped before exhausting the script — the detector acted, rather
  // than the turn budget running out or the script simply ending.
  expect(provider.requests.length - beforeTask).toBeLessThan(scripted.length);
  await page.close();
});
