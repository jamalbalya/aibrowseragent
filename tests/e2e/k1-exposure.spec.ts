/**
 * TEST-E2E-032 — what a reader of the Chrome profile actually sees.
 *
 * The K1 threat model names one attacker: somebody who can read
 * `chrome.storage.local` but cannot execute extension JavaScript. This suite
 * plays that attacker. It exercises the product until every durable store has
 * something in it, then dumps the profile and asks two questions:
 *
 *   1. Is any secret in there? (Must be no.)
 *   2. What *is* in there? (Recorded, because a limitation nobody writes down
 *      becomes a claim nobody checked.)
 *
 * The second question is the one that makes this more than a repeat of the
 * encryption tests: it is an inventory of what remains visible **by design**,
 * asserted so that a future change which starts writing something new into a
 * plaintext store has to come here and say so.
 */
import type { Worker } from '@playwright/test';
import { connectProvider, expect, test, waitForTask } from './fixtures/extension';

const PASSPHRASE = 'a passphrase for the exposure audit';
const KEY_A = 'gateway-key-alpha-1111111111';
const KEY_B = 'gateway-key-bravo-2222222222';

type Send = any;

async function profile(worker: Worker): Promise<Record<string, unknown>> {
  return await worker.evaluate(
    async () =>
      JSON.parse(JSON.stringify(await chrome.storage.local.get(null))) as Record<string, unknown>,
  );
}

async function connectAndVerify(send: Send, baseUrl: string, apiKey: string): Promise<string> {
  const result = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl,
    apiKey,
    model: 'mock-model',
  });
  if (!result.account) throw new Error('the account did not connect');
  const connectionId = result.account.connectionId as string;
  await send('accounts.runDoctor', { connectionId, modelId: 'mock-model' });
  await send('accounts.setBrain', { connectionId, modelId: 'mock-model' });
  return connectionId;
}

/** Puts something in every durable store this build has. */
async function populate(send: Send, baseUrl: string): Promise<void> {
  await connectAndVerify(send, baseUrl, KEY_A);
  await connectAndVerify(send, baseUrl, KEY_B);
  await send('workspace.create', { title: 'Reading' });
  await send('session.setPermissionMode', { mode: 'manual' });
  await send('data.import', {
    document: {
      kind: 'aba.local-export',
      formatVersion: 1,
      exportedAt: Date.now(),
      notice: '',
      workflows: [],
      shortcuts: [
        { displayName: 'Populated', target: { kind: 'workflow', workflowId: 'wf_placeholder' } },
      ],
      connections: [],
      settings: {},
    },
  });
  const created = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, created.task.id, 40_000).catch(() => undefined);
}

test('a reader of the profile finds no secret once protection is on', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await populate(send, provider.baseUrl);
  await connectProvider(send, provider); // also leaves a pre-account credential

  // Before: the keys really are on disk, so the absence below means something.
  const before = JSON.stringify(await profile(serviceWorker));
  expect(before).toContain(KEY_A);
  expect(before).toContain(KEY_B);

  await send('k1.enable', { passphrase: PASSPHRASE });

  const after = JSON.stringify(await profile(serviceWorker));
  for (const secret of [
    KEY_A,
    KEY_B,
    KEY_A.slice(-10),
    KEY_B.slice(-10),
    'test-key-abcdefghijklmnop',
    PASSPHRASE,
  ]) {
    expect(after, secret).not.toContain(secret);
  }
});

