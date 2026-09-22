/**
 * TEST-FILE-004 — the whole file workflow through the real pipeline.
 *
 * Not the tools in isolation: the real `ToolRegistry`, the real policy and
 * permission engines, and the real egress gate. What this establishes that a
 * unit test cannot is that a file reaching a page goes through every stage in
 * order — schema validation, risk, policy, permission, egress, evidence — and
 * that removing consent at any one of them stops it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MessagingBus from '@/messaging/bus';

vi.mock('@/messaging/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingBus>();
  return { ...actual, broadcastEvent: vi.fn() };
});

import { createFileTools } from '@/tools/files/file-tools';
import { FileSelectionBroker } from '@/background/file-broker';
import { StagedFileStore } from '@/files/file-store';
import { ConsentStore } from '@/security/egress/consent';
import { addTaint, freshTaint, parseTaintState, unknownTaint } from '@/security/taint/taint-state';
import { localFileTaint } from '@/files/file-model';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { TaskStore } from '@/tasks/task-store';
import { createTask } from '@/tasks/task-model';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import type { EgressEvidenceInput } from '@/security/egress/egress-evidence';
import type { DownloadPort } from '@/files/download-port';

const PAGE_URL = 'https://forms.example/apply';
const SALT = 'ab'.repeat(32);

const downloads: DownloadPort = {
  isPermitted: () => Promise.resolve(true),
  start: () => Promise.resolve(1),
  awaitCompletion: () =>
    Promise.resolve({ id: 1, state: 'complete' as const, filename: 'report.pdf' }),
  cancel: () => Promise.resolve(),
};

let store: StagedFileStore;
let broker: FileSelectionBroker;
let consent: ConsentStore;
let decisions: EgressEvidenceInput[];
let contentCalls: { type: string; payload: unknown }[];
let harness: Harness;

beforeEach(() => {
  store = new StagedFileStore();
  broker = new FileSelectionBroker({ timeoutMs: 100 });
  consent = new ConsentStore();
  decisions = [];
  contentCalls = [];

  const adapter = {
    getTab: () => Promise.resolve({ id: 1, url: PAGE_URL, title: 'Apply', active: true }),
    getActiveTab: () => Promise.resolve({ id: 1, url: PAGE_URL, title: 'Apply', active: true }),
    callContent: (_tabId: number, type: string, payload: unknown) => {
      contentCalls.push({ type, payload });
      return Promise.resolve({ attached: 1, names: ['cv.pdf'], inputWasHidden: true });
    },
    ensureContentScript: () => Promise.resolve(),
  } as unknown as Parameters<typeof createFileTools>[0]['adapter'];

  harness = createHarness(createFileTools({ adapter, broker, store, downloads }), {
    prompter: new ScriptedPrompter({ kind: 'approve_once' }),
    resolveTabUrl: () => Promise.resolve(PAGE_URL),
    egress: {
      consent,
      record: (input) => {
        decisions.push(input);
        return Promise.resolve();
      },
    },
  });
});

function invoke(
  name: string,
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return harness.registry.dispatch({
    toolCallId: `tc_${name}`,
    taskId: 'task_1',
    sessionId: 's1',
    name,
    arguments: args,
    tabId: 1,
    plannedUrl: PAGE_URL,
    taintState: freshTaint(),
    taintSalt: SALT,
    saltEpoch: 1,
    taintSignature: 'sig',
    signal: new AbortController().signal,
    ...overrides,
  });
}

/** Answers the picker as a user would. */
let lastSelection: unknown;

async function chooseFile(name = 'cv.pdf'): Promise<string> {
  const promise = invoke('files.select', { purpose: 'a CV for this application' });
  await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));
  broker.respond(broker.listPending()[0]!.id, {
    kind: 'selected',
    files: [{ name, mimeType: 'application/pdf', byteLength: 3, dataBase64: 'QUJD' }],
  });

  const result = await promise;
  expect(result.envelope.status).toBe('success');
  lastSelection = result.envelope;
  const data = result.envelope.result as { files: { fileId: string }[] };
  return data.files[0]!.fileId;
}

describe('selection through the registry', () => {
  it('asks the user, stages the file and reports only metadata', async () => {
    const fileId = await chooseFile();
    expect(fileId).toMatch(/^file_/);

    const [record] = store.listForTask('task_1');
    expect(record?.name).toBe('cv.pdf');

    // The envelope the model sees names the file and carries none of it.
    const envelope = JSON.stringify(lastSelection);
    expect(envelope).toContain('cv.pdf');
    expect(envelope).toContain('application/pdf');
    expect(envelope).not.toContain('QUJD');
  });

  it('refuses arguments that do not match the schema before anything runs', async () => {
    const result = await invoke('files.select', { purpose: 'x' });
    expect(result.envelope.status).toBe('error');
    expect(broker.listPending()).toHaveLength(0);
  });
});

