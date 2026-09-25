/**
 * TEST-E2E-041 — recording and replaying form controls, and what replay still
 * has to ask (P-022, Wave 4 Part 3).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. The pages are served over
 * real HTTP from 127.0.0.1 and from a second origin on `localhost`, the
 * content script is really injected, and the model's side of the conversation
 * comes from a local server speaking the Chat Completions protocol. No
 * production service is contacted.
 *
 * TEST-E2E-012 settled recording and replaying a *click*. A click is the one
 * interaction whose replay can be checked without looking at a value, and it
 * left the rest of the interaction surface — a checkbox, a radio group, a
 * dropdown, a text field that submits — unproven end to end. These cases
 * close that, and then push on the part that matters more than the plumbing:
 *
 * **A recorded workflow is data, not authority.** Every replayed step goes
 * through the same policy pipeline a model-issued call goes through, judged
 * against the world as it is at replay: the site the tab is actually on, the
 * risk the step reaches *now*, and the sensitivity of the field it is now
 * pointed at. Four of these cases exist only to show that a recording cannot
 * carry an authorization forward from the moment it was made.
 *
 * What each case checks is the DOM, not a status string. A step that reports
 * success having changed nothing, or having changed something else, is the
 * failure this whole file is for.
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

type Prompt = { id: string; tool: string; site: string | null; reason: string };

/** The subset of the mock provider these cases drive. */
type Scriptable = { script: (replies: readonly ScriptedReply[]) => void };

/**
 * Answers prompts as they appear, recording each, until told to stop.
 *
 * The recorded prompts are the evidence: which tool asked, and which site it
 * was asked about. A test that only checked the outcome could not tell an
 * action that was authorised from one that was never gated.
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

/**
 * Drives one real task that reads the page and then acts, and keeps it.
 *
 * The read is its own reply so the page model has come back before the acting
 * reply is resolved — which is what lets the script name a control by role and
 * accessible name rather than by a handle it could not know in advance.
 */
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
  // Started immediately, so the first dispatch is observed by the production
  // registry's hook rather than by anything this test supplied.
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

/**
 * Every runtime slot a recording asks for, filled with what was captured.
 *
 * A value the parameteriser would not store — anything with a space in it is
 * treated as carried data rather than structure — comes back as a slot, and a
 * replay that left it empty is refused for invalid inputs before any policy
 * decision is taken. Supplying it is what makes the rest of the case a
 * statement about policy: without this, a test asserting "the replay was
 * refused" would pass against a build that never reached the step at all.
 */
function fillSlots(
  workflow: NonNullable<PanelResponse<'workflow.recordStop'>['workflow']>,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const slot of workflow.inputs) {
    const value = values[slot.name.replace(/^s\d+_/, '')];
    expect(value, `nothing supplied for slot ${slot.name}`).toBeDefined();
    inputs[slot.name] = value!;
  }
  return inputs;
}

/** The live state of a form control, read out of the real document. */
function controlState(
  target: Page,
  selector: string,
): Promise<{ checked: boolean; value: string }> {
  return target.evaluate((css: string) => {
    const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(css);
    if (!element) throw new Error(`No element matched ${css}.`);
    return {
      checked: element instanceof HTMLInputElement ? element.checked : false,
      value: element.value,
    };
  }, selector);
}

/** Every selected option of a multi-select, in document order. */
function selectedValues(target: Page, selector: string): Promise<string[]> {
  return target.evaluate((css: string) => {
    const element = document.querySelector<HTMLSelectElement>(css);
    if (!element) throw new Error(`No element matched ${css}.`);
    return [...element.selectedOptions].map((option) => option.value);
  }, selector);
}

// ---------------------------------------------------------------------------
// A. The controls a click test never reached
// ---------------------------------------------------------------------------

