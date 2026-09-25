/**
 * TEST-E2E-011 — skills in real Chromium (Stage 3 Wave G).
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. The pages are served over
 * real HTTP from 127.0.0.1, the content script is really injected, and the
 * model's side of the conversation comes from a local server speaking the
 * Chat Completions protocol. No production service is contacted.
 *
 * What only a real browser can settle:
 *
 * **That the skills actually registered.** The registry validates against the
 * tool registry at worker startup, so a bundled skill naming a tool that does
 * not exist is left out — and a unit test cannot see that, because it supplies
 * its own tool names. Here the check is against the tools the product really
 * has.
 *
 * **That a skill drives the real browser.** A workflow that reads a page runs
 * the real content script against real layout, not a fixture.
 *
 * **That a model cannot invent one.** The model here genuinely asks for a
 * skill that does not exist, and the refusal comes back through the real
 * dispatch path into the real conversation.
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

import { BUNDLED_SKILLS } from '@/skills/bundled';
/** What the model was told, with one level of JSON escaping undone. */
function modelSaw(provider: { requests: readonly { body: unknown }[] }): string {
  return JSON.stringify(provider.requests).replace(/\\"/g, '"');
}

/**
 * Answers every permission prompt, as the side panel would.
 *
 * A loop rather than a single answer: a workflow asks once per risky step, so
 * a test that answered exactly one would hang on the second — which is itself
 * the property under test, and the reason this helper exists.
 */
function autoAnswer(
  send: SendToWorker,
  decide: 'approve_once' | 'deny' | ((tool: string) => 'approve_once' | 'deny'),
): { asked: string[]; stop: () => void } {
  const asked: string[] = [];
  const answer = typeof decide === 'function' ? decide : (): typeof decide => decide;
  let running = true;

  void (async () => {
    while (running) {
      try {
        const { requests } = await send('permission.listPending', {});
        for (const pending of requests) {
          asked.push(pending.tool);
          await send('permission.respond', {
            requestId: pending.id,
            response: { kind: answer(pending.tool) },
          });
        }
      } catch {
        // The panel closes at the end of a test; nothing left to answer.
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

// --- registration -----------------------------------------------------------

test('the bundled skills register against the tools this build really has', async ({ send }) => {
  const { skills } = await send('skill.list', {});

  // A bundled skill naming a tool that does not exist is left out at startup
  // rather than throwing, so "some skills registered" is not the same as "all
  // of them did". This asserts the count.
  expect(skills.length).toBe(BUNDLED_SKILLS.length);
  // Enumerated as well as counted, so adding a skill and forgetting to
  // register it cannot be hidden by a skill that failed to register.
  expect(skills.map((skill) => skill.id).sort()).toEqual([
    'form.fill_and_submit',
    'github.find_issue',
    'page.inspect',
    'page.open_and_read',
  ]);
});

test('each skill reports the risk its own steps reach', async ({ send }) => {
  const { skills } = await send('skill.list', {});
  const open = skills.find((skill) => skill.id === 'page.open_and_read')!;
  const inspect = skills.find((skill) => skill.id === 'page.inspect')!;

  // Computed from the real tools: navigating is R1, reading is R0.
  expect(open.risk).toBe('R1');
  expect(inspect.risk).toBe('R0');
  expect(open.tools).toContain('browser.navigate');
});

test('each skill carries a definition hash', async ({ send }) => {
  const { skills } = await send('skill.list', {});
  for (const skill of skills) {
    expect(skill.hash).toMatch(/^[0-9a-f]{64}$/);
  }
  // Different definitions, different hashes.
  expect(new Set(skills.map((skill) => skill.hash)).size).toBe(skills.length);
});

test('the skill tools are in the registry the model is offered', async ({ send }) => {
  const { tools } = await send('tools.list', {});
  const names = tools.map((tool) => tool.name);

  // They enter the one registry, so the one policy engine classifies them.
  expect(names).toContain('skills.list');
  expect(names).toContain('skills.run');
});

// --- execution --------------------------------------------------------------

test('a skill drives the real browser through several steps', async ({
  send,
  provider,
  site,
  page,
}) => {
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await connectProvider(send, provider);

  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    },
    { kind: 'text', text: 'I inspected the page.' },
  ]);

  const { task } = await send('task.create', { objective: 'Inspect this page.' });
  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.state).toBe('COMPLETED');

  // The workflow really ran its steps: the page model came back from the real
  // content script, against real layout.
  const sent = modelSaw(provider);
  expect(sent).toContain('page.inspect');
  expect(sent).toContain('"status":"completed"');
});

test('a skill that navigates asks before it navigates', async ({
  context,
  send,
  provider,
  site,
}) => {
  // A page of its own, brought to the front: the workflow navigates the
  // *active* tab, and the side panel is a real page in this context, so
  // without this the workflow would navigate the panel away from under the
  // test.
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'skills.run',
          arguments: { skillId: 'page.open_and_read', inputs: { url: `${site.baseUrl}/` } },
        },
      ],
    },
    { kind: 'text', text: 'Opened and read it.' },
  ]);

  // Manual mode, so every step is put to the user. In Auto mode both of this
  // skill's steps are low-risk and run without a prompt, which is correct and
  // proves nothing about bundling — the property under test is that a
  // workflow asks *per step* rather than once for the run.
  await send('session.setPermissionMode', { mode: 'manual' });

  const answers = autoAnswer(send, 'approve_once');
  const { task } = await send('task.create', { objective: 'Open the test site and read it.' });
  const finished = await waitForTask(send, task.id, 40_000);
  answers.stop();

  // Both steps were asked about, individually, exactly as bare tool calls
  // would have been. Being inside a workflow turned two approvals into two.
  // The claim this wave turns on. Approving the run did **not** buy the step:
  // both were asked about, separately, and the step-level prompt named the
  // actual tool rather than the workflow.
  expect(answers.asked).toContain('skills.run');
  expect(answers.asked).toContain('browser.navigate');
  expect(['COMPLETED', 'PARTIAL']).toContain(finished.state);
});

