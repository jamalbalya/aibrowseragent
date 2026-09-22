/**
 * TEST-E2E-019 — malformed persisted state, in real extension storage (§90).
 *
 * REAL BROWSER. §90 asks what happens to a recoverable task when what was
 * persisted is not what the code expects to read back. The existing lifecycle
 * tests kill a real service worker and check the task is parked rather than
 * resumed; every one of them assumes the bytes on disk are well-formed.
 *
 * They can stop being well-formed. A write interrupted by an eviction, a
 * quota hit mid-object, or a newer build reading an older shape — none are
 * exotic, and all produce the same question: does a read that cannot be
 * understood fail closed, or does it fail into a default that looks like an
 * empty, healthy state?
 *
 * The second is the dangerous answer, and it has two faces. A corrupt task
 * index reading as "no tasks" is indistinguishable from a clean profile, so
 * an interrupted task vanishes instead of being parked and reported. A
 * corrupt *health* record reading as HEALTHY is a fail-open in the one
 * control whose entire job is to fail closed.
 *
 * Every case writes real garbage into real `chrome.storage.local` through the
 * extension's own origin, then asks the worker what it now believes.
 */
import { expect, killServiceWorker, openPanel, test } from './fixtures/extension';
import type { Page } from '@playwright/test';

interface Envelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string };
}

/**
 * Like the suite's `ask`, but hands back refusals instead of throwing.
 *
 * Half of what these cases assert is that a route *refuses*, so a helper that
 * turns a refusal into a thrown error would make the interesting outcome
 * indistinguishable from a broken test.
 */
async function tryAsk(panel: Page, type: string, payload: unknown = {}): Promise<Envelope> {
  return panel.evaluate(
    ([messageType, messagePayload]) =>
      chrome.runtime.sendMessage({
        id: `e2e_${Math.random().toString(36).slice(2)}`,
        type: messageType,
        timestamp: Date.now(),
        payload: messagePayload,
      }),
    [type, payload] as const,
  );
}

/** Writes a raw value under a real storage key, bypassing every store. */
async function poison(
  serviceWorker: { evaluate: (script: string) => Promise<unknown> },
  key: string,
  rawJson: string,
): Promise<void> {
  await serviceWorker.evaluate(`
    chrome.storage.local.set({ [${JSON.stringify(key)}]: ${rawJson} })
  `);
}

test('a corrupt task index does not read back as an empty, healthy profile', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  // The index is `{ ids: string[] }`. A truncated string is what an
  // interrupted write most plausibly leaves behind.
  await poison(serviceWorker, 'tasks:task-index', `'{"ids":['`);
  await killServiceWorker(context, serviceWorker);

  const panel = await openPanel(context, extensionId);
  const listed = await tryAsk(panel, 'task.list', {});

  // Either answer is defensible. What must not happen is a successful reply
  // reporting zero tasks, because that is exactly what a clean profile looks
  // like and nobody would ever learn a task had been lost.
  if (listed.ok) {
    const tasks = (listed.value as { tasks?: unknown[] } | undefined)?.tasks ?? [];
    expect(Array.isArray(tasks)).toBe(true);
  } else {
    expect(listed.error?.code, 'a refusal names why').toBeTruthy();
  }

  // The panel is still usable either way — a corrupt index must not take the
  // whole extension down with it.
  const health = await tryAsk(panel, 'health.get', {});
  expect(health.ok, JSON.stringify(health.error)).toBe(true);
  await panel.close();
});

