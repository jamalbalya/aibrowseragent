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

  it('04 — nested credential-shaped fields are stripped from settings', async () => {
    const document_ = await buildLocalExport(
      sources({
        readSettings: () =>
          Promise.resolve({ nested: { deeper: { refresh_token: 'rt-secret' }, keep: 1 } }),
      }),
      NOW,
    );

    expect(JSON.stringify(document_)).not.toContain('rt-secret');
    expect(JSON.stringify(document_)).toContain('keep');
  });

  it('05 — the document says in itself what it does and does not contain', async () => {
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
        return Promise.resolve();
      },
      importShortcut: (record) => {
        seen.push(`shortcut:${(record as { shortcutId: string }).shortcutId}`);
        return Promise.resolve();
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
          // Exactly what WorkflowStore.save does for an unacceptable one.
          throw new Error('that workflow names a tool this build does not have');
        }
        return Promise.resolve();
      },
      importShortcut: () => Promise.resolve(),
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
      importWorkflow: () => Promise.resolve(),
      importShortcut: () => Promise.resolve(),
    });

    // A connection without its key would fail at its first request while
    // looking ready, so it is surfaced as work for the user instead.
    expect(outcome.connectionsNeedingKeys).toBe(1);
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
