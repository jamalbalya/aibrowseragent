/**
 * TEST-E2E-031 — K1 integration and credential regression.
 *
 * K1 put an encryption layer in front of the credential store. This suite is
 * the regression half of that change: it asks whether the layer created a
 * second way to reach a credential, left a stale one usable, or let one
 * escape into something the user or a model can see.
 *
 * The case worth reading first is the leakage one. A provider's 401 body is
 * provider-authored text, it ends up in `technicalDetails`, and that field is
 * **persisted on the task record and read by the panel** — so what a provider
 * chooses to put in an error body becomes something this extension stores.
 * Measured here before it was fixed: a 401 echoing the key produced a stored
 * task carrying the key.
 *
 * Everything runs against the shipped `dist/`, with no backend.
 */
import type { Worker } from '@playwright/test';
import {
  connectProvider,
  expect,
  killServiceWorker,
  openPanel,
  test,
  waitForTask,
} from './fixtures/extension';

const PASSPHRASE = 'a passphrase for the integration suite';
const KEY_A = 'gateway-key-alpha-1111111111';
const KEY_B = 'gateway-key-bravo-2222222222';

async function diskDump(worker: Worker): Promise<string> {
  return await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
}

type Send = any;

async function connect(send: Send, baseUrl: string, apiKey: string): Promise<string> {
  const result = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl,
    apiKey,
    model: 'mock-model',
  });
  if (!result.account) throw new Error(`connect failed: ${result.error?.userMessage ?? '?'}`);
  return result.account.connectionId as string;
}

/**
 * Connects and runs the capability check, which is what the Settings flow
 * does and what execution requires.
 *
 * Without the check the account has no measured capability, and the runtime
 * refuses to drive a browser with a model that has not shown it can call
 * tools — correctly. A test that skipped it saw `BLOCKED` and no provider
 * request, which looks like a credential problem and is not one.
 */
async function connectAndVerify(send: Send, baseUrl: string, apiKey: string): Promise<string> {
  const connectionId = await connect(send, baseUrl, apiKey);
  await send('accounts.runDoctor', { connectionId, modelId: 'mock-model' });
  await send('accounts.setBrain', { connectionId, modelId: 'mock-model' });
  return connectionId;
}

/* ------------------------------------------------------------------ *
 * Part 3 — provider execution
 * ------------------------------------------------------------------ */

test('execution uses the credential of the connection it is bound to', async ({
  send,
  provider,
  serviceWorker,
}) => {
  const first = await connectAndVerify(send, provider.baseUrl, KEY_A);
  const second = await connectAndVerify(send, provider.baseUrl, KEY_B);

  const before = provider.requests.length;
  const created = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, created.task.id, 40_000);

  // The task is bound to the selected connection, and the request carried
  // that connection's key — not the other account's, which is the property
  // keying credentials by connection rather than by provider exists for.
  expect(created.task.connectionId).toBe(second);
  const sent = provider.requests.slice(before);
  expect(sent.length).toBeGreaterThan(0);
  const auth = sent.map((request) => request.headers['authorization'] ?? '').join('|');
  expect(auth).toContain(KEY_B);
  expect(auth).not.toContain(KEY_A);

  // And both credentials are still stored separately, under their own ids.
  expect(first).not.toBe(second);
  const dump = await diskDump(serviceWorker);
  expect(dump).toContain(KEY_A);
  expect(dump).toContain(KEY_B);
});

test('switching the brain switches the credential, with nothing stale left', async ({
  send,
  provider,
}) => {
  const first = await connectAndVerify(send, provider.baseUrl, KEY_A);
  await connectAndVerify(send, provider.baseUrl, KEY_B);

  await send('accounts.setBrain', { connectionId: first, modelId: 'mock-model' });

  const before = provider.requests.length;
  const created = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, created.task.id, 40_000);

  expect(created.task.connectionId).toBe(first);
  const auth = provider.requests
    .slice(before)
    .map((request) => request.headers['authorization'] ?? '')
    .join('|');
  expect(auth).toContain(KEY_A);
  expect(auth).not.toContain(KEY_B);
});

test('a capability measurement stays bound to its connection and model', async ({
  send,
  provider,
}) => {
  const first = await connect(send, provider.baseUrl, KEY_A);
  const second = await connect(send, provider.baseUrl, KEY_B);

  await send('accounts.runDoctor', { connectionId: first, modelId: 'mock-model' });

  const listed = await send('accounts.list', {});
  const measured = listed.accounts.find(
    (account: { connectionId: string }) => account.connectionId === first,
  );
  const other = listed.accounts.find(
    (account: { connectionId: string }) => account.connectionId === second,
  );

  // A measurement on one account says nothing about the other. Sharing it
  // would let an unverified endpoint inherit a capability it never showed.
  expect(measured?.capabilities).not.toBeNull();
  expect(other?.capabilities).toBeNull();
});