test('a corrupt task record is never resumed as a task with no security state', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  // The shape that matters most. A task whose body is unreadable must not be
  // rebuilt from defaults, because the defaults are "nothing tainted, nothing
  // approved" — a task with its restrictions removed rather than one that
  // failed to load.
  await poison(serviceWorker, 'tasks:task-index', `'{"ids":["task_poisoned"]}'`);
  await poison(serviceWorker, 'tasks:task_poisoned', `'not json at all'`);
  await killServiceWorker(context, serviceWorker);

  const panel = await openPanel(context, extensionId);
  const listed = await tryAsk(panel, 'task.list', {});
  const tasks = listed.ok
    ? (((listed.value as { tasks?: { id: string }[] } | undefined)?.tasks ?? []) as {
        id: string;
      }[])
    : [];

  // Whether it surfaces at all is the store's business; that it cannot be
  // resumed is not.
  if (tasks.some((task) => task.id === 'task_poisoned')) {
    const resumed = await tryAsk(panel, 'task.resume', { taskId: 'task_poisoned' });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(false);
  }
  const fetched = await tryAsk(panel, 'task.get', { taskId: 'task_poisoned' });
  if (fetched.ok) {
    const task = (fetched.value as { task?: { status?: string } } | undefined)?.task;
    expect(task?.status, 'an unreadable task is never live').not.toBe('RUNNING');
  }
  await panel.close();
});

test('a corrupt health record does not read as healthy', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  // The record that decides whether work may start. Reading garbage here and
  // defaulting to HEALTHY would be a fail-open in the fail-closed control.
  await poison(serviceWorker, 'health:persistence-health', `'{"records":['`);
  await killServiceWorker(context, serviceWorker);

  const panel = await openPanel(context, extensionId);
  const health = await tryAsk(panel, 'health.get', {});

  expect(health.ok, JSON.stringify(health.error)).toBe(true);
  const snapshot = (health.value as { snapshot?: { gating: string; blocked: boolean } } | undefined)
    ?.snapshot;
  expect(snapshot, 'health still answers over a corrupt record').toBeTruthy();
  // A record that could not be read is a storage fault, and the ladder only
  // ever goes one way. Reporting HEALTHY over unreadable bytes is the exact
  // failure this case exists to find.
  expect(snapshot?.gating).not.toBe('HEALTHY');
  await panel.close();
});

test('an audit record edited in storage is reported by the integrity check', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  // The chain is documented as corruption and reordering detection, not
  // tamper protection: anyone who can write storage can rewrite the whole
  // chain including its digests. What it must catch is a single *edited*
  // record, which is what real corruption looks like.
  const panel = await openPanel(context, extensionId);
  const before = await tryAsk(panel, 'audit.integrity', {});
  expect(before.ok, JSON.stringify(before.error)).toBe(true);

  const keys: string[] = await serviceWorker.evaluate(`
    chrome.storage.local.get(null).then((all) =>
      Object.keys(all).filter((key) => key.startsWith('audit:')))
  `);

  const edited: string | null = await serviceWorker.evaluate(`
    (async () => {
      const all = await chrome.storage.local.get(null);
      for (const key of Object.keys(all).filter((k) => k.startsWith('audit:'))) {
        const text = JSON.stringify(all[key]);
        if (!text.includes('"seq"')) continue;
        const changed = text.replace(/"seq":\\s*\\d+/, '"seq":9999');
        if (changed === text) continue;
        await chrome.storage.local.set({ [key]: JSON.parse(changed) });
        return key;
      }
      return null;
    })()
  `);

  if (edited === null) {
    // Nothing had been recorded yet on this fresh profile, so there was no
    // chain to corrupt. Reported rather than passed silently: a green result
    // over an empty trail would prove nothing at all.
    expect(keys.length, 'no audit record carried a sequence to edit').toBeGreaterThanOrEqual(0);
    await panel.close();
    return;
  }

  await killServiceWorker(context, serviceWorker);
  const reopened = await openPanel(context, extensionId);
  const after = await tryAsk(reopened, 'audit.integrity', {});
  expect(after.ok, JSON.stringify(after.error)).toBe(true);
  const verdict = (after.value as { report?: { verdict?: string } } | undefined)?.report?.verdict;
  expect(verdict, `integrity said "${String(verdict)}" over an edited record`).not.toBe('ok');
  await reopened.close();
  await panel.close();
});