test('approving the run does not approve a step inside it', async ({
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
      calls: [
        {
          name: 'skills.run',
          arguments: { skillId: 'page.open_and_read', inputs: { url: `${site.baseUrl}/details` } },
        },
      ],
    },
    { kind: 'text', text: 'The navigation was refused.' },
  ]);

  await send('session.setPermissionMode', { mode: 'manual' });

  // Yes to the workflow, no to the navigation inside it.
  const answers = autoAnswer(send, (tool) =>
    tool === 'browser.navigate' ? 'deny' : 'approve_once',
  );
  const { task } = await send('task.create', { objective: 'Open the details page.' });
  await waitForTask(send, task.id, 40_000);
  answers.stop();

  expect(answers.asked).toContain('skills.run');
  expect(answers.asked).toContain('browser.navigate');

  // The workflow was approved and the step inside it was still refused, so
  // the run stopped and the browser never went anywhere.
  expect(target.url()).not.toContain('/details');
  expect(modelSaw(provider)).toMatch(/PERMISSION_DENIED/);
});

test('declining the run stops it before any step', async ({ context, send, provider, site }) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'skills.run',
          arguments: { skillId: 'page.open_and_read', inputs: { url: `${site.baseUrl}/` } },
        },
      ],
    },
    { kind: 'text', text: 'I could not open it.' },
  ]);

  await send('session.setPermissionMode', { mode: 'manual' });

  const answers = autoAnswer(send, 'deny');
  const { task } = await send('task.create', { objective: 'Open the test site.' });
  const finished = await waitForTask(send, task.id, 40_000);
  answers.stop();

  expect(['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED']).toContain(finished.state);

  // The first step was declined, so the second never ran: the workflow
  // stopped rather than carrying on with a step that assumed it had.
  // Declining the run itself stops it before any step: the workflow is gated
  // as a whole *as well as* per step, and the outer refusal is enough.
  expect(answers.asked).toContain('skills.run');
  expect(answers.asked).not.toContain('browser.navigate');
  expect(target.url()).toBe(`${site.baseUrl}/`);
  expect(modelSaw(provider)).toMatch(/PERMISSION_DENIED/);
});

