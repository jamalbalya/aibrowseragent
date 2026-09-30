/**
 * TEST-BOUNDARY-002 — the two reported reproducers, and the shapes around them.
 *
 * `boundary-census.test.ts` proves the contract holds at each maximum. This file
 * walks the boundary one character at a time and through the value shapes a real
 * user produces — Unicode, emoji, spaces, punctuation, repeated delimiters — and
 * checks the things that are easy to break while fixing a length: that the
 * download safety rules still refuse what they refused, that the trail stays
 * healthy rather than merely accepting the record, that no evidence is left
 * pointing at nothing, and that a server survives a reload.
 */
import { describe, expect, it } from 'vitest';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { PersistenceHealthStore } from '@/storage/persistence-health';
import { checkDownloadFilename } from '@/files/download-safety';
import { safeDisplayName, safeMediaType } from '@/files/file-model';
import { McpServerStore } from '@/mcp/core/mcp-server-store';
import { admitListing, mcpToolName, validateServerDescriptor } from '@/mcp/core/mcp-model';
import {
  MAX_DETAIL,
  MAX_FILENAME,
  MAX_MCP_SERVER_ID,
  MAX_MCP_TOOL_NAME,
  MAX_STRING,
} from '@/audit/boundaries';
import { createFileTools } from '@/tools/files/file-tools';
import { StagedFileStore } from '@/files/file-store';
import { FileSelectionBroker } from '@/background/file-broker';

interface Wiring {
  readonly audit: AuditLog;
  readonly health: PersistenceHealthStore;
}

function wire(): Wiring {
  const health = new PersistenceHealthStore(new SerializedStorageArea(new MemoryStorageArea()));
  return {
    health,
    audit: new AuditLog(new SerializedStorageArea(new MemoryStorageArea()), {
      knownTool: () => true,
      health,
    }),
  };
}

/** Records a download and reports whether the trail stayed healthy. */
async function downloadRecorded(
  fileName: string,
): Promise<{ readonly written: boolean; readonly healthy: boolean }> {
  const { audit, health } = wire();
  const written =
    (await audit.record({
      type: 'file.downloaded',
      taskId: 'task_abc',
      tool: 'browser.download',
      outcome: 'allowed',
      fileName,
      origin: 'https://example.test',
    })) !== null;
  const snapshot = await health.snapshot();
  const healthy = snapshot.records
    .filter((record) => record.domain === 'audit')
    .every((record) => record.state === 'HEALTHY');
  return { written, healthy: healthy && audit.degradedReason() === null };
}

