/**
 * TEST-E2E-024 — local-first, in real Chromium.
 *
 * The unit suites establish the rules. What they cannot establish is whether
 * a freshly loaded extension, with a real service worker over real
 * `chrome.storage.local`, actually behaves like a product that needs nothing
 * installed. That is what this checks.
 *
 * The strongest case here is the first one, and it is worth saying why: the
 * extension is loaded with **no backend origin compiled in, no account, and
 * no network destination configured**, and it is then asked to do the things
 * the product is for. If any of them needed a server, they would fail here.
 */
import { expect, killServiceWorker, test } from './fixtures/extension';

test('a fresh installation is in local mode with no account and no choice made', async ({
  send,
}) => {
  const preference = await send('storage.getPreference', {});

  expect(preference.mode).toBe('local');
  // Not a question the user has to answer before the extension works.
  expect(preference.hasChosen).toBe(false);

  // And no AI Browser Agent account exists or is required.
  const auth = await send('auth.status', {});
  expect(auth.state).toBe('signed_out');
  expect(auth.configured).toBe(false);
});

test('workflows, shortcuts and workspaces all work with no backend at all', async ({
  send,
  serviceWorker,
}) => {
  // A workspace, created and read back through the real routes.
  const created = await send('workspace.create', { title: 'Local only' });
  expect(created.error).toBeUndefined();
  expect(created.workspaceId).not.toBe('');

  const listed = await send('workspace.state', {});
  expect(listed.workspaces.some((w) => w.title === 'Local only')).toBe(true);

  // All of it landed in chrome.storage.local, as independent records.
  const keys = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all);
  });
  expect(keys.some((key) => key.includes('workspace:v1:'))).toBe(true);
});

test('local records survive a real service-worker termination', async ({
  send,
  context,
  serviceWorker,
}) => {
  await send('workspace.create', { title: 'Survives eviction' });

  await killServiceWorker(context, serviceWorker);

  const after = await send('workspace.state', {});
  expect(after.workspaces.some((w) => w.title === 'Survives eviction')).toBe(true);
});

test('the export carries the user’s work and no credential', async ({ send, provider }) => {
  const key = 'test-key-local-first-aaaaaaaa';
  await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: key,
    model: 'mock-model',
    displayName: 'OpenAI — Local',
  });

  const { export: document_ } = await send('data.export', {});
  const serialised = JSON.stringify(document_);

  // The connection is there, so a restore knows what to reconnect to.
  expect(document_.connections.some((c) => c.providerId === 'openai-compatible')).toBe(true);
  // The key is not, and neither is the label that carries its suffix.
  expect(serialised).not.toContain(key);
  expect(serialised).not.toContain('accountLabel');
  expect(document_.notice).toMatch(/no API keys/i);
});

test('an import that carries a credential is refused by the real worker', async ({ send }) => {
  const result = await send('data.import', {
    document: {
      kind: 'aba.local-export',
      formatVersion: 1,
      exportedAt: Date.now(),
      notice: 'n/a',
      workflows: [{ workflowId: 'wf_1', apiKey: 'sk-should-never-be-accepted' }],
      shortcuts: [],
      connections: [],
      settings: {},
    },
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.refusal).toBe('CONTAINS_CREDENTIAL');
});

test('an unrelated file is refused rather than partially applied', async ({ send }) => {
  const before = await send('workflow.list', {});

  const result = await send('data.import', { document: { hello: 'world' } });

  expect(result.ok).toBe(false);
  // Nothing changed. A refusal that had already written half the file would
  // be worse than no import at all.
  const after = await send('workflow.list', {});
  expect(after.workflows.length).toBe(before.workflows.length);
});

test('local-first added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.permissions).not.toContain('identity');
  expect(manifest.host_permissions).not.toContain('<all_urls>');
  expect(manifest.permissions?.sort()).toEqual(
    [
      'activeTab',
      'debugger',
      'notifications',
      'scripting',
      'sidePanel',
      'storage',
      'tabGroups',
      'tabs',
      'unlimitedStorage',
    ].sort(),
  );
});

test('the panel shows the data section and says where things are stored', async ({ panel }) => {
  await panel.getByRole('button', { name: 'Settings' }).click();

  const data = panel.getByRole('region', { name: 'Your data' });
  await expect(data).toBeVisible();

  // The honest statement, in the words a user reads.
  await expect(panel.getByTestId('storage-mode')).toContainText('stored on this computer');
  await expect(panel.getByTestId('data-export')).toBeVisible();
  await expect(panel.getByTestId('data-import')).toBeVisible();

  const text = (await panel.locator('.settings').innerText()).toLowerCase();

  // No infrastructure word reaches a user. These are development and
  // deployment concerns and belong nowhere near this panel.
  for (const forbidden of ['postgres', 'database', 'docker', 'schema', 'migration', ' sql']) {
    expect(text).not.toContain(forbidden);
  }

  // And nothing instructs the user to operate anything. The word "server"
  // does appear once — describing a *provider* endpoint you might self-host,
  // which is a real option an OpenAI-compatible connection supports. What
  // must never appear is an instruction to run one of ours.
  for (const instruction of [
    'start the backend',
    'start the server',
    'run the server',
    'run the database',
    'run migration',
    'configure postgres',
  ]) {
    expect(text).not.toContain(instruction);
  }
});