test('the plaintext inventory is exactly what the threat model says it is', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await populate(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  const dump = await profile(serviceWorker);
  const namespaces = [...new Set(Object.keys(dump).map((key) => key.split(':')[0] ?? key))].sort();

  // Every durable namespace this build is *allowed* to write. Asserted as a
  // ceiling rather than an exact list: which stores have anything in them
  // depends on what a run happens to exercise — no policy rule was set here,
  // and health only writes on a degradation — but a namespace appearing that
  // is **not** on this list is a new place data lives, and whoever added it
  // has to come here and decide, in `K1_PROTECTION`, whether it holds a
  // secret.
  const DECLARED_NAMESPACES = [
    'accounts',
    'active-session',
    'audit',
    'connector-writes',
    'credentials',
    'evidence',
    'health',
    'identity-local',
    'identity-profile',
    'identity-session',
    'k1-key',
    'k1-state',
    'policy',
    'settings',
    'shortcuts',
    'skill-runs',
    'tasks',
    'workflows',
    'workspaces',
  ];
  for (const namespace of namespaces) {
    expect(DECLARED_NAMESPACES, `undeclared durable namespace: ${namespace}`).toContain(namespace);
  }
  // And the ones this run definitely populated, so the sweep is not vacuous.
  for (const namespace of ['accounts', 'credentials', 'identity-local', 'settings', 'tasks']) {
    expect(namespaces, namespace).toContain(namespace);
  }

  // What the attacker legitimately learns, recorded rather than implied.
  const credentials = Object.entries(dump).filter(([key]) => key.startsWith('credentials:'));
  expect(credentials.length).toBeGreaterThan(0);
  for (const [, value] of credentials) {
    // Ciphertext only: an envelope, never a string.
    expect(typeof value).toBe('object');
    expect(value).toHaveProperty('ct');
    expect(value).toHaveProperty('iv');
  }
  // …but the record names are readable, so the attacker knows how many
  // connections exist and their ids. Stated in the threat model, and asserted
  // here so it cannot quietly become a confidentiality claim.
  expect(credentials.map(([key]) => key).join('|')).toContain('conn:');

  // The account records say what you connected to and never how you
  // authenticate — which is what lets the panel name the account that needs
  // unlocking while locked.
  const accounts = JSON.stringify(dump['accounts:accounts']);
  expect(accounts).toContain('openai-compatible');
  expect(accounts).not.toContain(KEY_A);
  expect(accounts).not.toContain(KEY_B);

  // The installation identity is plaintext by design: the unlock screen has
  // to render before anything is unlocked.
  expect(JSON.stringify(dump['identity-local:installation'])).toMatch(/loc_[0-9a-f]{32}/);

  // And the key record holds a salt and a wrapped key — neither of which
  // helps without the passphrase, and neither of which is the passphrase.
  const keyRecord = JSON.stringify(dump['k1-key']);
  expect(keyRecord).toContain('salt');
  expect(keyRecord).toContain('wrapped');
  expect(keyRecord).not.toContain(PASSPHRASE);
});

test('a credential appearing twice, nested, or beside another is still removed', async ({
  send,
  provider,
}) => {
  // The transformed-credential cases worth having: cheap, deterministic, and
  // each a shape a real provider error genuinely takes. Not a DLP engine —
  // exact-match removal handles every one of these because the credential is
  // threaded down to the reader.
  await connectProvider(send, provider);
  const key = 'test-key-abcdefghijklmnop';
  provider.script([
    {
      kind: 'http_error',
      status: 401,
      body: JSON.stringify({
        error: {
          // Twice, which is how a message plus a hint reads.
          message: `Incorrect API key provided: ${key}. The key ${key} is not active.`,
          // Nested, which is how a structured error reads.
          meta: { provided: { key }, docs: `https://example.test/keys?k=${key}` },
        },
      }),
    },
  ]);

  const { task } = await send('task.create', { objective: 'Do something.' });
  const finished = await waitForTask(send, task.id, 40_000);

  expect(finished.state).toBe('FAILED');
  const serialised = JSON.stringify(finished);
  expect(serialised).not.toContain(key);
  // Every occurrence, not just the first.
  expect(finished.error?.technicalDetails ?? '').toContain('REDACTED');
  expect((finished.error?.technicalDetails ?? '').split('REDACTED').length - 1).toBeGreaterThan(1);
  // And the failure is still legible.
  expect(finished.error?.code).toBe('AUTH_EXPIRED');
});