test('a recorded checkbox is stored as a checkbox binding and replays onto the box', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await record(send, provider, {
    objective: 'Tick the newsletter box.',
    calls: [
      {
        name: 'browser.set_checked',
        arguments: { elementId: '$element(checkbox,Newsletter)', checked: true },
      },
    ],
    name: 'Tick the newsletter box',
  });

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;
  expect(workflow.steps.map((step) => step.tool)).toEqual([
    'browser.read_page',
    'browser.set_checked',
  ]);
  expect(workflow.incomplete).toBe(false);

  // The control is named by what it is, never by the handle that was used:
  // a handle belongs to one page read and is refused as stale on every
  // replay.
  const check = workflow.steps[1]!;
  expect(check.arguments['elementId']?.kind).toBe('element');
  expect(check.arguments['elementId']?.detail).toContain('checkbox');
  expect(check.arguments['elementId']?.detail).toContain('Newsletter');
  // The state is structure rather than page-derived data, so it is kept as
  // written — a replay that asked for it would not be the same workflow.
  expect(check.arguments['checked']).toEqual({ kind: 'literal', detail: 'true' });
  expect(JSON.stringify(workflow)).not.toMatch(/"e\d+-\d+"/);

  // Put the page back the way it was, so what the replay does is the only
  // thing the assertion can be reading.
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#news')!.checked = false;
  });
  expect((await controlState(target, '#news')).checked).toBe(false);

  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);
  expect(replayed.status).toBe('completed');
  expect((await controlState(target, '#news')).checked).toBe(true);
  // And nothing else in the form moved.
  expect((await controlState(target, '#terms')).checked).toBe(true);

  await target.close();
});

test('a recorded radio moves the whole group on replay, not just the button it names', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // "Small" is the option the page ships checked, so selecting "Large" is a
  // real change rather than a no-op that would pass against a replay that did
  // nothing at all.
  const saved = await record(send, provider, {
    objective: 'Choose the large size.',
    calls: [
      {
        name: 'browser.set_checked',
        arguments: { elementId: '$element(radio,Large)', checked: true },
      },
    ],
    name: 'Choose the large size',
  });

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;
  expect(workflow.steps[1]?.arguments['elementId']?.detail).toContain('radio');
  expect(workflow.steps[1]?.arguments['elementId']?.detail).toContain('Large');

  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#sa')!.checked = true;
  });
  expect((await controlState(target, '#sb')).checked).toBe(false);

  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);

  // Both halves, because a radio group is the one control where setting one
  // button has to clear another: a replay that set `checked` on the element
  // and stopped there would leave two buttons checked in the same group.
  expect((await controlState(target, '#sb')).checked).toBe(true);
  expect((await controlState(target, '#sa')).checked).toBe(false);

  await target.close();
});

test('a recorded dropdown choice replays as the same option', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/advanced-controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await record(send, provider, {
    objective: 'Book a business cabin.',
    calls: [
      {
        name: 'browser.select',
        arguments: { elementId: '$element(combobox,Cabin)', value: 'b' },
      },
    ],
    name: 'Book a business cabin',
  });

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;
  expect(workflow.steps.map((step) => step.tool)).toEqual(['browser.read_page', 'browser.select']);
  // A single `<select>` reports as a combobox, which is the role the binding
  // has to match on for the replay to find it again.
  expect(workflow.steps[1]?.arguments['elementId']?.detail).toContain('combobox');
  expect(workflow.steps[1]?.arguments['elementId']?.detail).toContain('Cabin');
  // The chosen option is short and structural, so it is stored rather than
  // asked for — the recording would otherwise prompt for a value the user
  // already chose once.
  expect(workflow.steps[1]?.arguments['value']).toEqual({ kind: 'literal', detail: '"b"' });

  await target.evaluate(() => {
    document.querySelector<HTMLSelectElement>('#one')!.value = 'e';
  });
  expect((await controlState(target, '#one')).value).toBe('e');

  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);
  expect((await controlState(target, '#one')).value).toBe('b');

  await target.close();
});

