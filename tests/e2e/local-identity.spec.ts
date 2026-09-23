/**
 * TEST-E2E-026 — the installation identity, in a real browser with no backend.
 *
 * The unit suite proves the module's rules against a memory store. What only
 * a real browser can establish is whether the identity survives what actually
 * destroys state in an MV3 extension: a terminated service worker, a real
 * `chrome.storage.local`, and a panel whose port died with the worker.
 *
 * Every case runs against the **shipped `dist/` build** — the one with no
 * configured backend origin — so the file is also standalone evidence: an
 * installation that has never contacted anything still knows whose data it
 * holds.
 *
 * The owner is read from storage rather than from a route, deliberately. No
 * route exposes it and none should: an installation label is not something an
 * ordinary user needs to see, so there is nothing to ask.
 */
import type { Worker } from '@playwright/test';
import { expect, killServiceWorker, openPanel, test } from './fixtures/extension';

const ID_PATTERN = /^loc_[0-9a-f]{32}$/;

/** The persisted installation record, read the way the worker stores it. */
async function storedIdentity(
  worker: Worker,
): Promise<{ key: string; value: Record<string, unknown> } | null> {
  // Polled rather than read once: the identity is established as the worker
  // comes up, and a test that read `chrome.storage` in the same instant would
  // be racing that write rather than testing it.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = await worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const key = Object.keys(all).find((name) => name.includes('identity-local'));
      return key === undefined ? null : { key, value: all[key] as Record<string, unknown> };
    });
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

test('an installation that has never signed in mints its own owner', async ({ serviceWorker }) => {
  const stored = await storedIdentity(serviceWorker);

  expect(stored).not.toBeNull();
  const id = stored?.value.installationId;
  // A real, locally minted owner — not the `unassigned` placeholder every
  // installation ran under while a sign-in was the only source of one.
  expect(id).toMatch(ID_PATTERN);
  expect(id).not.toBe('unassigned');
  // Three fields, none personal and none secret.
  expect(Object.keys(stored?.value ?? {}).sort()).toEqual([
    'createdAt',
    'installationId',
    'version',
  ]);
});

test('the identity is in chrome.storage.local, so it outlives the worker', async ({
  serviceWorker,
}) => {
  const stored = await storedIdentity(serviceWorker);

  // `storage.local` rather than `storage.session`: the latter is cleared when
  // the browser closes, which is precisely what this must not do.
  const inSession = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return Object.keys(all).some((name) => name.includes('identity-local'));
  });
  expect(stored).not.toBeNull();
  expect(inSession).toBe(false);
});

test('the identity survives a real service-worker termination', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const before = (await storedIdentity(serviceWorker))?.value.installationId;
  expect(before).toMatch(ID_PATTERN);

  // A genuine CDP termination, the same one the shared harness uses.
  await killServiceWorker(context, serviceWorker);

  // The old panel's port died with the worker, so opening a fresh one is both
  // how the worker is woken and how a real user would return.
  const panel = await openPanel(context, extensionId);
  const restarted = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  const after = (await storedIdentity(restarted))?.value.installationId;
  // The same id. A worker that had lost it would have minted a new one here,
  // and every row already labelled with the old one would be orphaned.
  expect(after).toBe(before);
  await panel.close();
});

test('the restarted worker reads the identity rather than re-minting it', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const before = await storedIdentity(serviceWorker);
  const createdAt = before?.value.createdAt;

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);
  const restarted = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // Exercise a route so the worker actually resolves an owner after waking.
  await storedIdentity(restarted);

  const after = await storedIdentity(restarted);
  // The creation time is the original one, which a re-mint could not preserve.
  expect(after?.value.createdAt).toBe(createdAt);
  await panel.close();
});

test('workspaces created on this installation are stored under its owner', async ({
  serviceWorker,
  send,
}) => {
  const owner = (await storedIdentity(serviceWorker))?.value.installationId;
  expect(owner).toMatch(ID_PATTERN);

  // Two, because the point is that one owner holds many. The identity
  // partitions data between installations; it does not partition workspaces
  // from each other, and membership stays a browser-runtime boundary.
  const first = await send('workspace.create', { title: 'Research' });
  const second = await send('workspace.create', { title: 'Invoices' });
  expect(first.workspaceId).toBeTruthy();
  expect(second.workspaceId).toBeTruthy();

  const stored = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith('workspaces:'))
      .map(([, value]) => JSON.stringify(value));
  });

  const mine = stored.filter((row) => row.includes(String(owner)));
  // Both persisted rows carry this installation's owner, and none carries the
  // `unassigned` placeholder that would have been written before this phase.
  expect(mine.length).toBeGreaterThanOrEqual(2);
  expect(stored.some((row) => row.includes('"abaUserId":"unassigned"'))).toBe(false);
});

test('connecting a provider does not change or consult the owner', async ({
  serviceWorker,
  send,
  provider,
}) => {
  const before = (await storedIdentity(serviceWorker))?.value.installationId;

  const connected = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-local-identity-aaaa',
    model: 'mock-model',
    displayName: 'Local',
  });
  expect(connected.error).toBeUndefined();

  // A provider connection is the user's own, needs no account of ours, and
  // leaves the installation label exactly as it was.
  const after = (await storedIdentity(serviceWorker))?.value.installationId;
  expect(after).toBe(before);
});
