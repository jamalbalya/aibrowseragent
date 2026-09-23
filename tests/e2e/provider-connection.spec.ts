/**
 * TEST-E2E-029 — the connected account a user actually gets.
 *
 * Two records describe "the AI connection this installation uses". The
 * account store decides what runs; `settings.provider-connection` is what the
 * panel renders. They were written by different routes, and the shipped
 * Settings form wrote one of each — so the defect these cases exist for was
 * not a leak or a race but something much plainer: **connect an account
 * through Settings, pass the capability check, start a task, and be told to
 * enter a base URL.** The account was connected, its key was stored, and
 * nothing would use it.
 *
 * Only a real browser settles this. The stores agree in a unit test because a
 * unit test writes both; what had to be measured is what the *shipped panel's
 * own sequence of routes* leaves behind, and whether it survives the worker
 * being killed.
 *
 * Everything runs against `dist/`, with no backend.
 */
import type { Worker } from '@playwright/test';
import { expect, killServiceWorker, openPanel, test, waitForTask } from './fixtures/extension';

const KEY = 'sk-conn-e2e-aaaaaaaaaaaaaaaaaaaaaaaa';

/** Exactly the route sequence `SettingsView.tsx` runs, in order. */
async function connectThroughSettings(
  send: Parameters<typeof waitForTask>[0],
  baseUrl: string,
  apiKey = KEY,
): Promise<string> {
  const result = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl,
    apiKey,
    model: 'mock-model',
  });
  if (result.error || !result.account) {
    throw new Error(`connect failed: ${result.error?.userMessage ?? 'no account'}`);
  }
  const connectionId = result.account.connectionId;
  const { report } = await send('accounts.runDoctor', { connectionId, modelId: 'mock-model' });
  if (report.readiness === 'AGENT_READY') {
    await send('accounts.setBrain', { connectionId, modelId: 'mock-model' });
  }
  return connectionId;
}

/** Everything the extension has written to disk, as the worker sees it. */
async function storage(worker: Worker): Promise<Record<string, unknown>> {
  return await worker.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return JSON.parse(JSON.stringify(all)) as Record<string, unknown>;
  });
}

test('connecting an account through Settings leaves something that can run a task', async ({
  send,
  provider,
}) => {
  const connectionId = await connectThroughSettings(send, provider.baseUrl);

  // The account exists and is the one in use, both of which the panel reads.
  const listed = await send('accounts.list', {});
  expect(listed.accounts.map((account) => account.connectionId)).toContain(connectionId);
  expect(listed.brain?.connectionId).toBe(connectionId);

  // The claim this file exists for: a task actually starts. Before the
  // correction this threw AUTH_REQUIRED — "Enter the endpoint base URL" —
  // immediately after a capability check that had just reported AGENT_READY.
  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.connectionId).toBe(connectionId);
  const finished = await waitForTask(send, created.task.id);
  expect(finished.state).not.toBe('FAILED');
});

test('an account connected but never checked is still the one a task uses', async ({
  send,
  provider,
}) => {
  // Connect and stop. The capability check is a separate button and running
  // it is a separate decision, so this is an ordinary thing for somebody to
  // do — and until the account became the brain on connect, it left the
  // installation with a stored key, a stored account, and a next task that
  // failed with "Enter the endpoint base URL" because nothing pointed at it.
  const result = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: KEY,
    model: 'mock-model',
  });
  expect(result.account).not.toBeNull();
  const connectionId = result.account?.connectionId ?? '';

  expect((await send('accounts.list', {})).brain?.connectionId).toBe(connectionId);

  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.connectionId).toBe(connectionId);
  const finished = await waitForTask(send, created.task.id);
  expect(finished.state).not.toBe('FAILED');
});

test('the panel record is a projection of the account, not a second decision', async ({
  send,
  provider,
}) => {
  const connectionId = await connectThroughSettings(send, provider.baseUrl);

  const { connection } = await send('provider.getConnection', {});
  expect(connection).not.toBeNull();
  // It names the account it came from. That field is what stops the one-time
  // migration reading a projection as a pre-account record to migrate.
  expect(connection?.connectionId).toBe(connectionId);
  expect(connection?.providerId).toBe('openai-compatible');
  expect(connection?.modelId).toBe('mock-model');
  // The measurement reached it, so the composer's readiness gate opens.
  expect(connection?.capabilities?.toolCalling).toBe(true);

  // And the settings record names the same pair, so the exported
  // `activeProviderId` describes the account actually in use.
  const { export: document_ } = await send('data.export', {});
  expect(document_.settings['activeProviderId']).toBe('openai-compatible');
  expect(document_.settings['activeModelId']).toBe('mock-model');
});

test('the connection survives a real worker termination', async ({
  context,
  extensionId,
  send,
  serviceWorker,
  provider,
}) => {
  const connectionId = await connectThroughSettings(send, provider.baseUrl);

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);
  const restarted = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
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

  // The brain, the account and the projection all come back. A worker restart
  // is the moment an in-memory adapter's credential would have papered over a
  // record that was never written.
  const listed = (await ask('accounts.list', {})) as {
    brain: { connectionId: string } | null;
    accounts: readonly unknown[];
  };
  expect(listed.brain?.connectionId).toBe(connectionId);
  expect(listed.accounts.length).toBe(1);

  const created = (await ask('task.create', { objective: 'Say hello again.' })) as {
    task: { connectionId?: string };
  };
  expect(created.task.connectionId).toBe(connectionId);

  // The migration did not run again and take the projection with it.
  expect(await storage(restarted)).toHaveProperty('settings:provider-connection');
  await panel.close();
});