test('a recorded multi-select replays the whole set it was given', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/advanced-controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await record(send, provider, {
    objective: 'Add bags and a meal to the booking.',
    calls: [
      {
        name: 'browser.select_many',
        arguments: { elementId: '$element(listbox,Extras)', values: ['bags', 'meal'] },
      },
    ],
    name: 'Add bags and a meal',
  });

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;
  // Recorded at all, which is the half that was broken: a list argument under
  // a tainted task became a runtime slot, and a slot supplies one scalar, so
  // the replayed call failed the tool's own schema every time. It is stored as
  // written now, and a list that cannot be stored drops the step instead.
  expect(workflow.steps.map((step) => step.tool)).toEqual([
    'browser.read_page',
    'browser.select_many',
  ]);
  expect(workflow.incomplete).toBe(false);
  expect(workflow.inputs).toEqual([]);
  // A `<select multiple>` reports as a listbox, which is the role the binding
  // matches on.
  expect(workflow.steps[1]?.arguments['elementId']?.detail).toContain('listbox');
  expect(workflow.steps[1]?.arguments['elementId']?.detail).toContain('Extras');
  expect(workflow.steps[1]?.arguments['values']).toEqual({
    kind: 'literal',
    detail: '["bags","meal"]',
  });

  await target.evaluate(() => {
    for (const option of document.querySelectorAll<HTMLOptionElement>('#extras option')) {
      option.selected = false;
    }
  });
  expect(await selectedValues(target, '#extras')).toEqual([]);

  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);

  // The complete set, which is what this tool means: anything not listed is
  // deselected, so a replay that only added would look the same here and be a
  // different action.
  expect(await selectedValues(target, '#extras')).toEqual(['bags', 'meal']);

  await target.close();
});

test('a recorded structured input replays as a value the browser really parsed', async ({
  context,
  send,
  provider,
  site,
}) => {
  // P-006 controls, through the recorder. A real browser parses these and
  // jsdom does not: it silently clears a date it cannot read and snaps a range
  // to its nearest step, so "the value came back" is only worth asserting
  // here.
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/advanced-controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await record(send, provider, {
    objective: 'Set a travel date and the number of seats.',
    calls: [
      {
        name: 'browser.set_value',
        arguments: { elementId: '$element(textbox,Travel date)', value: '2026-06-15' },
      },
      {
        name: 'browser.set_value',
        arguments: { elementId: '$element(slider,Seats)', value: '5' },
      },
    ],
    name: 'Set the date and the seats',
  });

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;
  expect(workflow.steps.map((step) => step.tool)).toEqual([
    'browser.read_page',
    'browser.set_value',
    'browser.set_value',
  ]);
  // The values are short and structural, so they are kept rather than asked
  // for — a recording that prompted for a date the user already chose would
  // not be the same workflow.
  expect(workflow.inputs).toEqual([]);
  expect(workflow.steps[1]?.arguments['value']).toEqual({
    kind: 'literal',
    detail: '"2026-06-15"',
  });

  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#when')!.value = '';
    document.querySelector<HTMLInputElement>('#seats')!.value = '1';
    document.querySelector<HTMLElement>('#echo')!.textContent = '';
  });

  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);

  // Accepted by the control rather than merely assigned: a date the browser
  // refused would come back as the empty string.
  expect((await controlState(target, '#when')).value).toBe('2026-06-15');
  expect((await controlState(target, '#seats')).value).toBe('5');
  // And the page's own listeners fired, so the replay drove the control the
  // way a person would rather than writing to `.value` behind its back.
  const echo = await target.evaluate(
    () => document.querySelector<HTMLElement>('#echo')?.textContent ?? '',
  );
  expect(echo).toContain('when:change');
  expect(echo).toContain('seats:change');

  await target.close();
});

// ---------------------------------------------------------------------------
// B. A recording is data, not authority
// ---------------------------------------------------------------------------