describe('TEST-BOUNDARY-002 — BUG-1, the filename reproducer', () => {
  it('01 — the exact reported name is accepted by both sides', async () => {
    const name = `${'a'.repeat(196)}.txt`;
    expect(name.length).toBe(200);
    expect(checkDownloadFilename(name)).toEqual({ ok: true, filename: name });
    const result = await downloadRecorded(name);
    // Before the fix: written was false and healthy was false, and the panel
    // said "Some stored records were lost".
    expect(result).toEqual({ written: true, healthy: true });
  });

  for (const length of [127, 128, 129, 199, 200]) {
    it(`02 — a ${length}-character name is validated and recorded`, async () => {
      const name = `${'a'.repeat(length - 4)}.txt`;
      expect(checkDownloadFilename(name).ok).toBe(true);
      expect(await downloadRecorded(name)).toEqual({ written: true, healthy: true });
    });
  }

  it('03 — 201 is refused by the validator, so nothing is recorded to lose', () => {
    const name = `${'a'.repeat(197)}.txt`;
    expect(name.length).toBe(201);
    const verdict = checkDownloadFilename(name);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('TOO_LONG');
  });

  const SHAPES: readonly [string, string][] = [
    ['unicode', `${'é'.repeat(140)}.txt`],
    ['emoji', `${'🙂'.repeat(60)}.txt`],
    ['spaces', `${'a b '.repeat(40)}c.txt`],
    ['punctuation', `${'a-_.()[]'.repeat(20)}.txt`],
    ['repeated dots', `${'a.'.repeat(80)}txt`],
    ['repeated hyphens', `${'-'.repeat(150)}name.txt`],
    ['a single character', 'a'],
    ['an extension only', '.gitignore'],
  ];

  for (const [label, name] of SHAPES) {
    it(`04 — ${label}: whatever the validator accepts, the trail records`, async () => {
      const verdict = checkDownloadFilename(name);
      if (!verdict.ok) return; // refused before anything happened; nothing to lose.
      const result = await downloadRecorded(verdict.filename);
      expect(result, `${label} (${name.length} chars)`).toEqual({
        written: true,
        healthy: true,
      });
    });
  }

  it('05 — the extension survives, because nothing truncates', () => {
    const name = `${'report-'.repeat(25)}final.tar.gz`;
    const verdict = checkDownloadFilename(name);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // The fix aligned the limits rather than shortening the name, so the file
      // is still saved under the name that was asked for.
      expect(verdict.filename).toBe(name);
      expect(verdict.filename.endsWith('.tar.gz')).toBe(true);
    }
  });

  it('06 — the safety rules are unchanged', () => {
    // Nothing here loosened the validator to make the trail succeed.
    for (const [raw, code] of [
      ['/etc/passwd', 'ABSOLUTE'],
      ['C:\\Windows\\x.txt', 'ABSOLUTE'],
      ['../../secret.txt', 'TRAVERSAL'],
      ['a/b.txt', 'PATH_SEPARATOR'],
      ['a\\b.txt', 'PATH_SEPARATOR'],
      ['a\u0000b.txt', 'CONTROL_CHARACTER'],
      ['', 'EMPTY'],
    ] as [string, string][]) {
      const verdict = checkDownloadFilename(raw);
      expect(verdict.ok, raw).toBe(false);
      if (!verdict.ok) expect(verdict.code, raw).toBe(code);
    }
  });

  it('07 — selection and download share one contract', async () => {
    // Both fill the same field, so both have to fit it. They did not: one was
    // bounded at 200 and the other at 255, against a field bounded at 128.
    const picked = safeDisplayName(`${'b'.repeat(400)}.pdf`);
    expect(picked.length).toBe(MAX_FILENAME);
    const { audit, health } = wire();
    expect(
      await audit.record({
        type: 'file.selected',
        outcome: 'allowed',
        origin: 'local',
        fileName: picked,
      }),
    ).not.toBeNull();
    expect(
      await audit.record({
        type: 'file.attached',
        taskId: 'task_abc',
        tool: 'browser.attach_file',
        outcome: 'allowed',
        fileName: picked,
        origin: 'local',
      }),
    ).not.toBeNull();
    const snapshot = await health.snapshot();
    expect(
      snapshot.records
        .filter((record) => record.domain === 'audit')
        .every((record) => record.state === 'HEALTHY'),
    ).toBe(true);
  });

  it('07b — the download tool itself bounds the sentence it writes', async () => {
    // The guard has to be *called*, not merely to exist: a mutation that removed
    // the call from `audit()` passed every isolated case. So this drives the real
    // tool, with a redirect between two maximal hostnames, and requires the real
    // audit log to accept what it produced.
    const longHostA = `${'a'.repeat(250)}.test`;
    const longHostB = `${'b'.repeat(250)}.test`;
    // Only the sentences, so the assertions need no non-null dance.
    const details: string[] = [];
    const downloads = {
      isPermitted: () => Promise.resolve(true),
      start: () => Promise.resolve(1),
      awaitCompletion: () =>
        Promise.resolve({
          id: 1,
          state: 'complete' as const,
          filename: 'renamed.pdf',
          finalUrl: `https://${longHostB}/served.pdf`,
        }),
      cancel: () => Promise.resolve(),
    };
    const adapter = {
      getTab: () => Promise.resolve({ id: 1, url: 'https://page.test/', title: 'p', active: true }),
      getActiveTab: () =>
        Promise.resolve({ id: 1, url: 'https://page.test/', title: 'p', active: true }),
      callContent: () => Promise.resolve({ attached: 0, names: [], inputWasHidden: false }),
      ensureContentScript: () => Promise.resolve(),
    };
    const tools = createFileTools({
      adapter: adapter as never,
      broker: new FileSelectionBroker({ timeoutMs: 50 }),
      store: new StagedFileStore(),
      downloads,
      recordFileEvent: (event) => {
        if (event.detail !== undefined) details.push(event.detail);
        return Promise.resolve();
      },
    });
    const download = tools.find((tool) => tool.name === 'browser.download');
    expect(download).toBeDefined();
    if (!download) return;
    await download.execute(
      { url: `https://${longHostA}/report.pdf`, filename: 'report.pdf' },
      {
        taskId: 'task_1',
        sessionId: 's',
        toolCallId: 'tc_1',
        tabId: 1,
        currentUrl: 'https://page.test/',
        signal: new AbortController().signal,
        recordEvidence: () => undefined,
      },
    );

    expect(details.length).toBeGreaterThan(0);
    const { audit } = wire();
    for (const detail of details) {
      // Unbounded this sentence was 545 characters against a 256 field.
      expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL);
      expect(
        await audit.record({
          type: 'file.downloaded',
          taskId: 'task_1',
          tool: 'browser.download',
          outcome: 'allowed',
          fileName: 'renamed.pdf',
          detail,
        }),
      ).not.toBeNull();
    }
    expect(audit.degradedReason()).toBeNull();
  });

  it('08 — a long Content-Type no longer costs the record', async () => {
    const { audit } = wire();
    const mimeType = safeMediaType(`text/plain; charset=utf-8; boundary=${'x'.repeat(600)}`);
    expect(mimeType).toBe('text/plain');
    expect(
      await audit.record({
        type: 'file.downloaded',
        taskId: 'task_abc',
        tool: 'browser.download',
        outcome: 'allowed',
        fileName: 'a.txt',
        origin: 'https://example.test',
        ...(mimeType === undefined ? {} : { mimeType }),
      }),
    ).not.toBeNull();
  });
});