test('changing the passphrase keeps the data and retires the old one', async ({
  send,
  serviceWorker,
  provider,
}) => {
  const connectionId = await connectAndVerify(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });
  const ciphertextBefore = JSON.stringify(
    Object.entries(await profile(serviceWorker)).filter(([key]) => key.includes('conn:')),
  );

  const changed = await send('k1.changePassphrase', {
    current: PASSPHRASE,
    next: 'a different passphrase entirely',
  });
  expect(changed.ok).toBe(true);

  await send('k1.lock', {});
  const old = await send('k1.unlock', { passphrase: PASSPHRASE });
  expect(old.ok).toBe(false);
  const fresh = await send('k1.unlock', { passphrase: 'a different passphrase entirely' });
  expect(fresh.ok).toBe(true);

  // The records were not re-encrypted, so an interruption during the change
  // could not have left them under a key nobody holds.
  const after = JSON.stringify(
    Object.entries(await profile(serviceWorker)).filter(([key]) => key.includes('conn:')),
  );
  expect(after).toBe(ciphertextBefore);
  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.connectionId).toBe(connectionId);
});

test('locking drops the key the connected adapter was holding', async ({ send, provider }) => {
  await connectAndVerify(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });

  // Unlocked, the adapter is connected and a request carries the key.
  const before = provider.requests.length;
  const first = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, first.task.id, 40_000);
  expect(
    provider.requests
      .slice(before)
      .map((request) => request.headers['authorization'] ?? '')
      .join('|'),
  ).toContain(KEY_A);

  const afterRun = provider.requests.length;
  await send('k1.lock', {});

  // Locked, nothing runs — and no request is made with the copy the adapter
  // was holding, which is the observable half of dropping that reference.
  await expect(send('task.create', { objective: 'Say hello.' })).rejects.toThrow();
  expect(provider.requests.length).toBe(afterRun);

  // And unlocking reconnects from storage rather than relying on what was
  // left in memory, so the drop did not break the normal path.
  expect((await send('k1.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
  const again = await send('task.create', { objective: 'Say hello.' });
  await waitForTask(send, again.task.id, 40_000);
  expect(
    provider.requests
      .slice(afterRun)
      .map((request) => request.headers['authorization'] ?? '')
      .join('|'),
  ).toContain(KEY_A);
});

test('a corrupted session key locks rather than half-working', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await connectAndVerify(send, provider.baseUrl, KEY_A);
  await send('k1.enable', { passphrase: PASSPHRASE });

  // The session key, damaged in place — what a partial write or an evicted
  // entry would look like.
  await serviceWorker.evaluate(async () => {
    await chrome.storage.session.set({ 'k1-unlocked': 'not-a-key' });
  });

  expect((await send('k1.status', {})).state).toBe('LOCKED');
  await expect(send('task.create', { objective: 'Say hello.' })).rejects.toThrow();
  // No replacement key was generated, and the passphrase still works.
  expect((await send('k1.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
});

test('disabling refuses while a protected record cannot be read', async ({
  send,
  serviceWorker,
  provider,
}) => {
  const connectionId = await connectAndVerify(send, provider.baseUrl, KEY_A);
  await connectAndVerify(send, provider.baseUrl, KEY_B);
  await send('k1.enable', { passphrase: PASSPHRASE });

  await serviceWorker.evaluate(async (id: string) => {
    const all = await chrome.storage.local.get(null);
    const name = Object.keys(all).find((key) => key.includes(`conn:${id}`));
    if (name === undefined) return;
    const record = all[name] as { ct: string };
    await chrome.storage.local.set({ [name]: { ...record, ct: btoa('not the ciphertext') } });
  }, connectionId);

  const refused = await send('k1.disable', { passphrase: PASSPHRASE });

  // Switching off writes every protected record back as plaintext. Doing that
  // for the readable half and dropping the rest would destroy a credential
  // while reporting success, so it refuses as a whole.
  expect(refused.ok).toBe(false);
  expect((await send('k1.status', {})).state).toBe('UNLOCKED');
  // And nothing was written back in plaintext on the way to refusing.
  expect(JSON.stringify(await profile(serviceWorker))).not.toContain(KEY_B);
});