test('a recording that submits is still an R2 write when it is replayed', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // `browser.type` declares R1 and escalates itself to R2 when it is asked to
  // submit, which puts it above the auto-approval line in every mode. It
  // therefore asks while being recorded, and the recording is of an action
  // the user authorised once.
  const recording = answerPrompts(send, { kind: 'approve_once' });
  const saved = await record(send, provider, {
    objective: 'Search for small widgets.',
    calls: [
      {
        name: 'browser.type',
        arguments: {
          elementId: '$element(textbox,Search widgets)',
          text: 'small',
          submit: true,
        },
      },
    ],
    name: 'Search for small widgets',
  });
  recording.stop();

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;
  expect(recording.prompts.map((prompt) => prompt.tool)).toContain('browser.type');
  // The discriminator. This ran in the default mode, which approves anything
  // below R2 without asking — and the page read, an R1 call on the same page
  // in the same task, was not asked about. So the prompt above is the
  // escalation and not the mode.
  expect(recording.prompts.map((prompt) => prompt.tool)).not.toContain('browser.read_page');
  expect(workflow.steps.map((step) => step.tool)).toEqual(['browser.read_page', 'browser.type']);
  // `submit` is structure, kept as written: a replay that dropped it would be
  // a different action wearing the same name.
  expect(workflow.steps[1]?.arguments['submit']).toEqual({ kind: 'literal', detail: 'true' });

  // Reviewing re-prices the recording from the tools its steps reach, and
  // what that yields is each tool's *declared* risk: `browser.type` declares
  // R1. It is a floor, not a prediction — an escalation that depends on the
  // arguments, like this one's `submit`, is computed per call at dispatch
  // against a live page, which a stored record cannot do. The prompts below
  // are what settle the effective risk, and they are the decision that
  // actually gates the write.
  const verdict = await send('workflow.revalidate', { workflowId: workflow.workflowId });
  expect(verdict.ok).toBe(true);
  expect(verdict.risk).toBe('R1');

  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#search')!.value = '';
  });

  // Denied first. Being stored, reviewed and named authorises nothing: the
  // answer given now is the one that counts.
  const denying = answerPrompts(send, { kind: 'deny' });
  const denied = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  denying.stop();
  expect(denied.ok).toBe(false);
  expect(denying.prompts.map((prompt) => prompt.tool)).toContain('browser.type');
  expect((await controlState(target, '#search')).value).toBe('');

  // Then approved, and the write really lands.
  const approving = answerPrompts(send, { kind: 'approve_once' });
  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  approving.stop();
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);
  expect(approving.prompts.map((prompt) => prompt.tool)).toContain('browser.type');
  expect((await controlState(target, '#search')).value).toBe('small');

  await target.close();
});

test('a replay is judged against the site the tab is on, not the site it was recorded on', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // Auto mode and an R2 action, because that is the one combination in which a
  // standing site grant decides anything: the mode stage consults a grant only
  // after the call has cleared every deny stage and is above the
  // auto-approval line. In Manual mode every changing action is confirmed
  // whatever is granted, so a grant there would prove nothing either way.
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
  const { state: granted } = await send('policy.getSitePolicy', {});
  expect(granted.rules.map((rule) => rule.site)).toEqual(['127.0.0.1']);

  // The control, on the granted site: the replay runs the R2 write without
  // asking, because the grant covers it. Without this half, the case below
  // would pass just as well against a build that prompts for everything
  // always.
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#search')!.value = '';
  });
  const quiet = answerPrompts(send, { kind: 'deny' });
  const onGrantedSite = await send('workflow.replay', { workflowId, inputs: {} });
  quiet.stop();
  expect(onGrantedSite.ok, onGrantedSite.detail ?? onGrantedSite.reason ?? '').toBe(true);
  expect(quiet.prompts).toEqual([]);
  expect((await controlState(target, '#search')).value).toBe('small');

  // The same page, byte for byte, reached as a different site. Nothing about
  // the document changed, so the page cannot be what makes the difference.
  await target.goto(site.altBaseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  expect((await controlState(target, '#search')).value).toBe('');

  const denying = answerPrompts(send, { kind: 'deny' });
  const elsewhere = await send('workflow.replay', { workflowId, inputs: {} });
  denying.stop();

  expect(elsewhere.ok).toBe(false);
  // Asked, and asked about the site the tab is actually on. A grant that
  // travelled with the recording would have produced the silence above.
  const asked = denying.prompts.find((prompt) => prompt.tool === 'browser.type');
  expect(asked, `the replay wrote to an ungranted site without asking`).toBeDefined();
  expect(asked?.site).toBe('localhost');
  // And the write did not land, on either origin: denying is a denial, not a
  // delay.
  expect((await controlState(target, '#search')).value).toBe('');

  // Nothing was widened by the attempt.
  const { state: after } = await send('policy.getSitePolicy', {});
  expect(after.rules.map((rule) => rule.site)).toEqual(['127.0.0.1']);

  await target.close();
});

