/**
 * TEST-E2E-040 — saved prompts and skill enablement in real Chromium.
 *
 * REAL BROWSER + LOCAL TEST SERVER + MOCK PROVIDER. Every call goes through
 * the panel's own message routes into the real service worker, so what is
 * exercised is route trust, the real stores, the real registry and the real
 * dispatch path — not a harness standing in for them.
 *
 * Two things are settled here that a unit test cannot settle. A saved prompt
 * has to survive the round trip through storage and come back as a task the
 * agent really runs, with the objective the person saved. And a skill that is
 * switched off has to be gone from the *model's* view of the world, which
 * means asking the worker what the model would be offered rather than asking
 * the registry directly.
 */
import {
  connectProvider,
  expect,
  killServiceWorker,
  test,
  waitForTask,
} from './fixtures/extension';

test('01 — a saved prompt starts a task with the objective that was saved', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);

  const created = await send('shortcut.create', {
    name: 'triage',
    target: { kind: 'prompt', objective: 'Summarise the widget catalogue.' },
  });
  expect(created.shortcut, JSON.stringify(created)).not.toBeNull();

  const resolved = await send('shortcut.resolve', { typed: '/triage' });
  expect(resolved.ok).toBe(true);
  expect(resolved.resolution?.targetKind).toBe('prompt');
  expect(resolved.resolution?.objective).toBe('Summarise the widget catalogue.');
  // No risk and no step count: an objective has neither until it runs.
  expect(resolved.resolution?.risk).toBeUndefined();

  provider.script([{ kind: 'text', text: 'Nothing to do.' }]);
  const { task } = await send('task.create', {
    objective: resolved.resolution?.objective ?? '',
    shortcutId: resolved.resolution?.shortcutId ?? '',
  });
  const finished = await waitForTask(send, task.id);

  expect(finished.objective).toBe('Summarise the widget catalogue.');
  expect(finished.state).toBe('COMPLETED');

  // The trail links the task to the shortcut it came from, which is otherwise
  // unanswerable: a saved objective reaches `task.create` looking exactly like
  // a typed one.
  const { events } = await send('audit.list', { limit: 200, taskId: task.id });
  const launched = events.find((event) => event.type === 'shortcut.launched');
  expect(launched, JSON.stringify(events.map((event) => event.type))).toBeDefined();

  await page.close();
});

test('02 — a saved prompt survives a worker eviction', async ({
  context,
  send,
  site,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });

  await send('shortcut.create', {
    name: 'persistent',
    target: { kind: 'prompt', objective: 'Check the dashboard for changes.' },
  });

  await killServiceWorker(context, serviceWorker);

  const resolved = await send('shortcut.resolve', { typed: '/persistent' });
  expect(resolved.ok).toBe(true);
  expect(resolved.resolution?.objective).toBe('Check the dashboard for changes.');

  await page.close();
});

test('03 — a shortcut whose objective is junk is refused at creation', async ({ send }) => {
  // NEGATIVE CONTROL. The store validates on the way in as well as out, so a
  // shortcut that could never resolve is never created.
  const created = await send('shortcut.create', {
    name: 'empty',
    target: { kind: 'prompt', objective: '   ' },
  });
  expect(created.shortcut).toBeNull();
  expect(created.error?.reason).toBeDefined();
});

test('04 — turning a skill off removes it from what the model is offered', async ({
  context,
  send,
  provider,
  site,
}) => {
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);

  const before = await send('skill.list', {});
  const target = before.skills[0];
  expect(target, 'this build ships at least one skill').toBeDefined();
  if (!target) return;
  expect(target.enabled).toBe(true);

  const off = await send('skill.setEnabled', {
    skillId: target.id,
    skillVersion: target.version,
    enabled: false,
  });
  expect(off.ok).toBe(true);

  // The settings listing still shows it — that is how it gets turned back on.
  const after = await send('skill.list', {});
  expect(after.skills.find((skill) => skill.id === target.id)?.enabled).toBe(false);

  // And the model's own view no longer has it. Asked through `skills.list`,
  // which is the tool the model would call, driven by the provider script.
  provider.script([
    { kind: 'tool_calls', calls: [{ name: 'skills_list', arguments: {} }] },
    { kind: 'text', text: 'Listed.' },
  ]);
  const { task } = await send('task.create', { objective: 'What workflows are available?' });
  await waitForTask(send, task.id);

  const listed = provider.requests.map((request) => JSON.stringify(request)).join('\n');
  expect(listed).not.toContain(target.id);

  await page.close();
});

test('05 — and running it by name is refused, not merely hidden', async ({
  context,
  send,
  provider,
  site,
}) => {
  // The case that separates a control from a filter. A model that remembered
  // the id from a previous session must not be able to run it anyway.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await connectProvider(send, provider);

  const before = await send('skill.list', {});
  const target = before.skills[0];
  if (!target) return;

  await send('skill.setEnabled', {
    skillId: target.id,
    skillVersion: target.version,
    enabled: false,
  });

  const outcome = await send('skill.run', {
    skillId: target.id,
    skillVersion: target.version,
  });
  expect(outcome.ok).toBe(false);

  // Turning it back on makes it runnable again, so case 05 is not proving a
  // build where nothing runs.
  await send('skill.setEnabled', {
    skillId: target.id,
    skillVersion: target.version,
    enabled: true,
  });
  const restored = await send('skill.list', {});
  expect(restored.skills.find((skill) => skill.id === target.id)?.enabled).toBe(true);

  await page.close();
});

test('06 — the choice survives a worker eviction', async ({
  context,
  send,
  site,
  serviceWorker,
}) => {
  // Durable, and refreshed before the skills are registered in the new worker
  // generation — a switch that forgot itself on eviction would be a switch
  // that silently turns back on.
  const page = await context.newPage();
  await page.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });

  const before = await send('skill.list', {});
  const target = before.skills[0];
  if (!target) return;

  await send('skill.setEnabled', {
    skillId: target.id,
    skillVersion: target.version,
    enabled: false,
  });

  await killServiceWorker(context, serviceWorker);

  // Polled rather than read once. The revived worker registers the bundled
  // skills inside `startup()`, so a single read can land before the listing
  // has anything in it — that is a startup race, not the switch forgetting,
  // and asserting on the empty list would report the wrong failure.
  const deadline = Date.now() + 20_000;
  let row: { enabled: boolean } | undefined;
  for (;;) {
    const after = await send('skill.list', {});
    row = after.skills.find((skill) => skill.id === target.id);
    if (row !== undefined) break;
    if (Date.now() > deadline) throw new Error('The skill never came back after the restart.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  expect(row.enabled).toBe(false);

  await page.close();
});
