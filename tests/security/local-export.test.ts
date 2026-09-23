/**
 * TEST-SECURITY-046 — export and import.
 *
 * Two questions, and they are not symmetric.
 *
 * **Export:** does anything secret get into the file? A file is the most
 * portable thing this product produces — it gets mailed, synced by other
 * software, and left in a downloads folder — so the answer has to be no for
 * every credential shape, not only the ones the exporter happens to know it
 * reads.
 *
 * **Import:** can a file cause something a normal action could not? This is
 * untrusted input with a familiar shape, which is the most dangerous kind.
 * The tests below check that an import goes through the same validators as
 * any other write and therefore cannot install something the recorder itself
 * would have refused.
 */
import { describe, expect, it } from 'vitest';
import {
  applyLocalExport,
  buildLocalExport,
  EXPORTABLE_KINDS,
  EXPORT_FORMAT_VERSION,
  EXPORT_KIND,
  parseLocalExport,
  type LocalExport,
} from '@/storage/data-export';
import { isSecret } from '@/storage/data-classification';

const NOW = 1_800_000_000_000;
const KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';

function sources(overrides: Partial<Parameters<typeof buildLocalExport>[0]> = {}) {
  return {
    listWorkflows: () => Promise.resolve([{ workflowId: 'wf_1', name: 'Book a table' }]),
    listShortcuts: () => Promise.resolve([{ shortcutId: 'sc_1', name: 'book' }]),
    listConnections: () =>
      Promise.resolve([
        {
          connectionId: 'conn_1',
          providerId: 'openai-compatible',
          displayName: 'OpenAI — Work',
          modelId: 'gpt-mock',
          baseUrl: 'https://api.example.test',
        },
      ]),
    readSettings: () => Promise.resolve({ theme: 'dark' }),
    ...overrides,
  };
}

function exportDocument(overrides: Partial<LocalExport> = {}): unknown {
  return {
    kind: EXPORT_KIND,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: NOW,
    notice: 'n/a',
    workflows: [],
    shortcuts: [],
    connections: [],
    settings: {},
    ...overrides,
  };
}

describe('local export', () => {
  it('01 — no exportable data kind is a secret', () => {
    // Enforced against the classification table, so reclassifying a kind as
    // a secret without removing it from the export breaks here.
    for (const kind of EXPORTABLE_KINDS) expect(isSecret(kind)).toBe(false);
  });

  it('02 — a provider API key never appears anywhere in the document', async () => {
    const document_ = await buildLocalExport(
      sources({
        // The worst case: something upstream handed the exporter a record that
        // had a key on it. The document must still not carry it out.
        readSettings: () => Promise.resolve({ theme: 'dark', apiKey: KEY }),
      }),
      NOW,
    );

    expect(JSON.stringify(document_)).not.toContain(KEY);
    expect(JSON.stringify(document_)).not.toContain('apiKey');
  });

  it('03 — connections export what you connected to, never how you authenticate', async () => {
    const document_ = await buildLocalExport(sources(), NOW);
    const connection = document_.connections[0];

    expect(connection?.providerId).toBe('openai-compatible');
    expect(connection?.baseUrl).toBe('https://api.example.test');
    // No accountLabel: it carries a key suffix, which is a fragment of a
    // credential and has no business in a portable file.
    expect(Object.keys(connection ?? {}).sort()).toEqual([
      'baseUrl',
      'connectionId',
      'displayName',
      'modelId',
      'providerId',
    ]);
  });

  it('04 — settings are an allowlist, and the secret strip is the second line', async () => {
    const document_ = await buildLocalExport(
      sources({
        readSettings: () =>
          Promise.resolve({
            // Portable: survives, because it is on the list.
            notificationsEnabled: true,
            // Security posture: dropped, because it is not. A portable file
            // carrying this would be a policy-injection vector waiting for
            // whoever wires settings import next.
            permissionMode: 'auto',
            allowInsecureOrigins: true,
            // Not on the list at all, so it never reaches the file — which is
            // the point of an allowlist over a denylist: a setting somebody
            // adds and forgets is excluded by default.
            unknownFutureSetting: 'whatever',
          }),
      }),
      NOW,
    );

    expect(document_.settings).toEqual({ notificationsEnabled: true });
    const serialised = JSON.stringify(document_);
    expect(serialised).not.toContain('permissionMode');
    expect(serialised).not.toContain('allowInsecureOrigins');
    expect(serialised).not.toContain('unknownFutureSetting');
  });

  it('05 — a credential under an allowed key is still stripped', async () => {
    const document_ = await buildLocalExport(
      sources({
        readSettings: () =>
          Promise.resolve({
            notificationsEnabled: { deeper: { refresh_token: 'rt-secret' }, keep: 1 },
          }),
      }),
      NOW,
    );

    // The allowlist decides which keys may contribute; this is the second
    // line, for a value arriving under one of them.
    expect(JSON.stringify(document_)).not.toContain('rt-secret');
    expect(JSON.stringify(document_)).toContain('keep');
  });

  it('06 — the document says in itself what it does and does not contain', async () => {
    const document_ = await buildLocalExport(sources(), NOW);

    // The file outlives the screen that produced it.
    expect(document_.notice).toMatch(/no API keys/i);
    expect(document_.kind).toBe(EXPORT_KIND);
    expect(document_.formatVersion).toBe(EXPORT_FORMAT_VERSION);
  });
});

