/**
 * TEST-E2E-9R — 9Router in a real browser, against a local gateway.
 *
 * MOCK GATEWAY E2E. The endpoint is a local server speaking the Chat Completions
 * protocol with a 9Router-shaped catalogue. Nothing here is evidence that a real
 * 9Router install, or any upstream behind one, has been exercised — and no paid
 * account is needed to run it.
 *
 * What the unit suites cannot establish is whether the exact model id survives
 * real `chrome.storage.local`, a real service-worker lifecycle, a real message
 * router with route trust in front of it, and a real HTTP request. A `/` in a
 * model id is the value most likely to be quietly damaged on that journey, so
 * these cases follow one id — `openai/gpt-5.x` — from the catalogue to the wire
 * and back after a worker restart.
 */
import { expect, killServiceWorker, test } from './fixtures/extension';

const KEY = 'test-key-9router-aaaaaaaaaaaa';

/** A catalogue with two upstreams, a combination, and entries to be refused. */
const CATALOGUE = [
  { id: 'openai/gpt-5.x', object: 'model', owned_by: 'openai' },
  { id: 'openai/gpt-4o', object: 'model', owned_by: 'openai' },
  { id: 'anthropic/claude-x', object: 'model', owned_by: 'anthropic' },
  { id: 'my-combo', object: 'model', owned_by: 'combo' },
  { id: 'lonely-model', object: 'model' },
  // Refused per entry, without costing the ones above or below.
  null,
  { object: 'model', owned_by: 'openai' },
  { id: 42, object: 'model', owned_by: 'openai' },
  { id: 'openai/gpt-5.x', object: 'model', owned_by: 'anthropic' },
  { id: 'last/one', object: 'model', owned_by: 'openai' },
];

async function connect(
  send: (type: string, payload: unknown) => Promise<never>,
  provider: { baseUrl: string },
): Promise<string> {
  const result = (await send('accounts.connect', {
    providerId: 'nine-router',
    baseUrl: provider.baseUrl,
    apiKey: KEY,
    model: 'openai/gpt-5.x',
    displayName: '9Router — local',
  })) as unknown as { account?: { connectionId: string }; error?: unknown };
  expect(result.error).toBeUndefined();
  expect(result.account?.connectionId).toBeDefined();
  return result.account!.connectionId;
}

test('discovery groups models by upstream and keeps every exact id', async ({ send, provider }) => {
  provider.setCatalogue(CATALOGUE);
  const connectionId = await connect(send as never, provider);

  const listed = await send('accounts.listModels', { connectionId });

  // Six usable entries; four refused, and the refusals did not cost the rest.
  expect(listed.models.map((model) => model.id)).toEqual([
    'openai/gpt-5.x',
    'openai/gpt-4o',
    'anthropic/claude-x',
    'my-combo',
    'lonely-model',
    'last/one',
  ]);
  expect(listed.refused).toBe(4);

  // Four groups: two upstreams, the combination category, and the fallback for
  // the entry that named no upstream.
  const groups = listed.groups ?? [];
  expect(groups).toHaveLength(4);
  expect(groups.map((group) => group.kind)).toEqual(['provider', 'provider', 'combo', 'other']);
  const byKind = (kind: string): (typeof groups)[number] | undefined =>
    groups.find((group) => group.kind === kind);
  expect(byKind('combo')?.modelCount).toBe(1);
  expect(byKind('other')?.modelCount).toBe(1);

  // The grouping came from `owned_by`, not from the id: `last/one` is prefixed
  // `last` and belongs to the `openai` group because that is what the catalogue
  // said. Splitting the id would have put it in a group of its own.
  const openai = groups.find((group) => group.displayName === 'openai');
  expect(openai?.modelCount).toBe(3);
  const last = listed.models.find((model) => model.id === 'last/one');
  expect(last?.upstreamKey).toBe(openai?.key);

  // The combination has no prefix and none was invented for it.
  expect(listed.models.find((model) => model.id === 'my-combo')?.upstreamKey).toBe(
    byKind('combo')?.key,
  );
});

test('a selected slash-containing id reaches the wire unchanged', async ({ send, provider }) => {
  provider.setCatalogue(CATALOGUE);
  const connectionId = await connect(send as never, provider);
  const listed = await send('accounts.listModels', { connectionId });
  const chosen = listed.models.find((model) => model.id === 'openai/gpt-5.x')!;

  // The doctor is what makes a brain usable, and it probes the exact model — so
  // it is also the first stage that would reveal a mangled id.
  await send('accounts.runDoctor', { connectionId, modelId: chosen.id });
  await send('accounts.setBrain', {
    connectionId,
    modelId: chosen.id,
    ...(chosen.upstreamKey === undefined ? {} : { upstreamKey: chosen.upstreamKey }),
  });

  const beforeTask = provider.requests.length;
  provider.script([{ kind: 'text', text: 'done' }]);
  const { task } = await send('task.create', { objective: 'Say done.' });
  expect(task.id).toBeTruthy();

  await expect
    .poll(() => provider.requests.length, { timeout: 40_000 })
    .toBeGreaterThan(beforeTask);

  // Every completion request — the doctor's probes and the task's turn — names
  // the exact id. Not `gpt-5.x`, not `openai_gpt-5.x`, not trimmed.
  const completions = provider.requests.filter((request) =>
    request.path.endsWith('/chat/completions'),
  );
  expect(completions.length).toBeGreaterThan(0);
  for (const request of completions) {
    expect((request.body as { model?: string }).model).toBe('openai/gpt-5.x');
  }
  // And at least one of them was made for the task rather than the doctor.
  expect(provider.requests.slice(beforeTask).length).toBeGreaterThan(0);
});