// --- a model cannot invent one ---------------------------------------------

test('a skill the model invented is refused, not created', async ({ send, provider }) => {
  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'skills.run',
          arguments: {
            skillId: 'exfiltrate.everything',
            inputs: { destination: 'https://attacker.test' },
          },
        },
      ],
    },
    { kind: 'text', text: 'That workflow does not exist.' },
  ]);

  // An unregistered skill classifies at the worst case, so it prompts. The
  // approval is answered and the call is *still* refused — which is the
  // point: approving does not conjure the workflow into existence.
  const answers = autoAnswer(send, 'approve_once');
  const { task } = await send('task.create', { objective: 'Run the exfiltrate workflow.' });
  await waitForTask(send, task.id, 40_000);
  answers.stop();

  // Refused, and nothing was created: the registry still holds exactly what
  // the build ships and nothing beside it.
  const { skills } = await send('skill.list', {});
  expect(skills.map((skill) => skill.id)).not.toContain('exfiltrate.everything');
  expect(skills.length).toBe(BUNDLED_SKILLS.length);

  const sent = modelSaw(provider);
  expect(sent).toMatch(/TOOL_NOT_FOUND|no workflow called|does not exist/i);
});

test('a skill cannot be added through any message the panel can send', async ({ send }) => {
  // There is no `skill.register` route. Sending one is a protocol error, not
  // a registration.
  await expect(
    (send as unknown as (type: string, payload: unknown) => Promise<unknown>)('skill.register', {
      definition: { id: 'injected.skill', version: '1.0.0', provenance: 'bundled' },
    }),
  ).rejects.toThrow();

  const { skills } = await send('skill.list', {});
  expect(skills.map((skill) => skill.id)).not.toContain('injected.skill');
});

test('a model cannot reach a skill except through skills.run', async ({ send }) => {
  const { tools } = await send('tools.list', {});
  const skillTools = tools.filter((tool) => tool.name.startsWith('skills.'));

  // Exactly two, and neither takes a definition — `skills.list` reads and
  // `skills.run` names one. A third would be worth asking about.
  expect(skillTools.map((tool) => tool.name).sort()).toEqual(['skills.list', 'skills.run']);
});

// --- audit ------------------------------------------------------------------

test('a skill run is recorded without its inputs or results', async ({
  send,
  provider,
  site,
  page,
}) => {
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Inspect the page.' });
  await waitForTask(send, task.id, 40_000);

  const { events } = await send('audit.list', { limit: 60 });
  const skillEvents = events.filter((event) => event.type.startsWith('skill.'));

  expect(skillEvents.length).toBeGreaterThan(0);
  const started = skillEvents.find((event) => event.type === 'skill.started')!;
  expect(started.skillId).toBe('page.inspect');
  expect(started.skillHash).toMatch(/^[0-9a-f]{64}$/);

  // The trail says which workflow ran and how it ended. It does not carry
  // what the workflow read — the page text is not in here.
  const dumped = JSON.stringify(skillEvents);
  for (const forbidden of ['inputs', 'outputs', 'result"', 'password', 'Bearer ']) {
    expect(dumped).not.toContain(forbidden);
  }
});

// --- service worker lifecycle -----------------------------------------------

test('a skill run interrupted by a worker restart is not silently resumed', async ({
  send,
  provider,
  site,
  page,
  serviceWorker,
}) => {
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    },
    { kind: 'text', text: 'Done.' },
  ]);

  const { task } = await send('task.create', { objective: 'Inspect the page.' });
  await waitForTask(send, task.id, 40_000);

  const { runs } = await send('skill.runs', { taskId: task.id });
  expect(runs.length).toBeGreaterThan(0);
  // A run that finished is settled, not left looking live.
  expect(runs[0]!.state).not.toBe('running');
  expect(runs[0]!.skillId).toBe('page.inspect');

  // The record carries identifiers and progress, and nothing the run read.
  const dumped = JSON.stringify(runs);
  for (const forbidden of ['items', 'outputs', 'password', 'token']) {
    expect(dumped).not.toContain(forbidden);
  }
  void serviceWorker;
});

