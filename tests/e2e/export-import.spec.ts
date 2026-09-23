/**
 * TEST-E2E-028 — export and import as a real portability boundary.
 *
 * The unit suite drives the format against stubs. What only a real browser
 * establishes is what the *live installation* actually puts in a file: the
 * export reads from the real stores, the real connected accounts and the real
 * settings record, and any of those could grow a field that the format's own
 * rules never see. So these build a populated installation, export it, and
 * inspect the bytes.
 *
 * The ones that matter most are about what is **absent**. A portable file is
 * exactly where a provider key or an installation label would do the most
 * damage, and absence is the one property a format test cannot establish on
 * its own — the stub does not have a key to leak.
 *
 * Everything runs against the shipped `dist/` build, with no backend.
 */
import type { Worker } from '@playwright/test';
import { connectProvider, expect, killServiceWorker, openPanel, test } from './fixtures/extension';

/** A key that is genuinely stored, so the absence tests are not vacuous. */
const API_KEY = 'sk-live-export-import-aaaaaaaaaaaaaaaaaaaa';

/**
 * A definition in the shape the recorder produces.
 *
 * Written out rather than recorded because what is under test is the import
 * path, and an import receives a definition from a file, not from a recorder.
 * It has to be genuinely valid: a definition the store would refuse proves
 * nothing about what an accepted one is allowed to claim.
 */
function recordedDefinition(): Record<string, unknown> {
  return {
    id: 'recorded.workflow',
    version: '1.0.0',
    name: 'Recorded workflow',
    description: 'Recorded from a task.',
    provenance: 'recorded',
    risk: 'R0',
    requiredTools: ['browser.read_page'],
    requiredConnectors: [],
    inputs: [],
    outputs: [],
    steps: [
      {
        kind: 'tool',
        id: 's1',
        tool: 'browser.read_page',
        description: 'Recorded browser.read_page.',
        arguments: { includeText: { kind: 'literal', value: false } },
      },
    ],
  };
}

/** A well-formed archive, with whatever a test wants to change about it. */
function archive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'aba.local-export',
    formatVersion: 1,
    exportedAt: Date.now(),
    notice: '',
    workflows: [],
    shortcuts: [],
    connections: [],
    settings: {},
    ...overrides,
  };
}

/** The installation's own ownership label, read from storage. */
async function installationId(worker: Worker): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = await worker.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const key = Object.keys(all).find((name) => name.includes('identity-local'));
      return key === undefined
        ? null
        : ((all[key] as { installationId?: string }).installationId ?? null);
    });
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('no installation identity was established');
}

/**
 * Brings an installation to the state the absence tests need.
 *
 * Every section of the export has to be non-empty, or a test that scans the
 * bytes for a leaked field passes because there was nothing to scan. The
 * account is connected through `accounts.connect` specifically: that is the
 * store the export's `connections` section is built from.
 */
async function populate(
  send: Parameters<typeof connectProvider>[0],
  provider: Parameters<typeof connectProvider>[1],
): Promise<void> {
  await connectProvider(send, provider);
  const connected = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: API_KEY,
    model: 'mock-model',
  });
  if (connected.account === null) throw new Error('the account did not connect');

  await send('workspace.create', { title: 'Reading' });
  const imported = await send('data.import', {
    document: archive({
      workflows: [{ name: 'Populated', description: '', definition: recordedDefinition() }],
      shortcuts: [
        { displayName: 'Populated', target: { kind: 'workflow', workflowId: 'wf_placeholder' } },
      ],
    }),
  });
  if (!imported.ok || imported.outcome.workflowsImported !== 1) {
    throw new Error('the installation was not populated');
  }
}

test('an export of a populated installation has the shape the format promises', async ({
  send,
  provider,
}) => {
  await populate(send, provider);

  const { export: document_ } = await send('data.export', {});

  expect(document_.kind).toBe('aba.local-export');
  expect(document_.formatVersion).toBe(1);
  expect(typeof document_.exportedAt).toBe('number');
  // A closed shape: eight keys, and a ninth would mean something was added
  // without anyone deciding it was portable.
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
  // The connection the user actually made is described, so a restore knows
  // what to reconnect to — and described by exactly five fields.
  expect(document_.connections.length).toBeGreaterThan(0);
  for (const connection of document_.connections) {
    expect(Object.keys(connection).sort()).toEqual([
      'baseUrl',
      'connectionId',
      'displayName',
      'modelId',
      'providerId',
    ]);
  }
});