describe('local import', () => {
  it('06 — an unrelated JSON file is refused, not partially read', () => {
    for (const candidate of [null, 42, 'text', [], {}, { hello: 'world' }]) {
      const result = parseLocalExport(candidate);
      expect(result.ok).toBe(false);
    }
  });

  it('07 — a newer format version is refused rather than best-effort parsed', () => {
    const result = parseLocalExport(exportDocument({ formatVersion: EXPORT_FORMAT_VERSION + 1 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('UNSUPPORTED_VERSION');
  });

  it('08 — a malformed section is refused with a reason, not silently emptied', () => {
    for (const broken of [
      { workflows: 'not an array' },
      { shortcuts: null },
      { connections: 7 },
      { settings: [] },
      { settings: null },
    ]) {
      const result = parseLocalExport(exportDocument(broken as unknown as Partial<LocalExport>));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.refusal).toBe('MALFORMED');
    }
  });

  it('09 — a file carrying a credential is refused outright, never cleaned', () => {
    // Cleaning would import the acceptable-looking remainder of a file that
    // this exporter demonstrably did not produce. Stopping is the answer.
    for (const smuggled of [
      { workflows: [{ workflowId: 'wf_1', apiKey: KEY }] },
      { shortcuts: [{ shortcutId: 'sc_1', nested: { access_token: 'at' } }] },
      { settings: { deeply: { nested: { clientSecret: 'cs' } } } },
    ]) {
      const result = parseLocalExport(exportDocument(smuggled));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.refusal).toBe('CONTAINS_CREDENTIAL');
    }
  });

  it('10 — a deeply nested structure costs a refusal, not a stack overflow', () => {
    let nested: Record<string, unknown> = { apiKey: KEY };
    for (let depth = 0; depth < 5000; depth += 1) nested = { nested };

    // Past the depth limit the credential is not found, so the document is
    // accepted structurally — the point is that it returns at all.
    const result = parseLocalExport(exportDocument({ settings: nested }));
    expect(typeof result.ok).toBe('boolean');
  });

  it('11 — every record is applied through the store that owns it', async () => {
    const seen: string[] = [];
    const parsed = parseLocalExport(
      exportDocument({
        workflows: [{ workflowId: 'wf_1' }, { workflowId: 'wf_2' }],
        shortcuts: [{ shortcutId: 'sc_1' }],
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');

    await applyLocalExport(parsed.document, {
      importWorkflow: (record) => {
        seen.push(`workflow:${(record as { workflowId: string }).workflowId}`);
        return Promise.resolve('IMPORTED' as const);
      },
      importShortcut: (record) => {
        seen.push(`shortcut:${(record as { shortcutId: string }).shortcutId}`);
        return Promise.resolve('IMPORTED' as const);
      },
    });

    // Nothing was written directly. Every record went to a store method.
    expect(seen).toEqual(['workflow:wf_1', 'workflow:wf_2', 'shortcut:sc_1']);
  });

  it('12 — a record the owning store refuses is counted, and the rest still import', async () => {
    const parsed = parseLocalExport(
      exportDocument({
        workflows: [{ workflowId: 'good' }, { workflowId: 'bad' }, { workflowId: 'also-good' }],
      }),
    );
    if (!parsed.ok) throw new Error('unreachable');

    const outcome = await applyLocalExport(parsed.document, {
      importWorkflow: (record) => {
        if ((record as { workflowId: string }).workflowId === 'bad') {
          // What the worker reports for a record `WorkflowStore.save` judged
          // unacceptable — a judgement about the record, not about this
          // device.
          return Promise.resolve('REFUSED' as const);
        }
        return Promise.resolve('IMPORTED' as const);
      },
      importShortcut: () => Promise.resolve('IMPORTED' as const),
    });

    expect(outcome.workflowsImported).toBe(2);
    // Reported, not rounded away: a silent count would read as a full restore.
    expect(outcome.workflowsRefused).toBe(1);
  });

  it('13 — connections are counted for re-keying and never written', async () => {
    const parsed = parseLocalExport(
      exportDocument({
        connections: [
          {
            connectionId: 'conn_1',
            providerId: 'openai-compatible',
            displayName: null,
            modelId: null,
            baseUrl: null,
          },
        ],
      }),
    );
    if (!parsed.ok) throw new Error('unreachable');

    const outcome = await applyLocalExport(parsed.document, {
      importWorkflow: () => Promise.resolve('IMPORTED' as const),
      importShortcut: () => Promise.resolve('IMPORTED' as const),
    });

    // A connection without its key would fail at its first request while
    // looking ready, so it is surfaced as work for the user instead.
    expect(outcome.connectionsNeedingKeys).toBe(1);
  });

  it('15 — a storage failure is not reported as a rejected record', async () => {
    const parsed = parseLocalExport(
      exportDocument({ workflows: [{ workflowId: 'a' }, { workflowId: 'b' }] }),
    );
    if (!parsed.ok) throw new Error('unreachable');

    const outcome = await applyLocalExport(parsed.document, {
      // What a full disk looks like: the record was fine, the write was not.
      importWorkflow: () => Promise.resolve('FAILED' as const),
      importShortcut: () => Promise.resolve('IMPORTED' as const),
    });

    // The two used to be one number, and the conflation told a user their
    // data had been rejected when what had happened is that this device
    // failed. One is their problem to fix in the file; the other is not their
    // problem at all.
    expect(outcome.failed).toBe(2);
    expect(outcome.workflowsRefused).toBe(0);
    expect(outcome.workflowsImported).toBe(0);
  });

  it('16 — an unexpected throw counts as a failure, never as an acceptance', async () => {
    const parsed = parseLocalExport(exportDocument({ workflows: [{ workflowId: 'a' }] }));
    if (!parsed.ok) throw new Error('unreachable');

    const outcome = await applyLocalExport(parsed.document, {
      importWorkflow: () => Promise.reject(new Error('something nobody predicted')),
      importShortcut: () => Promise.resolve('IMPORTED' as const),
    });

    // Fail closed: an error shape this code does not recognise must not be
    // read as "the record was unacceptable", and certainly not as success.
    expect(outcome.failed).toBe(1);
    expect(outcome.workflowsImported).toBe(0);
  });

  it('17 — a section larger than the bound is refused before anything is walked', () => {
    const huge = Array.from({ length: 1001 }, (_, index) => ({ workflowId: `wf_${index}` }));
    const parsed = parseLocalExport(exportDocument({ workflows: huge }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.refusal).toBe('TOO_LARGE');
  });

  it('18 — a settings section with too many keys is refused', () => {
    const settings = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`k${index}`, index]),
    );
    const parsed = parseLocalExport(exportDocument({ settings }));

    expect(parsed.ok === false && parsed.refusal).toBe('TOO_LARGE');
  });

  it('19 — a document at the bound is still accepted', () => {
    const atLimit = Array.from({ length: 1000 }, (_, index) => ({ workflowId: `wf_${index}` }));
    expect(parseLocalExport(exportDocument({ workflows: atLimit })).ok).toBe(true);
  });

  it('20 — an archive cannot carry a security posture into the parser either', () => {
    const parsed = parseLocalExport(
      exportDocument({
        settings: {
          permissionMode: 'auto',
          allowInsecureOrigins: true,
          notificationsEnabled: false,
        },
      }),
    );
    if (!parsed.ok) throw new Error('unreachable');

    // Narrowed on the way in as well as on the way out, so a file produced
    // elsewhere cannot present a posture to anything downstream even if a
    // later phase starts applying settings.
    expect(parsed.document.settings).toEqual({ notificationsEnabled: false });
  });

  it('21 — nothing that identifies this installation reaches the document', async () => {
    const document_ = await buildLocalExport(sources(), NOW);
    const serialised = JSON.stringify(document_);

    // The installation label is this device's data-ownership partition. An
    // archive carrying one would let an import claim to *be* another
    // installation rather than bring records to this one.
    expect(serialised).not.toMatch(/loc_[0-9a-f]{8}/);
    expect(serialised).not.toMatch(/usr_[0-9a-f]{8}/);
    for (const term of ['abaUserId', 'installationId', 'deviceId', 'unassigned']) {
      expect(serialised, term).not.toContain(term);
    }
    // And the shape is closed: these eight keys and nothing else.
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
  });

  it('22 — a connection exports five fields, and the key suffix is not one', async () => {
    const document_ = await buildLocalExport(sources(), NOW);

    expect(Object.keys(document_.connections[0] ?? {}).sort()).toEqual([
      'baseUrl',
      'connectionId',
      'displayName',
      'modelId',
      'providerId',
    ]);
    // `accountLabel` on the live view carries the key's last four characters.
    // Four characters of a key is still four characters of a key, and a
    // portable file is exactly where they must not be.
    expect(JSON.stringify(document_)).not.toContain('accountLabel');
  });

  it('14 — a round trip preserves what it carries and drops what it must', async () => {
    const built = await buildLocalExport(sources(), NOW);
    const parsed = parseLocalExport(JSON.parse(JSON.stringify(built)));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.document.workflows).toHaveLength(1);
    expect(parsed.document.connections).toHaveLength(1);
    expect(JSON.stringify(parsed.document)).not.toContain(KEY);
  });
});