/* ------------------------------------------------------------------ *
 * Part 5 — lock and unlock
 * ------------------------------------------------------------------ */

test('a plaintext legacy key is not reached for while locked', async ({
  send,
  serviceWorker,
  provider,
}) => {
  // The scenario this is really about: a `apiKey:<providerId>` record in
  // plaintext, present at a moment when the protected credential cannot be
  // read. Written *after* protection was switched on, so the conversion never
  // touched it — which is the only way a genuinely plaintext credential and a
  // locked installation coexist.
  // The pre-account path only, so no AI brain exists and `resolveProvider`
  // really does fall through to the legacy branch. With a brain present the
  // legacy record is never consulted, and a test that left one there would
  // pass without exercising the thing it names.
  await connectProvider(send, provider);
  await send('k1.enable', { passphrase: PASSPHRASE });

  await serviceWorker.evaluate(async (key: string) => {
    await chrome.storage.local.set({ 'credentials:apiKey:openai-compatible': key });
  }, KEY_B);

  await send('k1.lock', {});

  const before = provider.requests.length;
  await expect(send('task.create', { objective: 'Say hello.' })).rejects.toThrow();

  // The assertion that carries this test. "The task failed" stays true
  // whatever went wrong; what must be true is that **no request went out
  // carrying the plaintext key** — a locked installation reaching for an
  // unencrypted credential would look exactly like a working one.
  const auth = provider.requests
    .slice(before)
    .map((request) => JSON.stringify(request.headers))
    .join('|');
  expect(auth).not.toContain(KEY_B);
  expect(auth).not.toContain(KEY_A);
  expect(auth).not.toContain('test-key-abcdefghijklmnop');

  // And unlocking restores normal service, so the refusal was the lock rather
  // than something broken.
  expect((await send('k1.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.id.length).toBeGreaterThan(0);
});

test('the panel receives no credential while locked, only a state', async ({ send, provider }) => {
  const connectionId = await connect(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });
  await send('k1.lock', {});

  // Everything the panel can still ask for while locked.
  const listed = await send('accounts.list', {});
  const status = await send('k1.status', {});
  const connection = await send('provider.getConnection', {});
  const health = await send('health.get', {});

  const everything = JSON.stringify({ listed, status, connection, health });
  expect(everything).not.toContain(KEY_A);
  expect(everything).not.toContain(PASSPHRASE);
  // It can still say *which* account needs unlocking, which is the reason
  // connection metadata is deliberately not encrypted.
  expect(listed.accounts.map((a: { connectionId: string }) => a.connectionId)).toContain(
    connectionId,
  );
  expect(status.state).toBe('LOCKED');
});

test('a worker restart keeps the session key; the records stay unreadable when locked', async ({
  context,
  extensionId,
  send,
  serviceWorker,
  provider,
}) => {
  const connectionId = await connectAndVerify(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });
  await send('k1.lock', {});

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const ask = async (type: string, payload: unknown): Promise<Record<string, unknown>> => {
    const envelope = await panel.evaluate(
      ([messageType, messagePayload]) =>
        chrome.runtime.sendMessage({
          id: `e2e_${Math.random().toString(36).slice(2)}`,
          type: messageType,
          timestamp: Date.now(),
          payload: messagePayload,
        }),
      [type, payload] as const,
    );
    return envelope as Record<string, unknown>;
  };

  // A worker restart does not unlock anything: locked stays locked, and the
  // credential stays unreadable until the passphrase comes back.
  const status = (await ask('k1.status', {})) as { value?: { state?: string } };
  expect(status.value?.state).toBe('LOCKED');
  const created = (await ask('task.create', { objective: 'Say hello.' })) as { ok: boolean };
  expect(created.ok).toBe(false);

  const unlocked = (await ask('k1.unlock', { passphrase: PASSPHRASE })) as {
    value?: { ok?: boolean };
  };
  expect(unlocked.value?.ok).toBe(true);
  const after = (await ask('task.create', { objective: 'Say hello.' })) as {
    ok: boolean;
    value?: { task?: { connectionId?: string } };
  };
  expect(after.value?.task?.connectionId).toBe(connectionId);
  await panel.close();
});

/* ------------------------------------------------------------------ *
 * Part 6 — legacy migration and K1
 * ------------------------------------------------------------------ */

test('a legacy credential is migrated, protected, and not left behind', async ({
  context,
  extensionId,
  serviceWorker,
  provider,
}) => {
  // The pre-account scheme, written exactly as the old build wrote it.
  await serviceWorker.evaluate(
    async ([key, url]: readonly [string, string]) => {
      await chrome.storage.local.set({
        'credentials:apiKey:openai-compatible': key,
        'credentials:config:openai-compatible': { providerId: 'openai-compatible', baseUrl: url },
        'settings:provider-connection': {
          providerId: 'openai-compatible',
          modelId: 'mock-model',
          authKind: 'api_key',
          createdAt: Date.now(),
          status: 'connected',
        },
      });
      // Clear the marker so the next worker generation migrates.
      await chrome.storage.local.remove('accounts:legacy-migration');
    },
    [KEY_A, provider.baseUrl] as const,
  );

  // A fresh worker generation runs the migration at module scope. Killing the
  // worker is how that happens; `chrome.runtime.reload()` unloads an
  // extension loaded with `--load-extension` permanently.
  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);
  const restarted = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const ask = async (type: string, payload: unknown): Promise<Record<string, unknown>> => {
    const envelope = await panel.evaluate(
      ([messageType, messagePayload]) =>
        chrome.runtime.sendMessage({
          id: `e2e_${Math.random().toString(36).slice(2)}`,
          type: messageType,
          timestamp: Date.now(),
          payload: messagePayload,
        }),
      [type, payload] as const,
    );
    const result = envelope as { ok: boolean; value?: Record<string, unknown> };
    if (!result.ok) throw new Error(`${type} failed after restart`);
    return result.value ?? {};
  };

  const listed = (await ask('accounts.list', {})) as {
    accounts: readonly { providerId: string }[];
  };
  const migrated = listed.accounts.find(
    (account: { providerId: string }) => account.providerId === 'openai-compatible',
  );
  expect(migrated).toBeDefined();

  const dump = await diskDump(restarted);
  // The legacy key is gone from its old home — one credential, not two.
  expect(dump).not.toContain('"credentials:apiKey:openai-compatible"');
  // It is present exactly once, under the connection scheme.
  expect(dump.split(KEY_A).length - 1).toBe(1);

  // And protecting the installation encrypts the migrated credential.
  await ask('k1.enable', { passphrase: PASSPHRASE });
  expect(await diskDump(restarted)).not.toContain(KEY_A);
  await panel.close();
});