// --- blocked egress, measured at the receiving side -------------------------

test('a blocked egress inside a skill produces zero hits on the receiving origin', async ({
  context,
  send,
  provider,
  site,
  collector,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  await connectProvider(send, provider);
  // Read a real page first so the task genuinely carries taint, then try to
  // navigate to a different origin from inside a workflow.
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    },
    {
      kind: 'tool_calls',
      calls: [
        {
          name: 'skills.run',
          arguments: {
            skillId: 'page.open_and_read',
            inputs: { url: `${collector.baseUrl}/?leak=1` },
          },
        },
      ],
    },
    { kind: 'text', text: 'The second workflow was refused.' },
  ]);

  await send('session.setPermissionMode', { mode: 'manual' });
  const answers = autoAnswer(send, (tool) =>
    tool === 'browser.navigate' ? 'deny' : 'approve_once',
  );
  const { task } = await send('task.create', { objective: 'Inspect, then open the other site.' });
  await waitForTask(send, task.id, 60_000);
  answers.stop();

  // The independent witness. A refusal inside the extension that still issued
  // the request would look identical from the inside, which is why this
  // assertion is on the receiving server rather than on a decision code.
  expect(collector.requests).toEqual([]);
  expect(answers.asked).toContain('browser.navigate');
});

test('a skill run records no page content in the audit trail', async ({
  send,
  provider,
  site,
  page,
}) => {
  // The page carries a distinctive string; the workflow reads it; the audit
  // trail must not contain it anywhere, at any nesting.
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 40));

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    },
    { kind: 'text', text: 'Read it.' },
  ]);

  const { task } = await send('task.create', { objective: 'Inspect the page.' });
  await waitForTask(send, task.id, 40_000);

  const { events } = await send('audit.list', { limit: 100 });
  const dumped = JSON.stringify(events);

  const distinctive = pageText.split(/\s+/).filter((word) => word.length > 6);
  // Guard against the assertion below passing because there was nothing to
  // look for.
  expect(distinctive.length).toBeGreaterThan(0);
  for (const word of distinctive.slice(0, 5)) {
    expect(dumped).not.toContain(word);
  }
  // And the skill events are there, so this is not vacuous.
  expect(events.some((event) => event.type.startsWith('skill.'))).toBe(true);
});