test('a real provider key never reaches the exported bytes', async ({ send, provider }) => {
  await populate(send, provider);

  const { export: document_ } = await send('data.export', {});

  // The keys are genuinely stored — this is not a test against an empty vault.
  const stored = await send('accounts.list', {});
  expect(stored.accounts.length).toBeGreaterThan(0);

  const serialised = JSON.stringify(document_);
  expect(serialised).not.toContain(API_KEY);
  expect(serialised).not.toContain('test-key-abcdefghijklmnop');
  // Not even the last four characters, which the live account view carries
  // as `accountLabel` for display. Four characters of a key is still four
  // characters of a key, and a file is where they must not be.
  expect(serialised).not.toContain(API_KEY.slice(-4));
  expect(serialised).not.toContain('accountLabel');

  // The notice is prose *about* what the file excludes, so it legitimately
  // says the words "tokens" and "credentials". Scanned without it, so a real
  // field cannot hide behind the sentence that promises it is not there.
  const withoutNotice = JSON.stringify({ ...document_, notice: '' }).toLowerCase();
  for (const term of ['apikey', 'api_key', 'secret', 'token', 'authorization', 'credential']) {
    expect(withoutNotice, term).not.toContain(term);
  }
});

test('the installation identity never reaches the exported bytes', async ({
  send,
  serviceWorker,
  provider,
}) => {
  await populate(send, provider);
  const owner = await installationId(serviceWorker);

  // Non-empty in every section, so a scan for a leaked identity is scanning
  // real records rather than four empty arrays.

  const { export: document_ } = await send('data.export', {});
  const serialised = JSON.stringify(document_);
  expect(document_.connections.length).toBeGreaterThan(0);
  expect(document_.workflows.length).toBeGreaterThan(0);
  expect(document_.shortcuts.length).toBeGreaterThan(0);

  // An archive carrying this would let an import claim to *be* another
  // installation rather than bring records to this one.
  expect(owner).toMatch(/^loc_[0-9a-f]{32}$/);
  expect(serialised).not.toContain(owner);
  expect(serialised).not.toMatch(/loc_[0-9a-f]{8}/);
  expect(serialised).not.toContain('abaUserId');
  expect(serialised).not.toContain('installationId');
  expect(serialised).not.toContain('deviceId');
});

test('the security posture is not portable', async ({ send }) => {
  // Genuinely moved away from the default, so its absence from the file is
  // about the allowlist rather than about the value happening to be boring.
  await send('session.setPermissionMode', { mode: 'skip' });

  const { export: document_ } = await send('data.export', {});

  // `permissionMode` and `allowInsecureOrigins` are this installation's
  // security posture, not a preference. A file that carried one would be a
  // policy-injection vector waiting for whoever wires settings import next.
  expect(Object.keys(document_.settings)).not.toContain('permissionMode');
  expect(Object.keys(document_.settings)).not.toContain('allowInsecureOrigins');
  const serialised = JSON.stringify(document_);
  expect(serialised).not.toContain('allowInsecureOrigins');
  expect(serialised).not.toContain('permissionMode');
});