/* ------------------------------------------------------------------ *
 * Part 7 — export and import, in all three K1 states
 * ------------------------------------------------------------------ */

for (const state of ['disabled', 'unlocked', 'locked'] as const) {
  test(`the export carries no secret with K1 ${state}`, async ({ send, provider }) => {
    await connect(send, provider.baseUrl, KEY_A);
    if (state !== 'disabled') await send('k1.enable', { passphrase: PASSPHRASE });
    if (state === 'locked') await send('k1.lock', {});

    const { export: document_ } = await send('data.export', {});
    const serialised = JSON.stringify(document_);

    // Identical contract in all three states. K1 changes what is on disk, not
    // what a portable file contains.
    expect(Object.keys(document_).sort()).toEqual([
      'connections',
      'exportedAt',
      'formatVersion',
      'kind',
      'notice',
      'settings',
      'shortcuts',
      'workflows',
    ]);
    for (const forbidden of [
      KEY_A,
      KEY_A.slice(-8),
      PASSPHRASE,
      'accountLabel',
      'abaUserId',
      'installationId',
      'permissionMode',
      'allowInsecureOrigins',
      'taintState',
      'wrapped',
      'k1-key',
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });
}

test('an import creates no credential and selects no brain', async ({ send, provider }) => {
  // Two real accounts, with the first selected. The archive then names the
  // **second**, which genuinely exists — so an import that tried to select a
  // brain would succeed rather than being turned away by `setBrain`'s own
  // guard against unknown connections. A first version of this named a
  // made-up id, and passed even with brain selection wired in, because the
  // store refused it for an unrelated reason.
  const first = await connectAndVerify(send, provider.baseUrl, KEY_A);
  const second = await connectAndVerify(send, provider.baseUrl, KEY_B);
  await send('accounts.setBrain', { connectionId: first, modelId: 'mock-model' });
  await send('k1.enable', { passphrase: PASSPHRASE });

  const result = await send('data.import', {
    document: {
      kind: 'aba.local-export',
      formatVersion: 1,
      exportedAt: Date.now(),
      notice: '',
      workflows: [],
      shortcuts: [],
      connections: [
        {
          connectionId: second,
          providerId: 'openai-compatible',
          displayName: 'Imported',
          modelId: 'mock-model',
          baseUrl: 'https://attacker.example/v1',
        },
      ],
      settings: {},
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  // Counted for the user to re-key, and written nowhere.
  expect(result.outcome.connectionsNeedingKeys).toBe(1);

  const after = await send('accounts.list', {});
  expect(after.accounts.length).toBe(2);
  // The selection is still the user's, not the file's.
  expect(after.brain?.connectionId).toBe(first);
  // No account was created for the named connection beyond the two that
  // already existed, and the encryption state is where it was.
  expect((await send('k1.status', {})).state).toBe('UNLOCKED');
});

/* ------------------------------------------------------------------ *
 * Part 8 — leakage under induced failure
 * ------------------------------------------------------------------ */

test('a provider error echoing the key does not put it in the stored task', async ({
  send,
  provider,
}) => {
  await connectProvider(send, provider);
  // A provider that hands the key back in its error body. Real ones do:
  // OpenAI's 401 reads "Incorrect API key provided: sk-…", and a self-hosted
  // gateway may echo it in full. The fixture's key is deliberately one no
  // shape rule recognises, so this measures the exact-match removal rather
  // than the pattern list.
  provider.script([
    {
      kind: 'http_error',
      status: 401,
      body: JSON.stringify({
        error: { message: `Incorrect API key provided: test-key-abcdefghijklmnop. Check it.` },
      }),
    },
  ]);

  const { task } = await send('task.create', { objective: 'Do something.' });
  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.state).toBe('FAILED');
  // The failure is still reported usefully — this is not a fix by silence.
  expect(finished.error?.code).toBe('AUTH_EXPIRED');
  expect(finished.error?.userMessage).toMatch(/API key|rejected/i);
  // And the key is not in the record, which is persisted and read by the panel.
  expect(JSON.stringify(finished)).not.toContain('test-key-abcdefghijklmnop');
  expect(finished.error?.technicalDetails ?? '').toContain('REDACTED');
});

test('induced failures leak nothing into logs, audit or messages', async ({ send, provider }) => {
  const connectionId = await connect(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });

  // Wrong passphrase.
  const wrong = await send('k1.unlock', { passphrase: 'not the passphrase' });
  expect(JSON.stringify(wrong)).not.toContain(PASSPHRASE);

  // A provider failure on a protected installation.
  provider.script([{ kind: 'http_error', status: 500, body: `{"key":"${KEY_A}"}` }]);
  const { task } = await send('task.create', { objective: 'Do something.' });
  await waitForTask(send, task.id, 45_000).catch(() => undefined);

  const { logs } = await send('debug.getLogs', {});
  const audit = await send('audit.list', {});
  const tasks = await send('task.list', {});
  const everything = JSON.stringify({ logs, audit, tasks });

  for (const secret of [KEY_A, PASSPHRASE, KEY_A.slice(-8)]) {
    expect(everything, secret).not.toContain(secret);
  }
  expect(connectionId.length).toBeGreaterThan(0);
});

/* ------------------------------------------------------------------ *
 * Part 9 — persistence failure
 * ------------------------------------------------------------------ */

test('an undecryptable credential is a failure, not an absent one', async ({
  send,
  serviceWorker,
  provider,
}) => {
  const connectionId = await connect(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });

  // Corrupt the stored ciphertext, as a bad disk or an editor would.
  await serviceWorker.evaluate(async (id: string) => {
    const all = await chrome.storage.local.get(null);
    const name = Object.keys(all).find((key) => key.includes(`conn:${id}`));
    if (name === undefined) return;
    const record = all[name] as { ct: string };
    await chrome.storage.local.set({ [name]: { ...record, ct: btoa('not the ciphertext') } });
  }, connectionId);

  // The task refuses rather than reporting no provider — which would invite
  // the user to reconnect over a key they may still be able to recover.
  await expect(send('task.create', { objective: 'Say hello.' })).rejects.toThrow();
  // The account is still listed, so the user can see what is broken.
  expect((await send('accounts.list', {})).accounts.length).toBe(1);
  // And no replacement credential was generated.
  const dump = await diskDump(serviceWorker);
  expect(dump).not.toContain(KEY_A);
});