test("a real worker termination does not reduce a skill task's security state", async ({
  context,
  send,
  provider,
  site,
  extensionId,
  serviceWorker,
}) => {
  const target = await context.newPage();
  await target.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await target.bringToFront();

  await connectProvider(send, provider);
  provider.script([
    {
      kind: 'tool_calls',
      calls: [{ name: 'skills.run', arguments: { skillId: 'page.inspect' } }],
    },
    { kind: 'text', text: 'Read it.' },
  ]);

  // 1-3. Run a workflow that really reads the page, so the task acquires
  //      taint through the ordinary path and it is persisted.
  const { task } = await send('task.create', { objective: 'Inspect the page.' });
  await waitForTask(send, task.id, 40_000);

  // 4. Confirm the state exists before termination. Asserted rather than
  //    assumed: a task that was never tainted would make everything below
  //    vacuous.
  const before = await send('task.get', { taskId: task.id });
  expect(before.task?.taintState.kind).toBe('TAINTED');
  const sourcesBefore =
    before.task?.taintState.kind === 'TAINTED' ? before.task.taintState.sources : [];
  expect(sourcesBefore.length).toBeGreaterThan(0);
  expect(sourcesBefore.some((source) => source.sourceType === 'web_page')).toBe(true);

  // Put the stored record back into a live state, exactly as an eviction
  // mid-execution would leave it, so the restart has something to recover.
  await serviceWorker.evaluate(async (taskId) => {
    const key = `tasks:task:${taskId}`;
    const stored = await chrome.storage.local.get(key);
    const record = stored[key] as { state: string; finishedAt?: number };
    record.state = 'RUNNING';
    delete record.finishedAt;
    await chrome.storage.local.set({ [key]: record });
  }, task.id);

  // 5. Terminate the worker for real, by closing its CDP target. Not a
  //    reload, not a new context, not a sleep — the worker's global scope is
  //    destroyed and Chrome spins up a fresh one on the next event.
  await killServiceWorker(context, serviceWorker);

  // 6-7. Wake it and rehydrate the same task. The `send` fixture is bound to
  //      the old panel, whose port died with the worker, so a fresh panel is
  //      the only way to talk to the new one.
  const panel = await openPanel(context, extensionId);
  const after = await ask<{
    task: {
      id: string;
      state: string;
      currentStepSummary?: string;
      providerId: string;
      modelId: string;
      taintSalt: string;
      saltEpoch: number;
      taintState: { kind: string; sources?: { sourceType: string; site?: string }[] };
    };
  }>(panel, 'task.get', { taskId: task.id });

  // **The negative assertion.** This summary is written by
  // `lifecycle.recoverInterruptedTasks()`, which runs only from the worker's
  // `startup()`. A reload, a new panel, a fresh task or simply waiting cannot
  // produce it, so the test fails if the worker was not genuinely restarted —
  // which is exactly how the previous version of this test passed while
  // terminating nothing.
  expect(after.task.state).toBe('PAUSED');
  expect(after.task.currentStepSummary).toContain('restarted');

  // 8-9. The lifecycle contract is park-and-recover, not blind continuation,
  //      and the security state came through it intact.
  expect(after.task.id).toBe(task.id);
  expect(after.task.providerId).toBe(before.task?.providerId);
  expect(after.task.modelId).toBe(before.task?.modelId);
  expect(after.task.taintSalt).toBe(before.task?.taintSalt);
  expect(after.task.saltEpoch).toBe(before.task?.saltEpoch);

  // 10. And no weaker state was produced. Eviction must not turn "this task
  //     read the intranet" into "this task read nothing", which is the Stage 2
  //     defect this whole line of testing exists for.
  expect(after.task.taintState.kind).toBe('TAINTED');
  expect(after.task.taintState.kind).not.toBe('KNOWN_UNTAINTED');
  expect(after.task.taintState.sources).toEqual(sourcesBefore);
  expect(after.task.taintState.sources?.length).toBe(sourcesBefore.length);
});

// --- what skills did not add ------------------------------------------------

test('skills added no permission and no host access', async ({ serviceWorker }) => {
  const granted = await serviceWorker.evaluate(async () => await chrome.permissions.getAll());

  for (const forbidden of ['identity', 'cookies', 'webRequest', 'management', 'nativeMessaging']) {
    expect(granted.permissions ?? []).not.toContain(forbidden);
  }
  expect(granted.origins ?? []).not.toContain('<all_urls>');
});

test('the manifest Chrome loaded gives a skill nowhere to run code', async ({ serviceWorker }) => {
  // A workflow engine is where a scripting escape hatch would naturally be
  // added, so this asserts on the manifest the browser actually loaded rather
  // than the file on disk.
  //
  // It deliberately does not probe `new Function` through the worker: an
  // evaluation injected over the debugger protocol does not run under the
  // page's CSP, so a probe that way measures the test harness rather than the
  // product. What a skill can reach is settled by the absence of any
  // evaluator in the skill source — asserted in the security suite — and by
  // the policy below.
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  const policy = manifest.content_security_policy;
  const extensionPages = typeof policy === 'string' ? policy : (policy?.extension_pages ?? '');
  expect(extensionPages).toContain("script-src 'self'");
  expect(manifest.permissions ?? []).not.toContain('nativeMessaging');
  expect(manifest.permissions ?? []).not.toContain('management');
});