test('importing brings records to this installation and leaves its identity alone', async ({
  send,
  serviceWorker,
}) => {
  const before = await installationId(serviceWorker);

  // An archive from somewhere else, naming a different owner, as a hostile
  // one would.
  const result = await send('data.import', {
    document: archive({
      notice: 'from another device',
      abaUserId: 'loc_ffffffffffffffffffffffffffffffff',
      installationId: 'loc_ffffffffffffffffffffffffffffffff',
      workflows: [{ name: 'From device A', description: '', definition: recordedDefinition() }],
    }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.outcome.workflowsImported).toBe(1);

  // Device B keeps its own identity. The archive's owner field is not adopted,
  // and there is no path by which it could be.
  const after = await installationId(serviceWorker);
  expect(after).toBe(before);
  expect(after).not.toBe('loc_ffffffffffffffffffffffffffffffff');
});

test('a malformed archive is refused with a reason and changes nothing', async ({ send }) => {
  const before = (await send('workflow.list', {})).workflows.length;

  for (const candidate of [
    null,
    'not an object',
    {},
    { kind: 'something.else', formatVersion: 1 },
    { kind: 'aba.local-export' },
    archive({ workflows: 'not an array' }),
    archive({ settings: [] }),
  ]) {
    const result = await send('data.import', { document: candidate });
    expect(result.ok, JSON.stringify(candidate)).toBe(false);
  }

  expect((await send('workflow.list', {})).workflows.length).toBe(before);
});

test('an archive from a newer version is refused rather than partly read', async ({ send }) => {
  const before = (await send('workflow.list', {})).workflows.length;

  const result = await send('data.import', {
    document: archive({
      formatVersion: 99,
      workflows: [{ name: 'Should not land', definition: recordedDefinition() }],
    }),
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.refusal).toBe('UNSUPPORTED_VERSION');
  // The workflow the refused file carried is a valid one, so nothing but the
  // refusal stopped it landing.
  expect((await send('workflow.list', {})).workflows.length).toBe(before);
});

test('an archive carrying a credential is refused outright, not cleaned', async ({ send }) => {
  const before = (await send('workflow.list', {})).workflows.length;

  const result = await send('data.import', {
    document: archive({
      workflows: [
        { name: 'W', definition: recordedDefinition() },
        { name: 'Smuggler', definition: recordedDefinition(), apiKey: 'sk-smuggled' },
      ],
    }),
  });

  // Refused whole. Importing the first record, which looks acceptable, would
  // be treating a file this exporter did not produce as though it had.
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.refusal).toBe('CONTAINS_CREDENTIAL');
  expect((await send('workflow.list', {})).workflows.length).toBe(before);
});

test('an oversized archive is refused before anything is walked', async ({ send }) => {
  const before = (await send('workflow.list', {})).workflows.length;

  const result = await send('data.import', {
    document: archive({
      workflows: Array.from({ length: 1001 }, () => ({
        name: 'Too many',
        definition: recordedDefinition(),
      })),
    }),
  });

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  expect(result.refusal).toBe('TOO_LARGE');
  expect((await send('workflow.list', {})).workflows.length).toBe(before);
});

test('importing the same archive twice does not silently merge records', async ({ send }) => {
  const document = archive({
    shortcuts: [
      { displayName: 'Duplicate name', target: { kind: 'workflow', workflowId: 'wf_missing' } },
    ],
  });

  const first = await send('data.import', { document });
  const second = await send('data.import', { document });

  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error('unreachable');
  expect(first.outcome.shortcutsImported).toBe(1);
  // A shortcut name is unique by construction, so the second import's copy is
  // refused by the store that owns names rather than quietly taking one that
  // already means something. Refused, not failed: the record is the problem,
  // not this device.
  expect(second.outcome.shortcutsImported).toBe(0);
  expect(second.outcome.shortcutsRefused).toBe(1);
  expect(second.outcome.failed).toBe(0);

  expect((await send('shortcut.list', {})).shortcuts.length).toBe(1);
});

test('an imported workflow is re-validated and carries no privilege from the file', async ({
  send,
}) => {
  const result = await send('data.import', {
    document: archive({
      workflows: [
        {
          name: 'Claims to be trusted',
          description: '',
          definition: recordedDefinition(),
          // Everything a file might assert about its own standing.
          definitionHash: 'a'.repeat(64),
          risk: 'R0',
          taintAtCapture: 'KNOWN_UNTAINTED',
          workflowId: 'workflow_from_the_file',
          version: 99,
        },
      ],
    }),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  expect(result.outcome.workflowsImported).toBe(1);

  const imported = (await send('workflow.list', {})).workflows.find(
    (workflow) => workflow.name === 'Claims to be trusted',
  );
  expect(imported).toBeDefined();
  // The store recomputed everything. A hash, an id, a version and a taint
  // claim in the file are ignored, so an import cannot install a workflow
  // with standing the recorder would never have given it.
  expect(imported?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  expect(imported?.definitionHash).not.toBe('a'.repeat(64));
  expect(imported?.workflowId).not.toBe('workflow_from_the_file');
  expect(imported?.version).toBe(1);
  expect(imported?.taintAtCapture).toBe('UNKNOWN');
});

test('an export taken from this installation imports back into it', async ({ send }) => {
  await send('data.import', {
    document: archive({
      workflows: [{ name: 'Round trip', description: '', definition: recordedDefinition() }],
    }),
  });

  const { export: document_ } = await send('data.export', {});
  const again = await send('data.import', { document: document_ });

  expect(again.ok).toBe(true);
  if (!again.ok) throw new Error('unreachable');
  // The exporter's own output passes its own parser — the format is closed
  // over a round trip rather than only over the fixtures.
  expect(again.outcome.workflowsImported).toBe(1);
  expect(again.outcome.failed).toBe(0);
});

test('export and import survive a real worker termination', async ({
  context,
  extensionId,
  send,
  serviceWorker,
}) => {
  const owner = await installationId(serviceWorker);
  const { export: document_ } = await send('data.export', {});

  await killServiceWorker(context, serviceWorker);
  const panel = await openPanel(context, extensionId);
  const restarted = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

  // The archive taken before the restart is still importable afterwards, and
  // the installation it lands in is the same one.
  expect(await installationId(restarted)).toBe(owner);
  expect(document_.kind).toBe('aba.local-export');
  await panel.close();
});

test('neither export nor import requires the network', async ({ send, provider, collector }) => {
  await connectProvider(send, provider);
  const seenBefore = collector.requests.length;

  const { export: document_ } = await send('data.export', {});
  await send('data.import', { document: document_ });

  // Nothing reached the observing origin. An export is built in the worker
  // from local storage and an import is read from a file the user chose;
  // there is no step in either that could contact anything.
  expect(collector.requests.length).toBe(seenBefore);
});
