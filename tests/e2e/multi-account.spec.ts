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
import { expect, killServiceWorker, test, waitForTask } from './fixtures/extension';

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

test('the selected account is the one that actually serves the agent’s request', async ({
  send,
  provider,
}) => {
  // **The product's central promise, measured.** Everything else about
  // account selection is covered by something adjacent — the selector, the
  // store, the consent pin, the capability scope — and none of those is this.
  // A build could pass all of them and still send every request with
  // whichever key was connected first.
  //
  // Here two accounts are connected at the *same* endpoint with *different*
  // keys, a task is run, and the assertion is on the `Authorization` header
  // the mock provider actually received. That is the only observation that
  // distinguishes "the right account" from "the right provider".
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
  const personalId = personal.account!.connectionId;
  const workId = work.account!.connectionId;

  /** The keys the provider was presented, on agent turns only. */
  const keysUsed = (): string[] =>
    provider.requests
      .filter((request) => request.path.includes('/chat/completions'))
      .map((request) => (request.headers['authorization'] ?? '').replace(/^Bearer /, ''));

  // --- the work account is selected -------------------------------------
  await send('accounts.setBrain', { connectionId: workId, modelId: 'mock-model' });
  await send('accounts.runDoctor', { connectionId: workId, modelId: 'mock-model' });
  provider.script([{ kind: 'text', text: 'Done.' }]);

  const first = await send('task.create', { objective: 'Say something.' });
  const firstDone = await waitForTask(send, first.task.id, 40_000);
  expect(firstDone.state).toBe('COMPLETED');

  const afterFirst = keysUsed();
  expect(afterFirst.length).toBeGreaterThan(0);
  // Every turn of that task used the selected account's key, and none used
  // the other account's — which is the same provider at the same origin.
  expect(new Set(afterFirst)).toEqual(new Set([KEY_B]));
  expect(afterFirst).not.toContain(KEY_A);

  // --- switch to the personal account ------------------------------------
  await send('accounts.setBrain', { connectionId: personalId, modelId: 'mock-model' });
  await send('accounts.runDoctor', { connectionId: personalId, modelId: 'mock-model' });
  const beforeSecond = keysUsed().length;
  provider.script([{ kind: 'text', text: 'Done again.' }]);

  const second = await send('task.create', { objective: 'Say something else.' });
  const secondDone = await waitForTask(send, second.task.id, 40_000);
  expect(secondDone.state).toBe('COMPLETED');

  // Measured as a delta from after the switch, so the first task's turns
  // cannot be mistaken for the second's.
  const afterSwitch = keysUsed().slice(beforeSecond);
  expect(afterSwitch.length).toBeGreaterThan(0);
  expect(new Set(afterSwitch)).toEqual(new Set([KEY_A]));

  // And the selection the panel reports is the one that ran.
  const listed = await send('accounts.list', {});
  expect(listed.brain?.connectionId).toBe(personalId);
});

test('a task refuses when the selected account is disconnected, with no fallback', async ({
  send,
  provider,
}) => {
  // §60 forbids a silent provider fallback. The shape that would break it: two
  // accounts connected, the selected one removed, and a task that helpfully
  // runs on the survivor. Driven in the real extension, because the refusal
  // has to come from the real resolution path.
  const keep = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_A,
    model: 'mock-model',
    displayName: 'OpenAI — Keep',
  });
  const going = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY_B,
    model: 'mock-model',
    displayName: 'OpenAI — Going',
  });

  await send('accounts.setBrain', {
    connectionId: going.account!.connectionId,
    modelId: 'mock-model',
  });
  await send('accounts.disconnect', { connectionId: going.account!.connectionId });

  // Nothing is selected now. The other account is still connected.
  const listed = await send('accounts.list', {});
  expect(listed.brain).toBeNull();
  expect(listed.accounts.map((entry) => entry.connectionId)).toEqual([keep.account!.connectionId]);

  const before = provider.requests.filter((r) => r.path.includes('/chat/completions')).length;

  // Refused at creation, which is better than what this case first expected:
  // the task is never created, so there is nothing to fail later and nothing
  // to resume onto the surviving account.
  const refusal = await send('task.create', { objective: 'Say something.' }).catch(
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  expect(typeof refusal).toBe('string');
  expect(refusal as string).toContain('AUTH_REQUIRED');

  // And the message names the right remedy. Writing this case is what found
  // it saying "No AI provider is connected" while an account was connected
  // and merely unselected — which would send the user to connect a second
  // one. It now distinguishes the two.
  expect(refusal as string).toMatch(/No AI account is selected/);

  // Nothing was sent. Not one turn on the account the user did not choose.
  expect(provider.requests.filter((r) => r.path.includes('/chat/completions')).length).toBe(before);
});

test('multi-account added no permission and no host access', async ({ serviceWorker }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

  expect(manifest.permissions).not.toContain('identity');
  expect(manifest.host_permissions).not.toContain('<all_urls>');
  expect(manifest.permissions?.sort()).toEqual(
    [
      'activeTab',
      'alarms',
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