test('the selection and its upstream survive a real worker restart', async ({
  send,
  provider,
  serviceWorker,
  context,
}) => {
  provider.setCatalogue(CATALOGUE);
  const connectionId = await connect(send as never, provider);
  const listed = await send('accounts.listModels', { connectionId });
  const chosen = listed.models.find((model) => model.id === 'anthropic/claude-x')!;
  await send('accounts.setBrain', {
    connectionId,
    modelId: chosen.id,
    ...(chosen.upstreamKey === undefined ? {} : { upstreamKey: chosen.upstreamKey }),
  });

  await killServiceWorker(context, serviceWorker);

  const after = await send('accounts.list', {});
  const account = after.accounts.find((entry) => entry.connectionId === connectionId);
  // The `/` came back intact through real extension storage.
  expect(account?.modelId).toBe('anthropic/claude-x');
  expect(account?.upstreamKey).toBe(chosen.upstreamKey);
  expect(after.brain?.modelId).toBe('anthropic/claude-x');
});

test('switching model within one upstream does not move a running task', async ({
  send,
  provider,
}) => {
  provider.setCatalogue(CATALOGUE);
  const connectionId = await connect(send as never, provider);
  const listed = await send('accounts.listModels', { connectionId });
  const first = listed.models.find((model) => model.id === 'openai/gpt-5.x')!;
  const second = listed.models.find((model) => model.id === 'openai/gpt-4o')!;

  await send('accounts.runDoctor', { connectionId, modelId: first.id });
  await send('accounts.setBrain', {
    connectionId,
    modelId: first.id,
    ...(first.upstreamKey === undefined ? {} : { upstreamKey: first.upstreamKey }),
  });

  // A turn is genuinely outstanding while the model is switched underneath it.
  // The doctor's probes are exempt from this delay, so the wait below is for the
  // task's own turn rather than for setup.
  const beforeTask = provider.requests.length;
  provider.setReplyDelay(4_000);
  provider.script([{ kind: 'text', text: 'first' }]);
  const { task } = await send('task.create', { objective: 'Hold on.' });
  expect(task.id).toBeTruthy();

  await expect
    .poll(() => provider.requests.length, { timeout: 40_000 })
    .toBeGreaterThan(beforeTask);

  await send('accounts.setBrain', {
    connectionId,
    modelId: second.id,
    ...(second.upstreamKey === undefined ? {} : { upstreamKey: second.upstreamKey }),
  });

  // Every request this task made names the model it started on. The switch
  // applies to what comes next, not to a turn already in flight.
  const models = provider.requests
    .filter((request) => request.path.endsWith('/chat/completions'))
    .map((request) => (request.body as { model?: string }).model);
  expect(models.every((model) => model === 'openai/gpt-5.x')).toBe(true);
});

test('the gateway key never appears in the audit trail or the account view', async ({
  send,
  provider,
}) => {
  provider.setCatalogue(CATALOGUE);
  const connectionId = await connect(send as never, provider);
  const listed = await send('accounts.listModels', { connectionId });
  await send('accounts.runDoctor', { connectionId, modelId: 'openai/gpt-5.x' });
  await send('accounts.setBrain', { connectionId, modelId: 'openai/gpt-5.x' });
  provider.script([{ kind: 'text', text: 'done' }]);
  await send('task.create', { objective: 'Say done.' });

  const exported = await send('audit.export', { scope: { kind: 'all' } });
  const serialised = JSON.stringify(exported);
  // The key went to the endpoint and nowhere else.
  expect(serialised).not.toContain(KEY);
  expect(serialised).not.toContain(KEY.slice(0, 12));

  const accounts = await send('accounts.list', {});
  const view = JSON.stringify(accounts);
  expect(view).not.toContain(KEY);
  // The label identifies the key by its last four characters only.
  expect(view).toContain(KEY.slice(-4));

  // And the catalogue request did carry the key, so the absence above is about
  // what is recorded rather than about a request that never happened.
  const discovery = provider.requests.find((request) => request.path.endsWith('/models'));
  expect(discovery?.headers['authorization']).toBe(`Bearer ${KEY}`);
  expect(listed.models.length).toBeGreaterThan(0);
});

test('the audit trail records the exact id, and 9Router added no permission', async ({
  send,
  provider,
  extensionId,
  context,
}) => {
  provider.setCatalogue(CATALOGUE);
  const connectionId = await connect(send as never, provider);
  await send('accounts.listModels', { connectionId });
  await send('accounts.runDoctor', { connectionId, modelId: 'openai/gpt-5.x' });
  await send('accounts.setBrain', { connectionId, modelId: 'openai/gpt-5.x' });
  provider.script([{ kind: 'text', text: 'done' }]);
  await send('task.create', { objective: 'Say done.' });

  await expect
    .poll(
      async () => {
        const exported = await send('audit.export', { scope: { kind: 'all' } });
        return JSON.stringify(exported).includes('openai/gpt-5.x');
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // The trail is healthy: an id with a `/` did not cost a record.
  const health = await send('health.get', {});
  const audit = health.snapshot.records.filter((record) => record.domain === 'audit');
  expect(audit.every((record) => record.state === 'HEALTHY')).toBe(true);

  // No new permission and no new host access. The manifest is the authority.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/manifest.json`);
  const manifest = JSON.parse(await page.locator('pre').innerText()) as {
    permissions: string[];
    host_permissions: string[];
  };
  await page.close();
  expect(manifest.permissions).not.toContain('nativeMessaging');
  expect(manifest.host_permissions.sort()).toEqual(['http://*/*', 'https://*/*']);
});
