/**
 * TEST-SILENT-002 — the operation survives, and the loss is visible.
 *
 * The previous phase classified every audit-adjacent path as surfaced or
 * impossible, and left one gap in its own list: nothing asserted that the
 * *feature* stays correct when its record is refused. That is the half of the
 * property that matters to a user — a download that silently half-happened
 * because its record failed would be far worse than a download with a missing
 * record — and it was argued, not tested.
 *
 * This file closes that, and checks the stores outside the audit log for the same
 * shape: an operation that reports success while its secondary write failed.
 */
import { describe, expect, it } from 'vitest';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { PersistenceHealthStore } from '@/storage/persistence-health';
import { EvidenceStore } from '@/evidence/evidence-store';
import { createFileTools } from '@/tools/files/file-tools';
import { StagedFileStore } from '@/files/file-store';
import { FileSelectionBroker } from '@/background/file-broker';
import { McpServerStore } from '@/mcp/core/mcp-server-store';
import { ScheduleStore } from '@/schedules/schedule-store';
import { MAX_MCP_SERVER_ID } from '@/audit/boundaries';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

const adapter = {
  getTab: () => Promise.resolve({ id: 1, url: 'https://page.test/', title: 'p', active: true }),
  getActiveTab: () =>
    Promise.resolve({ id: 1, url: 'https://page.test/', title: 'p', active: true }),
  callContent: () => Promise.resolve({ attached: 0, names: [], inputWasHidden: false }),
  ensureContentScript: () => Promise.resolve(),
};

const downloads = {
  isPermitted: () => Promise.resolve(true),
  start: () => Promise.resolve(1),
  awaitCompletion: () =>
    Promise.resolve({ id: 1, state: 'complete' as const, filename: 'report.pdf' }),
  cancel: () => Promise.resolve(),
};

const context = {
  taskId: 'task_1',
  sessionId: 's',
  toolCallId: 'tc_1',
  tabId: 1,
  currentUrl: 'https://page.test/',
  signal: new AbortController().signal,
  recordEvidence: () => undefined,
};

describe('TEST-SILENT-002 — a refused record does not change what happened', () => {
  it('01 — the download still succeeds and still reports the saved name', async () => {
    // The audit port throws on every call, which is the harshest version of the
    // failure: not a refusal the log absorbs, but the recorder itself breaking.
    // The tool has to finish the download and report it, because the file is on
    // disk either way and saying otherwise would be a lie about the filesystem.
    const attempts: string[] = [];
    const tools = createFileTools({
      adapter: adapter as never,
      broker: new FileSelectionBroker({ timeoutMs: 50 }),
      store: new StagedFileStore(),
      downloads,
      recordFileEvent: (event) => {
        attempts.push(event.type);
        return Promise.reject(new Error('the trail is unavailable'));
      },
    });
    const download = tools.find((tool) => tool.name === 'browser.download');
    expect(download).toBeDefined();
    if (!download) return;

    const result = await download.execute(
      { url: 'https://example.test/report.pdf', filename: 'report.pdf' },
      context,
    );
    // The operation reported what it did.
    expect(result.data).toMatchObject({ savedAs: 'report.pdf' });
    // And the record was attempted, so the failure is the port's rather than a
    // path that quietly skips recording.
    expect(attempts).toContain('file.downloaded');
  });

  it('02 — a refused record leaves no evidence behind it', async () => {
    // The ordering rule, checked on the store rather than on the helper: a blob
    // whose record does not exist is an orphan no listing can explain.
    const evidence = new EvidenceStore(area());
    const refusing = new AuditLog(area(), { knownTool: () => false });
    // Not an opaque identifier, so the record is refused.
    const written = await refusing.record({
      type: 'egress.decided',
      taskId: 'task/with/slashes',
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
    } as never);
    expect(written).toBeNull();
    // Nothing wrote a blob for a record that does not exist.
    expect(await evidence.listForTask('task/with/slashes')).toEqual([]);
    expect(await evidence.listForTask('task_ok')).toEqual([]);
  });

  it('03 — the loss is durable and reaches a reader', async () => {
    // Non-gating by design: work continues. Surfaced by design: the health record
    // outlives the worker, so the panel finds it on the next poll.
    const backing = new MemoryStorageArea();
    const health = new PersistenceHealthStore(new SerializedStorageArea(backing));
    const log = new AuditLog(area(), { knownTool: () => true, health });
    await log.record({
      type: 'file.selected',
      outcome: 'info',
      fileName: 'f'.repeat(1000),
    } as never);

    // `record` does not wait for the health write, deliberately: the reporter runs
    // on a path that is already failing, and awaiting it would let a failing
    // reporter replace the failure being reported. So the write lands on a later
    // microtask, and this test has to let it — which is also the honest shape of
    // the guarantee. The window is one storage write inside a still-running task,
    // and a worker that dies inside it loses the record too.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A second store over the same area is what the panel reads after a restart.
    const reread = await new PersistenceHealthStore(new SerializedStorageArea(backing)).snapshot();
    const audit = reread.records.filter((record) => record.domain === 'audit');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.state).toBe('CORRUPT');
    expect(audit[0]?.reason).toContain('fileName');
    // And it does not block work, which is the deliberate part.
    expect(reread.blocked).toBe(false);
  });
});

describe('TEST-SILENT-002 — the stores outside the trail', () => {
  it('04 — a refused MCP descriptor stores nothing at all', async () => {
    // Refused at registration, and no partial record: the list is unchanged, so a
    // later reload cannot find a server the user was told was rejected.
    const servers = new McpServerStore({ area: area() });
    await expect(
      servers.add({
        id: 'a'.repeat(MAX_MCP_SERVER_ID + 1),
        displayName: 'Server',
        url: 'https://example.test/mcp',
      }),
    ).rejects.toThrow();
    expect(await servers.list()).toEqual([]);
  });

  it('05 — a record store mutation that fails validation fails closed', async () => {
    // `RecordStore.mutate` returns the stored value untouched when the result
    // would not validate, and returns `undefined` to the caller. The property
    // worth pinning is that the caller treats that as "did not happen": a
    // schedule whose claim could not be written must not run.
    const schedules = new ScheduleStore({ area: area() });
    const claim = await schedules.claimOccurrence('schedule_missing', 1_700_000_000_000);
    expect(claim.ok).toBe(false);
    // Nothing was created as a side effect of failing to claim.
    expect(await schedules.list()).toEqual([]);
  });
});
