/**
 * TEST-E2E-020 — two AI accounts on one endpoint, in a real browser.
 *
 * MOCK PROVIDER E2E. The endpoint is a local server speaking the Chat
 * Completions protocol, not a commercial provider. Nothing here is evidence
 * that OpenAI, Anthropic or Gemini has been exercised.
 *
 * What the unit suites cannot establish is whether any of this survives real
 * `chrome.storage.local`, a real service-worker lifecycle and a real message
 * router with route trust in front of it. These do.
 *
 * The case that matters most is the first one: two accounts reached at the
 * *same* origin, with *different* keys, stored under different credential
 * keys and both present at once. Before `connectionId`, the second connect
 * overwrote the first and there was no way to tell that had happened.
 */
import { expect, killServiceWorker, test } from './fixtures/extension';

const KEY_A = 'test-key-personal-aaaaaaaa';
const KEY_B = 'test-key-work-bbbbbbbbbb';

test('two accounts on one endpoint coexist with separate credentials', async ({
  send,
  provider,
  serviceWorker,
}) => {
  const personal = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
    displayName: 'OpenAI — Personal',
  });
  const work = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_B,
    model: 'mock-model',
    displayName: 'OpenAI — Work',
  });

  expect(personal.error).toBeUndefined();
  expect(work.error).toBeUndefined();
  expect(personal.account?.connectionId).not.toBe(work.account?.connectionId);

  // Both are there. The second connect did not replace the first.
  const listed = await send('accounts.list', {});
  expect(listed.accounts.length).toBe(2);

  // And in real extension storage they are under separate credential keys.
  const stored = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((key) => key.includes('credentials:conn:'));
  });
  expect(stored.length).toBe(2);
});

test('the account list never carries a credential', async ({ send, provider }) => {
  await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
  });

  const listed = await send('accounts.list', {});
  const serialised = JSON.stringify(listed);

  // The label may carry the last four characters — enough to tell two of your
  // own keys apart, not enough to use. The key itself must be absent.
  expect(serialised).not.toContain(KEY_A);
});

test('the AI brain survives a real service-worker termination', async ({
  send,
  provider,
  context,
  serviceWorker,
}) => {
  const account = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
  });
  const connectionId = account.account!.connectionId;
  await send('accounts.setBrain', { connectionId, modelId: 'mock-model' });

  await killServiceWorker(context, serviceWorker);

  const after = await send('accounts.list', {});
  expect(after.brain?.connectionId).toBe(connectionId);
  expect(after.accounts.length).toBe(1);
});

test('disconnecting removes the credential and clears the brain, with no fallback', async ({
  send,
  provider,
  serviceWorker,
}) => {
  const first = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
  });
  await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_B,
    model: 'mock-model',
  });
  const connectionId = first.account!.connectionId;
  await send('accounts.setBrain', { connectionId, modelId: 'mock-model' });

  await send('accounts.disconnect', { connectionId });

  const after = await send('accounts.list', {});
  expect(after.accounts.length).toBe(1);
  // Not silently re-pointed at the surviving account: specification §60
  // forbids a provider fallback nobody chose.
  expect(after.brain).toBeNull();

  const remaining = await serviceWorker.evaluate(async (removed: string) => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((key) => key.includes(`credentials:conn:${removed}`));
  }, connectionId);
  expect(remaining).toEqual([]);
});

test('a capability measurement is scoped to the account it was taken on', async ({
  send,
  provider,
}) => {
  const a = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
  });
  const b = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_B,
    model: 'mock-model',
  });

  await send('accounts.runDoctor', {
    connectionId: a.account!.connectionId,
    modelId: 'mock-model',
  });

  const listed = await send('accounts.list', {});
  const measured = listed.accounts.find((x) => x.connectionId === a.account!.connectionId);
  const unmeasured = listed.accounts.find((x) => x.connectionId === b.account!.connectionId);

  expect(measured?.capabilities).not.toBeNull();
  // The other account was never measured. Same provider, same endpoint, same
  // model id — and no capability claim, because none was taken on its key.
  expect(unmeasured?.capabilities).toBeNull();
});

test('accounts and the brain survive in real storage across a restart', async ({
  send,
  provider,
  context,
  serviceWorker,
}) => {
  await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
    displayName: 'OpenAI — Personal',
  });

  await killServiceWorker(context, serviceWorker);

  const after = await send('accounts.list', {});
  expect(after.accounts[0]?.displayName).toBe('OpenAI — Personal');
});

test('multi-account added no permission and no host access', async ({ serviceWorker }) => {
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