test('a replayed write into a field that has become sensitive confirms even in skip mode', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/advanced-controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  // Recorded while the field is an ordinary note: R1, no prompt, nothing
  // remarkable about it.
  const saved = await record(send, provider, {
    objective: 'Leave a note on the booking.',
    calls: [
      {
        name: 'browser.type',
        arguments: { elementId: '$element(textbox,Note)', text: 'window seat' },
      },
    ],
    name: 'Leave a note',
  });
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;

  // The page changes what that field is. The label is untouched, so the
  // binding still resolves to the same element — what changed is what a write
  // into it means. Classification is recomputed at replay from the page model
  // the replay itself read, which is the only reason this is visible at all.
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#note')!.setAttribute('name', 'ssn');
  });

  // Skip mode: the mode that asks for nothing. The R3 floor is not a mode
  // setting, so it applies here too.
  await send('session.setPermissionMode', { mode: 'skip' });

  const answering = answerPrompts(send, { kind: 'approve_once' });
  const replayed = await send('workflow.replay', {
    workflowId,
    inputs: fillSlots(saved.workflow!, { text: 'window seat' }),
  });
  answering.stop();

  const typePrompt = answering.prompts.find((prompt) => prompt.tool === 'browser.type');
  expect(
    typePrompt,
    `skip mode ran the write unasked: ${JSON.stringify(answering.prompts)}`,
  ).toBeDefined();
  // The field's own sensitivity is why, and it is named in the prompt rather
  // than left for the user to infer.
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);
  expect((await controlState(target, '#note')).value).toBe('window seat');

  await target.close();
});

test('a replayed write into a field that has become a credential is denied, never asked', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/advanced-controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await record(send, provider, {
    objective: 'Leave a note on the booking.',
    calls: [
      {
        name: 'browser.type',
        arguments: { elementId: '$element(textbox,Note)', text: 'window seat' },
      },
    ],
    name: 'Leave a note',
  });
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;

  // A one-time code, declared in the vocabulary browsers agree on. The
  // product refuses to type a credential at all rather than confirming one:
  // an agent that can be talked into typing an OTP behind a prompt is an
  // agent that can be talked into typing an OTP.
  await target.evaluate(() => {
    const note = document.querySelector<HTMLInputElement>('#note')!;
    note.setAttribute('autocomplete', 'one-time-code');
    note.value = '';
  });

  // The most permissive mode there is, and an approver standing by, so
  // nothing but the denial itself can be what stops this.
  await send('session.setPermissionMode', { mode: 'skip' });
  const answering = answerPrompts(send, { kind: 'approve_once' });
  const replayed = await send('workflow.replay', {
    workflowId,
    inputs: fillSlots(saved.workflow!, { text: 'window seat' }),
  });
  answering.stop();

  expect(replayed.ok).toBe(false);
  // The step was reached and refused, rather than the replay having fallen
  // over somewhere earlier: the page read ran, and the write is the step that
  // failed. Without this, "the replay did not happen" would pass against a
  // build that could not resolve the binding at all.
  const steps = replayed.steps ?? [];
  expect(steps.map((step) => step.ran)).toContain('browser.read_page');
  const write = steps.find((step) => step.ran === 'browser.type');
  expect(write, JSON.stringify(replayed)).toBeDefined();
  expect(write?.status).not.toBe('completed');
  // Denied before anyone was asked: R5 is refused ahead of the prompt, so
  // there was never an approval to give.
  expect(answering.prompts.map((prompt) => prompt.tool)).not.toContain('browser.type');
  expect((await controlState(target, '#note')).value).toBe('');

  await target.close();
});

test('a read-only field is not writable by the agent either', async ({
  context,
  send,
  provider,
  site,
}) => {
  // Only a real browser settles this. `readonly` constrains people, not the
  // IDL setter: the native value setter the type tool uses writes straight
  // through it, and a read-only field is still submitted with its form. So
  // until this was guarded the agent could replace a quoted price that no user
  // of the page can edit, the tool reported success, and the page would submit
  // the replacement. jsdom would have shown the same write and proved nothing
  // about what Chrome does with it.
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/advanced-controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser.type',
          arguments: { elementId: '$element(textbox,Quoted price)', text: '1.00' },
        },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Change the quoted price.' });
  await waitForTask(send, task.id, 40_000);

  // Untouched, and still read-only — the guard refused rather than the page
  // having quietly reverted it.
  const quoted = await target.evaluate(() => {
    const element = document.querySelector<HTMLInputElement>('#quoted')!;
    return { value: element.value, readOnly: element.readOnly, disabled: element.disabled };
  });
  expect(quoted.value).toBe('49.00');
  expect(quoted.readOnly).toBe(true);
  // Not the same fact as disabled: the field is enabled and submitted, which
  // is exactly why overwriting it would have mattered.
  expect(quoted.disabled).toBe(false);

  // The refusal reached the model as a failure rather than a success.
  const { events } = await send('audit.list', { taskId: task.id, limit: 50 });
  const write = events.find((event) => event.tool === 'browser.type');
  expect(write, JSON.stringify(events.map((event) => event.type))).toBeDefined();
  expect(write?.outcome).not.toBe('allowed');

  // The control: the same field, once the page makes it writable, accepts the
  // write. Without this the case would pass against a build that had stopped
  // typing into anything.
  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#quoted')!.readOnly = false;
  });
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'browser.read_page', arguments: {} }] },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'browser.type',
          arguments: { elementId: '$element(textbox,Quoted price)', text: '1.00' },
        },
      ],
    },
    { kind: 'text', text: 'Done.' },
  ]);
  const second = await send('task.create', { objective: 'Change the quoted price.' });
  await waitForTask(send, second.task.id, 40_000);
  expect((await controlState(target, '#quoted')).value).toBe('1.00');

  await target.close();
});