describe('TEST-BOUNDARY-002 — BUG-2, the MCP descriptor reproducer', () => {
  const store = (): McpServerStore =>
    new McpServerStore({ area: new SerializedStorageArea(new MemoryStorageArea()) });

  const schema = { type: 'object' } as const;

  it('09 — a short id still works', async () => {
    const added = await store().add({
      id: 'srv',
      displayName: 'Server',
      url: 'https://example.test/mcp',
    });
    expect(added.id).toBe('srv');
  });

  for (const length of [255, 256, 257, 400]) {
    it(`10 — a ${length}-character id is refused before the server exists`, async () => {
      await expect(
        store().add({
          id: 'a'.repeat(length),
          displayName: 'Server',
          url: 'https://example.test/mcp',
        }),
      ).rejects.toThrow();
      // And the derived name it would have produced is the reason: it does not
      // fit the field the trail records it in.
      expect(mcpToolName('a'.repeat(length), 'search').length).toBeGreaterThan(MAX_STRING);
    });
  }

  it('11 — the id boundary is exactly where the contract says', async () => {
    await expect(
      store().add({
        id: 'a'.repeat(MAX_MCP_SERVER_ID),
        displayName: 'Server',
        url: 'https://example.test/mcp',
      }),
    ).resolves.toBeDefined();
    await expect(
      store().add({
        id: 'a'.repeat(MAX_MCP_SERVER_ID + 1),
        displayName: 'Server',
        url: 'https://example.test/mcp',
      }),
    ).rejects.toThrow();
  });

  it('12 — Unicode, spaces and punctuation in an id are still refused on charset', () => {
    for (const id of ['srv name', 'srvé', 'SRV', 'srv_name', 'srv.name', 'srv/name', '🙂']) {
      const verdict = validateServerDescriptor({
        id,
        displayName: 'Server',
        url: 'https://example.test/mcp',
      });
      expect(verdict.ok, id).toBe(false);
    }
  });

  it('13 — a Unicode display name is allowed, but not an unbounded one', () => {
    expect(
      validateServerDescriptor({
        id: 'srv',
        displayName: 'Serveur — 日本語 🙂',
        url: 'https://example.test/mcp',
      }).ok,
    ).toBe(true);
    expect(
      validateServerDescriptor({
        id: 'srv',
        displayName: '🙂'.repeat(2500),
        url: 'https://example.test/mcp',
      }).ok,
    ).toBe(false);
  });

  it('14 — a duplicate id is refused rather than merged', async () => {
    const servers = store();
    await servers.add({ id: 'srv', displayName: 'One', url: 'https://a.test/mcp' });
    await expect(
      servers.add({ id: 'srv', displayName: 'Two', url: 'https://b.test/mcp' }),
    ).rejects.toThrow(/already exists/);
  });

  it('15 — an unusual method name is admitted; a long one is refused, not truncated', () => {
    const server = { id: 'srv', displayName: 'Server', url: 'https://example.test/mcp' };
    const { admitted, refused } = admitListing(server, [
      { name: 'search', inputSchema: schema },
      { name: 'a.b.c-d_e', inputSchema: schema },
      { name: 'b'.repeat(MAX_MCP_TOOL_NAME), inputSchema: schema },
      { name: 'b'.repeat(MAX_MCP_TOOL_NAME + 1), inputSchema: schema },
      { name: 'has space', inputSchema: schema },
      { name: 'has__separator', inputSchema: schema },
      { name: '', inputSchema: schema },
    ]);
    expect(admitted.map((entry) => entry.name)).toEqual([
      mcpToolName('srv', 'search'),
      mcpToolName('srv', 'a.b.c-d_e'),
      mcpToolName('srv', 'b'.repeat(MAX_MCP_TOOL_NAME)),
    ]);
    expect(refused).toHaveLength(4);
    // Every admitted name fits the field it is recorded in.
    for (const entry of admitted) expect(entry.name.length).toBeLessThanOrEqual(MAX_STRING);
  });

  it('16 — two long names that share a prefix stay two tools', () => {
    const server = { id: 'srv', displayName: 'Server', url: 'https://example.test/mcp' };
    const shared = 'c'.repeat(MAX_MCP_TOOL_NAME - 1);
    const { admitted, refused } = admitListing(server, [
      { name: `${shared}a`, inputSchema: schema },
      { name: `${shared}b`, inputSchema: schema },
    ]);
    // Truncation would have collapsed these into one. Both are kept, distinct.
    expect(refused).toEqual([]);
    expect(new Set(admitted.map((entry) => entry.name)).size).toBe(2);
  });

  it('17 — a duplicate derived name is refused once, keeping the first', () => {
    const server = { id: 'srv', displayName: 'Server', url: 'https://example.test/mcp' };
    const { admitted, refused } = admitListing(server, [
      { name: 'search', inputSchema: schema },
      { name: 'search', inputSchema: schema },
    ]);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
  });

  it('18 — removal and re-addition work, and the bound applies both times', async () => {
    const servers = store();
    const id = 'a'.repeat(MAX_MCP_SERVER_ID);
    await servers.add({ id, displayName: 'Server', url: 'https://example.test/mcp' });
    await servers.remove(id);
    expect(await servers.list()).toEqual([]);
    await expect(
      servers.add({ id, displayName: 'Server', url: 'https://example.test/mcp' }),
    ).resolves.toBeDefined();
    await expect(
      servers.add({
        id: 'a'.repeat(MAX_MCP_SERVER_ID + 1),
        displayName: 'Server',
        url: 'https://example.test/mcp',
      }),
    ).rejects.toThrow();
  });

  it('19 — a stored server survives a reload with its bounded id intact', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const id = 'a'.repeat(MAX_MCP_SERVER_ID);
    await new McpServerStore({ area }).add({
      id,
      displayName: 'Server',
      url: 'https://example.test/mcp',
    });
    // A second store over the same area is what a worker restart looks like.
    const reloaded = await new McpServerStore({ area }).list();
    expect(reloaded.map((record) => record.id)).toEqual([id]);
    expect(mcpToolName(reloaded[0]!.id, 'search').length).toBeLessThanOrEqual(MAX_STRING);
  });
});