test('a second account is added without moving the user off the first', async ({
  send,
  provider,
}) => {
  const first = await connectThroughSettings(send, provider.baseUrl);

  const second = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'sk-conn-e2e-bbbbbbbbbbbbbbbbbbbbbbbb',
    model: 'mock-model',
  });
  expect(second.account).not.toBeNull();
  expect(second.account?.connectionId).not.toBe(first);

  // Two accounts, same provider, each with its own connection id — the thing
  // the pre-account credential scheme could not represent, because it keyed
  // the key by provider.
  const listed = await send('accounts.list', {});
  expect(listed.accounts.length).toBe(2);
  // The brain did not move. Connecting is not choosing.
  expect(listed.brain?.connectionId).toBe(first);
});

test('two connected accounts cannot make the stores disagree', async ({ send, provider }) => {
  const first = await connectThroughSettings(send, provider.baseUrl);
  const secondId = await connectThroughSettings(send, provider.baseUrl, 'sk-conn-e2e-cccccccccccc');

  // The second `connectThroughSettings` ran the check and selected, so it is
  // now the brain — and the projection followed it rather than describing the
  // account it replaced.
  expect(secondId).not.toBe(first);
  const listed = await send('accounts.list', {});
  expect(listed.brain?.connectionId).toBe(secondId);
  const { connection } = await send('provider.getConnection', {});
  expect(connection?.connectionId).toBe(secondId);

  const created = await send('task.create', { objective: 'Say hello.' });
  expect(created.task.connectionId).toBe(secondId);
});

test('disconnecting the account in use clears what the panel shows', async ({ send, provider }) => {
  const connectionId = await connectThroughSettings(send, provider.baseUrl);

  await send('accounts.disconnect', { connectionId });

  // No account, no brain, and — the part that used to be missed — no stale
  // projection claiming a connection whose credential has just been deleted.
  expect((await send('accounts.list', {})).accounts.length).toBe(0);
  expect((await send('provider.getConnection', {})).connection).toBeNull();
  const { export: document_ } = await send('data.export', {});
  expect(document_.connections.length).toBe(0);
  expect(document_.settings['activeProviderId']).toBeNull();
});

test('the account key is on disk, and nowhere an export can reach', async ({ send, provider }) => {
  const connectionId = await connectThroughSettings(send, provider.baseUrl);

  const { export: document_ } = await send('data.export', {});
  const serialised = JSON.stringify(document_);

  // Genuinely stored — otherwise the absence below proves nothing.
  const stored = await send('accounts.list', {});
  expect(stored.accounts.length).toBe(1);

  expect(serialised).not.toContain(KEY);
  expect(serialised).not.toContain(KEY.slice(-4));
  expect(serialised).not.toContain('accountLabel');
  // The connection itself is represented, by the five metadata fields.
  expect(document_.connections).toHaveLength(1);
  expect(document_.connections[0]?.connectionId).toBe(connectionId);
  expect(Object.keys(document_.connections[0] ?? {}).sort()).toEqual([
    'baseUrl',
    'connectionId',
    'displayName',
    'modelId',
    'providerId',
  ]);
});

test('the provider credential never leaves the credential namespace', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await connectThroughSettings(send, provider.baseUrl);

  const all = await storage(serviceWorker);
  const holders = Object.entries(all)
    .filter(([, value]) => JSON.stringify(value).includes(KEY))
    .map(([key]) => key);

  // Exactly one place holds it, and it is the credential store keyed by
  // connection. A projection, an account record or a session carrying it
  // would each be a copy nobody would think to delete.
  expect(holders).toHaveLength(1);
  expect(holders[0]).toMatch(/^credentials:conn:/);
});

test('importing an archive creates no account and no authorization', async ({ send }) => {
  const before = await send('accounts.list', {});

  // Everything a file might assert about connections and about being in use.
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
          connectionId: 'smuggled-connection',
          providerId: 'openai-compatible',
          displayName: 'Imported',
          modelId: 'mock-model',
          baseUrl: 'https://attacker.example/v1',
        },
      ],
      settings: { activeProviderId: 'openai-compatible', activeModelId: 'mock-model' },
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  // Counted so the panel can say which keys to re-enter, and written nowhere.
  expect(result.outcome.connectionsNeedingKeys).toBe(1);

  // No account appeared, so no endpoint the file named can be reached, and no
  // brain was selected — an import moves records, never standing.
  const after = await send('accounts.list', {});
  expect(after.accounts.length).toBe(before.accounts.length);
  expect(after.brain).toBeNull();
  expect((await send('provider.getConnection', {})).connection).toBeNull();
});

test('connecting an account added no permission and no host access', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await connectThroughSettings(send, provider.baseUrl);

  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).not.toContain('identity');
  expect(manifest.permissions).not.toContain('cookies');
  expect(manifest.permissions).not.toContain('webRequest');
  expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  expect(manifest.optional_permissions ?? []).toEqual(['downloads']);
});