// ---------------------------------------------------------------------------
// C. Recordings and the skill registry
// ---------------------------------------------------------------------------

test('a recording that watched a skill run is incomplete and refuses to replay', async ({
  context,
  send,
  provider,
  site,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const answering = answerPrompts(send, { kind: 'approve_once' });
  const saved = await record(send, provider, {
    objective: 'Inspect this page.',
    calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    name: 'Inspect this page',
  });
  answering.stop();

  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflow = saved.workflow!;

  // `skills.run` is not recordable: recording it would nest one execution
  // path inside another, and a recording that replayed a skill would be a
  // second way into the skill runner that nobody reviewed.
  const dropped = workflow.droppedSteps.find((entry) => entry.tool === 'skills.run');
  expect(dropped, JSON.stringify(workflow.droppedSteps)).toBeDefined();
  expect(dropped?.reason).toContain('not a recordable action');
  expect(workflow.steps.map((step) => step.tool)).not.toContain('skills.run');

  // And because something was watched and not written down, the whole
  // recording refuses: running the steps that *were* captured would do
  // something different from the task this came from.
  expect(workflow.incomplete).toBe(true);
  const replayed = await send('workflow.replay', { workflowId: workflow.workflowId, inputs: {} });
  expect(replayed.ok).toBe(false);
  expect(replayed.reason).toBe('INCOMPLETE_RECORDING');
  expect(replayed.status).toBeUndefined();

  await target.close();
});

test('switching every skill off does not switch a recorded workflow off with them', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The honest answer to "replay after skill disablement": a recording is not
  // a registered skill — TEST-E2E-012 proves it never reaches the registry —
  // so the enablement switch has no opinion about it. What gates a replay is
  // its own hash, its revalidation and the policy decision taken per step.
  // This case pins that down in both directions rather than leaving it
  // implied: the switch really is off, and the replay really still runs.
  const target = await context.newPage();
  await target.goto(`${site.baseUrl}/controls`, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();
  await connectProvider(send, provider);

  const saved = await record(send, provider, {
    objective: 'Tick the newsletter box.',
    calls: [
      {
        name: 'browser.set_checked',
        arguments: { elementId: '$element(checkbox,Newsletter)', checked: true },
      },
    ],
    name: 'Tick the newsletter box',
  });
  expect(saved.workflow, JSON.stringify(saved.skipped)).not.toBeNull();
  const workflowId = saved.workflow!.workflowId;

  const { skills } = await send('skill.list', {});
  expect(skills.length).toBeGreaterThan(0);
  for (const skill of skills) {
    const off = await send('skill.setEnabled', {
      skillId: skill.id,
      skillVersion: skill.version,
      enabled: false,
    });
    expect(off.ok).toBe(true);
  }

  // The model's own view is empty, which is what being switched off means.
  const { skills: listed } = await send('skill.list', {});
  expect(listed.every((skill) => !skill.enabled)).toBe(true);

  await target.evaluate(() => {
    document.querySelector<HTMLInputElement>('#news')!.checked = false;
  });

  const replayed = await send('workflow.replay', { workflowId, inputs: {} });
  expect(replayed.ok, replayed.detail ?? replayed.reason ?? '').toBe(true);
  expect((await controlState(target, '#news')).checked).toBe(true);

  await target.close();
});
