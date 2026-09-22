/**
 * TEST-SECURITY-030 — the upload and download lifecycle (P-011).
 *
 * Upload is the one path where the extension holds bytes a person handed it
 * from their own machine. The interesting failures are not about getting the
 * file in — that part works — but about what happens around it: a request
 * nobody answers, a task that ends while a picker is open, a file that
 * outlives the work it was chosen for, one task reaching another's selection.
 *
 * The defect this wave fixed is the third. Cancelling a task freed its staged
 * files from the start, and the handler said why: a cancelled task must not
 * leave the user's file sitting in memory. A task that *completed* did not —
 * so a file outlived its purpose until the service worker happened to be
 * evicted, which in MV3 is minutes but is not a guarantee and is not a
 * decision anybody made.
 *
 * Download is a different shape and is audited rather than re-implemented:
 * the browser does the downloading, the extension chooses a filename, and the
 * filename rules are already covered by `file-model.test.ts`. What is here is
 * the boundary between what the code does and what the environment does.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileSelectionBroker } from '@/background/file-broker';
import { StagedFileStore } from '@/files/file-store';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const root = resolve(import.meta.dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

const stage = (store: StagedFileStore, taskId: string, name: string) =>
  store.stage({
    taskId,
    name,
    mimeType: 'text/plain',
    dataBase64: Buffer.from('contents').toString('base64'),
    byteLength: 8,
    origin: 'local',
    source: 'local_selection',
    sensitivity: 'confidential',
  });

describe('a file request that nobody answers', () => {
  it('resolves as cancelled, never as a selection', async () => {
    vi.useFakeTimers();
    const broker = new FileSelectionBroker({ timeoutMs: 1000 });
    const pending = broker.request({
      taskId: 'task_1',
      purpose: 'upload a report',
      multiple: false,
    });
    vi.advanceTimersByTime(1001);
    const response = await pending;
    expect(response.kind).toBe('cancelled');
    vi.useRealTimers();
  });

  it('stops being pending once it has expired', async () => {
    vi.useFakeTimers();
    const broker = new FileSelectionBroker({ timeoutMs: 1000 });
    const pending = broker.request({ taskId: 'task_1', purpose: 'x', multiple: false });
    expect(broker.listPending()).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    await pending;
    expect(broker.listPending()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('refuses a second answer to a request that already settled', async () => {
    const broker = new FileSelectionBroker({ timeoutMs: 60_000 });
    const pending = broker.request({ taskId: 'task_1', purpose: 'x', multiple: false });
    expect(broker.respond(broker.listPending()[0]!.id, { kind: 'cancelled' })).toBe(true);
    await pending;
    // A stale answer changes nothing. The panel can legitimately answer twice
    // after a reload, so this is reported rather than thrown.
    expect(broker.respond('filereq_gone', { kind: 'selected', files: [] })).toBe(false);
  });

  it('never carries a path, because the request has nowhere to put one', () => {
    // The shape of the request is the control: a model asking for
    // `/Users/someone/.ssh/id_rsa` cannot express it here.
    const source = read('src/background/file-broker.ts');
    const shape = source.slice(
      source.indexOf('export interface FileSelectionRequest'),
      source.indexOf('export interface SelectedFilePayload'),
    );
    for (const forbidden of ['path', 'directory', 'filename']) {
      expect(shape.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

describe('a task that ends does not leave its file behind', () => {
  it('frees staged files for that task and no other', () => {
    const store = new StagedFileStore();
    const mine = stage(store, 'task_1', 'report.pdf');
    const theirs = stage(store, 'task_2', 'other.pdf');
    store.clearTask('task_1');
    expect(store.get('task_1', mine.id)).toBeUndefined();
    expect(store.get('task_2', theirs.id)).toBeDefined();
  });

  it('cancels a pending request for that task and no other', () => {
    const broker = new FileSelectionBroker({ timeoutMs: 60_000 });
    void broker.request({ taskId: 'task_1', purpose: 'x', multiple: false });
    void broker.request({ taskId: 'task_2', purpose: 'y', multiple: false });
    broker.cancelForTask('task_1');
    expect(broker.listPending().map((request) => request.taskId)).toEqual(['task_2']);
  });

  it('runs the cleanup on every terminal state, not only on cancel', () => {
    // The fix. `kind: 'completed'` is emitted for any terminal transition, so
    // hooking it once covers completing, failing, being blocked and being
    // cancelled — rather than the three exits each remembering separately.
    const worker = read('src/background/service-worker.ts');
    const lifecycle = worker.slice(
      worker.indexOf('onLifecycle: (event) => {'),
      worker.indexOf('taskManager.setRuntime('),
    );
    // The guard itself, with its `if (`. Matching the bare condition would
    // also match the audit record's own `event.kind === 'completed'` three
    // lines below, which is how an earlier version of this passed while the
    // guard had been replaced by `if (false)`.
    const guard = lifecycle.indexOf("if (event.kind === 'completed') {");
    expect(guard).toBeGreaterThan(-1);
    // And the cleanup sits inside it, not merely somewhere in the file.
    expect(lifecycle.indexOf('stagedFiles.clearTask(event.taskId)')).toBeGreaterThan(guard);
    expect(lifecycle.indexOf('fileSelectionBroker.cancelForTask(event.taskId')).toBeGreaterThan(
      guard,
    );

    const manager = read('src/background/task-manager.ts');
    expect(manager).toContain("kind: isTerminal(next) ? 'completed' : 'state'");
  });

  it('still frees them on an explicit cancel, before anything else settles', () => {
    const worker = read('src/background/service-worker.ts');
    const handler = worker.slice(
      worker.indexOf("router.on('task.cancel'"),
      worker.indexOf("router.on('task.retry'"),
    );
    // Kept as well as the lifecycle hook: cancel denies pending permissions
    // first, and that ordering is the point of having it here too.
    expect(handler).toContain('permissionBroker.denyForTask');
    expect(handler).toContain('stagedFiles.clearTask');
  });
});

describe('one task cannot reach another task’s selection', () => {
  it('scopes a lookup by task, not only by an unguessable id', () => {
    const store = new StagedFileStore();
    const theirs = stage(store, 'task_2', 'private.pdf');
    // Holding the id is not enough. Scoping by task makes this a matter of
    // not being able to rather than of not guessing.
    expect(store.get('task_1', theirs.id)).toBeUndefined();
    expect(store.get('task_2', theirs.id)).toBeDefined();
  });

  it('keeps the bytes out of the record a model can see', () => {
    const store = new StagedFileStore();
    const record = stage(store, 'task_1', 'report.pdf');
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain(Buffer.from('contents').toString('base64'));
  });

  it('reports a basename, because a picker gives nothing else', () => {
    const tools = read('src/tools/files/file-tools.ts');
    expect(tools).toContain('safeDisplayName(file.name)');
    expect(tools).toContain("origin: 'local'");
    // Stated in the code as well: there is no directory to record.
    expect(tools).toContain('directory to record');
  });
});

describe('what the environment decides rather than the code', () => {
  it('leaves the download itself to the browser', () => {
    // A. implementation: filename validation, conflict handling, audit.
    // B. environment: whether a download can happen at all.
    const tools = read('src/tools/files/file-tools.ts');
    expect(tools).toContain('checkDownloadFilename');
    // The port is where the browser is actually asked, and where nothing is
    // ever overwritten.
    expect(read('src/files/download-port.ts')).toContain("conflictAction: 'uniquify'");
    // No filesystem primitive of its own: the browser downloads, this only
    // asks it to.
    for (const file of ['src/tools/files/file-tools.ts', 'src/files/download-port.ts']) {
      for (const forbidden of ['writeFile', 'FileSystemHandle', 'showSaveFilePicker']) {
        expect(read(file), `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('refuses cleanly when the optional permission is absent', () => {
    // D. capability requiring a permission. `downloads` is optional and is
    // granted by a person from Settings under their own gesture, which a
    // headless profile cannot produce — so the granted path is covered in
    // unit and integration tests and the refusal is what runs in a browser.
    const tools = read('src/tools/files/file-tools.ts');
    expect(tools).toContain('isPermitted');
    const manifest = JSON.parse(read('public/manifest.json')) as {
      optional_permissions: string[];
      permissions: string[];
    };
    expect(manifest.optional_permissions).toContain('downloads');
    expect(manifest.permissions).not.toContain('downloads');
  });

  it('declares the download URL as an egress, in the outbound direction too', () => {
    // C. capability requiring user interaction is the selection; the download
    // is a transfer, and a URL carries whatever was put in its query string.
    const tools = read('src/tools/files/file-tools.ts');
    const handler = tools.slice(tools.indexOf("name: 'browser.download'"));
    expect(handler).toContain("urlDestination('download'");
    expect(handler).toContain('payload: input.url');
  });
});
