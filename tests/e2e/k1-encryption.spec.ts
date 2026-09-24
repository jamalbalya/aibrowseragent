/**
 * TEST-E2E-030 — K1 against real extension storage.
 *
 * The unit suite proves the construction. What only a browser settles is
 * whether the protection survives the lifecycle it has to survive: the worker
 * being evicted every few minutes, the panel being closed and reopened, and
 * the browser being shut down. An encryption key held in the wrong place
 * passes every unit test and asks the user for a passphrase every four
 * minutes.
 *
 * The case that matters most reads the raw bytes out of `chrome.storage.local`
 * and looks for the API key in them. A round-trip test would pass against a
 * store that never encrypted anything.
 *
 * Everything runs against the shipped `dist/`, with no backend.
 */
import type { Worker } from '@playwright/test';
import { expect, killServiceWorker, openPanel, test } from './fixtures/extension';

const PASSPHRASE = 'a passphrase for the browser test';
const KEY = 'sk-k1-e2e-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Everything the extension has written to disk, as one string. */
async function diskDump(worker: Worker): Promise<string> {
  return await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
}

async function connectAccount(
  send: Parameters<typeof openPanel> extends never ? never : any,
  baseUrl: string,
  apiKey = KEY,
): Promise<string> {
  const result = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl,
    apiKey,
    model: 'mock-model',
  });
  if (!result.account) throw new Error('the account did not connect');
  return result.account.connectionId as string;
}

test('protecting an installation removes the key from what is on disk', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);

  // Before: the key is genuinely there, so the absence below means something.
  expect(await diskDump(serviceWorker)).toContain(KEY);

  const enabled = await send('k1.enable', { passphrase: PASSPHRASE });
  expect(enabled.ok).toBe(true);
  if (!enabled.ok) throw new Error('unreachable');
  expect(enabled.encrypted).toBeGreaterThan(0);

  // After: not in any record, and not as a fragment either.
  const after = await diskDump(serviceWorker);
  expect(after).not.toContain(KEY);
  expect(after).not.toContain(KEY.slice(-8));
  // And the account itself is still listed — protection hid the credential,
  // not the connection.
  expect((await send('accounts.list', {})).accounts.length).toBe(1);
});

test('the unwrapped key is never written to disk', async ({ send, serviceWorker, provider }) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  const sessionValue = await serviceWorker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    return (all['k1-unlocked'] as string | undefined) ?? null;
  });

  // The unwrapped key exists, in session storage, which Chrome holds in
  // memory. The whole at-rest argument is that it is not in the other one.
  expect(typeof sessionValue).toBe('string');
  expect(await diskDump(serviceWorker)).not.toContain(sessionValue as string);
  // Nor is the passphrase anywhere.
  expect(await diskDump(serviceWorker)).not.toContain(PASSPHRASE);
});

test('an unlocked installation survives a real worker termination', async ({
  context,
  extensionId,
  send,
  serviceWorker,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

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
    const result = envelope as { ok: boolean; value?: Record<string, unknown> };
    if (!result.ok) throw new Error(`${type} failed after restart`);
    return result.value ?? {};
  };

  // Still unlocked. An in-memory variable in the worker would have gone with
  // it, and the user would be retyping their passphrase every few minutes.
  expect((await ask('k1.status', {})).state).toBe('UNLOCKED');
  // And the account is still usable, which means the credential decrypted in
  // a worker generation that never saw the passphrase.
  const created = (await ask('task.create', { objective: 'Say hello.' })) as {
    task: { connectionId?: string };
  };
  expect(created.task.connectionId).toBeDefined();
  await panel.close();
});

test('locking makes the credential unreadable until the passphrase comes back', async ({
  send,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  await send('k1.lock', {});
  expect((await send('k1.status', {})).state).toBe('LOCKED');

  // A task cannot run, because the key cannot be read — and the refusal is a
  // refusal rather than a silent "no provider configured".
  await expect(send('task.create', { objective: 'Say hello.' })).rejects.toThrow();

  const unlocked = await send('k1.unlock', { passphrase: PASSPHRASE });
  expect(unlocked.ok).toBe(true);
  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.connectionId).toBeDefined();
});

test('a wrong passphrase is refused and changes nothing', async ({ send, provider }) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });
  await send('k1.lock', {});

  const refused = await send('k1.unlock', { passphrase: 'not the passphrase' });

  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error('unreachable');
  expect(refused.reason).toBe('WRONG_PASSPHRASE');
  expect((await send('k1.status', {})).state).toBe('LOCKED');
  // The right one still works, so a failed attempt did not damage anything.
  expect((await send('k1.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
});

test('a tampered stored record fails closed rather than returning something', async ({
  send,
  serviceWorker,
  provider,
}) => {
  const connectionId = await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  // Flip a byte in the ciphertext, as somebody editing the profile would.
  const edited = await serviceWorker.evaluate(async (id: string) => {
    const all = await chrome.storage.local.get(null);
    const name = Object.keys(all).find((key) => key.includes(`conn:${id}`));
    if (name === undefined) return false;
    const record = all[name] as { ct: string };
    const bytes = atob(record.ct).split('');
    bytes[3] = String.fromCharCode((bytes[3]?.charCodeAt(0) ?? 0) ^ 0xff);
    await chrome.storage.local.set({ [name]: { ...record, ct: btoa(bytes.join('')) } });
    return true;
  }, connectionId);
  expect(edited).toBe(true);

  // The task refuses. What must not happen is the credential reading as
  // absent, which would invite the user to reconnect over a key they still
  // have.
  await expect(send('task.create', { objective: 'Say hello.' })).rejects.toThrow();
  expect((await send('accounts.list', {})).accounts.length).toBe(1);
});

test('losing the key metadata is reported as recovery, never as first-time setup', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.remove('k1-key');
  });

  const status = await send('k1.status', {});
  expect(status.state).toBe('NEEDS_RECOVERY');
  expect(status.state).not.toBe('OFF');
  // And switching on again is refused, rather than minting a key that opens
  // nothing while reporting success.
  const again = await send('k1.enable', { passphrase: 'a completely different passphrase' });
  expect(again.ok).toBe(false);
});