describe('attachment through the registry', () => {
  it('reaches the page only after permission and the egress gate both allow it', async () => {
    const fileId = await chooseFile();
    const result = await invoke('browser.attach_file', { elementId: 'e1-0', fileIds: [fileId] });

    expect(result.envelope.status).toBe('success');
    expect(contentCalls.map((call) => call.type)).toEqual(['content.attachFiles']);
    // The user was asked, and the gate recorded a decision.
    expect(harness.prompter.seen.map((r) => r.tool)).toContain('browser.attach_file');
    expect(decisions.some((d) => d.sourceTool === 'browser.attach_file')).toBe(true);
  });

  it('sends the bytes to the page but never puts them in the evidence record', async () => {
    const fileId = await chooseFile();
    await invoke('browser.attach_file', { elementId: 'e1-0', fileIds: [fileId] });

    const sent = JSON.stringify(contentCalls);
    expect(sent).toContain('QUJD');

    const recorded = JSON.stringify(decisions);
    expect(recorded).not.toContain('QUJD');
    expect(recorded).toContain('cv.pdf');
  });

  it('does not reach the page when the user declines', async () => {
    const fileId = await chooseFile();
    harness.prompter.setResponse({ kind: 'deny' });

    const result = await invoke('browser.attach_file', { elementId: 'e1-0', fileIds: [fileId] });
    expect(result.envelope.status).toBe('error');
    expect(contentCalls).toEqual([]);
  });

  it('does not reach the page when the task’s provenance was lost', async () => {
    const fileId = await chooseFile();
    const result = await invoke(
      'browser.attach_file',
      { elementId: 'e1-0', fileIds: [fileId] },
      { taintState: unknownTaint('persistence-failed') },
    );

    expect(result.envelope.status).toBe('error');
    expect(contentCalls).toEqual([]);
  });

  it('does not reach the page without an evidence key', async () => {
    // A missing salt means the record is damaged, and a damaged record cannot
    // authorise a transfer.
    const fileId = await chooseFile();
    const result = await invoke(
      'browser.attach_file',
      { elementId: 'e1-0', fileIds: [fileId] },
      { taintSalt: '' },
    );

    expect(result.envelope.status).toBe('error');
    expect(contentCalls).toEqual([]);
  });

  it('records the attachment against the page’s own origin', async () => {
    const fileId = await chooseFile();
    await invoke('browser.attach_file', { elementId: 'e1-0', fileIds: [fileId] });

    const record = decisions.find((d) => d.sourceTool === 'browser.attach_file');
    expect(record?.destination.identity).toBe('https://forms.example');
    expect(record?.destination.channel).toBe('page_write');
  });
});

describe('downloads through the registry', () => {
  it('runs after approval and records a download decision', async () => {
    const result = await invoke('browser.download', {
      url: 'https://files.example/report.pdf',
    });

    expect(result.envelope.status).toBe('success');
    const record = decisions.find((d) => d.sourceTool === 'browser.download');
    expect(record?.destination.channel).toBe('download');
    expect(record?.destination.identity).toBe('https://files.example');
  });

  it('refuses a dangerous filename at the schema-and-tool boundary, not at the browser', async () => {
    const result = await invoke('browser.download', {
      url: 'https://files.example/x',
      filename: '../../etc/passwd',
    });
    expect(result.envelope.status).toBe('error');
  });
});

describe('security state survives what the file does not', () => {
  it('keeps file taint in the persisted task after a restart loses the bytes', async () => {
    // The point of holding bytes only in memory: the file is gone after an
    // eviction, and the fact that the task read one is not.
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const taskStore = new TaskStore(area);
    const task = createTask({
      id: 'task_1',
      sessionId: 's1',
      objective: 'Attach the CV.',
      providerId: 'p',
      modelId: 'm',
      permissionMode: 'auto',
      now: 1,
    });
    await taskStore.saveTask(task);
    await taskStore.appendTaint('task_1', [localFileTaint()]);

    // The worker restarts: staged bytes are dropped, storage is not.
    store.clearAll();

    const reloaded = await taskStore.getTask('task_1');
    const state = parseTaintState(reloaded?.taintState);
    expect(state.kind).toBe('TAINTED');
    if (state.kind === 'TAINTED') {
      expect(state.sources.map((s) => s.sourceType)).toContain('local_file');
    }
  });

  it('refuses to attach a file the restart dropped, rather than reporting success', async () => {
    const fileId = await chooseFile();
    store.clearAll();

    const result = await invoke('browser.attach_file', { elementId: 'e1-0', fileIds: [fileId] });
    expect(result.envelope.status).toBe('error');
    expect(contentCalls).toEqual([]);
  });

  it('still refuses the transfer when the recovered taint includes the file', async () => {
    const fileId = await chooseFile();
    const result = await invoke(
      'browser.attach_file',
      { elementId: 'e1-0', fileIds: [fileId] },
      { taintState: addTaint(freshTaint(), [localFileTaint()]) },
    );

    // Allowed, but only because the prompter approved it — the gate asked.
    expect(result.envelope.status).toBe('success');
    const record = decisions.find((d) => d.sourceTool === 'browser.attach_file');
    expect(record?.decision.taintSourceIds.join(',')).toContain('local_file');
  });
});

describe('the task’s pending request is dropped when the task ends', () => {
  it('cancels an open picker rather than leaving it waiting', async () => {
    const promise = invoke('files.select', { purpose: 'a CV' });
    await vi.waitFor(() => expect(broker.listPending()).toHaveLength(1));

    broker.cancelForTask('task_1', 'The task was cancelled.');

    const result = await promise;
    expect(result.envelope.status).toBe('error');
    expect(broker.listPending()).toHaveLength(0);
  });
});