test('switching protection off returns the keys to how they were', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });
  expect(await diskDump(serviceWorker)).not.toContain(KEY);

  const off = await send('k1.disable', { passphrase: PASSPHRASE });

  expect(off.ok).toBe(true);
  expect((await send('k1.status', {})).state).toBe('OFF');
  // Back to plaintext, and back to being usable without a passphrase.
  expect(await diskDump(serviceWorker)).toContain(KEY);
  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.connectionId).toBeDefined();
});

test('switching off needs the passphrase, not just the machine', async ({ send, provider }) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  const refused = await send('k1.disable', { passphrase: 'wrong' });

  // Otherwise the protection is removable by exactly the person it exists to
  // stop: somebody sitting at the unlocked machine.
  expect(refused.ok).toBe(false);
  expect((await send('k1.status', {})).state).toBe('UNLOCKED');
});

test('the export is unchanged by protection, and still carries no secret', async ({
  send,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  const { export: document_ } = await send('data.export', {});
  const serialised = JSON.stringify(document_);

  // K1 does not change the export contract: still a plaintext portable
  // archive with the secrets left out, exactly as before.
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
  expect(serialised).not.toContain(KEY);
  expect(serialised).not.toContain(PASSPHRASE);
  // And no encryption state leaked into it.
  for (const term of ['k1', 'passphrase', 'wrapped', 'salt', 'keyId', 'kid']) {
    expect(serialised.toLowerCase(), term).not.toContain(term.toLowerCase());
  }
});

test('an imported archive cannot switch protection off or unlock it', async ({
  send,
  provider,
}) => {
  await connectAccount(send, provider.baseUrl);
  await send('k1.enable', { passphrase: PASSPHRASE });

  const result = await send('data.import', {
    document: {
      kind: 'aba.local-export',
      formatVersion: 1,
      exportedAt: Date.now(),
      notice: '',
      workflows: [],
      shortcuts: [],
      connections: [],
      // Everything a file might assert about the encryption state.
      settings: { k1: 'OFF', 'k1-state': null, activeProviderId: 'openai-compatible' },
    },
  });

  expect(result.ok).toBe(true);
  // Protection is exactly where it was. Imported data is data; it is not an
  // instruction about this installation's own protection.
  expect((await send('k1.status', {})).state).toBe('UNLOCKED');
  await send('k1.lock', {});
  await send('data.import', {
    document: {
      kind: 'aba.local-export',
      formatVersion: 1,
      exportedAt: Date.now(),
      notice: '',
      workflows: [],
      shortcuts: [],
      connections: [],
      settings: {},
    },
  });
  expect((await send('k1.status', {})).state).toBe('LOCKED');
});

test('protection required no network and no new permission', async ({
  send,
  serviceWorker,
  provider,
  collector,
}) => {
  await connectAccount(send, provider.baseUrl);
  const seenBefore = collector.requests.length;

  await send('k1.enable', { passphrase: PASSPHRASE });
  await send('k1.lock', {});
  await send('k1.unlock', { passphrase: PASSPHRASE });

  // Nothing reached the observing origin: there is no recovery service and no
  // key escrow, and the absence is asserted rather than described.
  expect(collector.requests.length).toBe(seenBefore);

  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toEqual([
    'sidePanel',
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabGroups',
    'scripting',
    'debugger',
    'notifications',
    'activeTab',
    'alarms',
  ]);
  expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
});

test('the panel explains protection without account language or key material', async ({
  panel,
  send,
}) => {
  await panel.reload();
  await panel.waitForSelector('.app');
  await panel.getByRole('button', { name: /settings/i }).click();
  const section = panel.getByTestId('protection-panel');
  await section.waitFor();

  const explainer = await section.getByTestId('protection-explainer').innerText();
  const recovery = await section.getByTestId('protection-no-recovery').innerText();
  const whole = `${explainer}\n${recovery}`.toLowerCase();

  // What is protected, named exactly — not "your data", which would imply the
  // workflows and settings are covered when they are not.
  expect(explainer.toLowerCase()).toContain('ai account keys');
  // The irreversibility, before the field rather than after it.
  expect(recovery.toLowerCase()).toContain('no way to recover');
  expect(whole).toContain('there is no ai browser agent service');

  // No account framing, and no cloud implication.
  for (const forbidden of [
    'sign in',
    'log in',
    'login',
    'account password',
    'cloud',
    'backup to',
    'reset your password',
  ]) {
    expect(whole, forbidden).not.toContain(forbidden);
  }
  // No cryptographic jargon or key material on the normal path.
  for (const forbidden of ['aes', 'pbkdf2', 'salt', 'nonce', 'iteration', 'cipher', 'key id']) {
    expect(whole, forbidden).not.toContain(forbidden);
  }
  // And nothing rendered anywhere in the panel exposes the stored key id.
  const status = await send('k1.status', {});
  expect(status.state).toBe('OFF');
  expect(await panel.innerText('body')).not.toContain('k1-');
});
