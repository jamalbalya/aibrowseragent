/**
 * TEST-TASK-003 — Task lifecycle: create, pause, resume, cancel, retry
 * (REQ-TASK-003).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
} from '@/storage/storage-area';
import { TaskStore } from '@/tasks/task-store';
import { TaskManager, TaskManagerError } from '@/background/task-manager';
import { AgentRuntime } from '@/agent/runtime/agent-runtime';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { isTerminal } from '@/tasks/task-model';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { fakeDebugger } from '../fixtures/fake-debugger';
import {
  FULL_CAPABILITIES,
  FakeProvider,
  textResponse,
  toolCallResponse,
} from '../fixtures/fake-provider';
import { createHarness, ScriptedPrompter } from '../fixtures/policy-harness';
import type { SemanticPage } from '@/content/semantic-tree';
import type * as MessagingBus from '@/messaging/bus';
import { FieldObservationStore } from '@/policy/field-observation-store';

vi.mock('@/messaging/bus', async (importOriginal) => {
  const actual = await importOriginal<typeof MessagingBus>();
  // The manager broadcasts to the side panel; there is none in a unit test.
  return { ...actual, broadcastEvent: vi.fn() };
});

const page: SemanticPage = {
  url: 'https://example.com/',
  title: 'Example',
  generation: 1,
  capturedAt: 1,
  readyState: 'complete',
  text: 'Hello',
  textTruncated: false,
  elements: [],
  elementsTruncated: false,
  fields: [],
  scrollY: 0,
  documentHeight: 100,
  viewportHeight: 100,
};

function build(script = [textResponse('Finished.')]) {
  const backing = new SerializedStorageArea(new MemoryStorageArea());
  const store = new TaskStore(new NamespacedStorageArea(backing, 'tasks'));

  const adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', active: true });
  adapter.onContent((type) => (type === 'content.readPage' ? { page } : {}));

  const harness = createHarness(
    createBrowserTools({
      fieldObservations: new FieldObservationStore(),
      adapter,
      debuggerManager: fakeDebugger().manager,
    }),
    {
      prompter: new ScriptedPrompter({ kind: 'approve_once' }),
    },
  );
  const provider = new FakeProvider(script);

  const manager = new TaskManager({
    store,
    resolveProvider: () =>
      Promise.resolve({
        adapter: provider,
        capabilities: FULL_CAPABILITIES,
        providerId: 'fake',
        modelId: 'fake-model',
      }),
    getPermissionMode: () => Promise.resolve('auto'),
    getActiveTabId: () => Promise.resolve(1),
  });
  manager.setRuntime(
    new AgentRuntime({ registry: harness.registry, callbacks: manager.createCallbacks() }),
  );

  return { manager, store, provider, adapter };
}

/** Polls until a task reaches a terminal state, or the attempt budget runs out. */
/**
 * Lets every already-scheduled continuation run.
 *
 * A paused task does not become terminal, so `settle()` cannot be used to wait
 * for it — it would spin to its attempt limit. What these tests need instead is
 * simply "let the aborted runtime finish unwinding", which is a bounded number
 * of microtask and timer turns.
 */
async function drain(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function settle(store: TaskStore, taskId: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    const task = await store.getTask(taskId);
    if (task && isTerminal(task.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let ctx: ReturnType<typeof build>;

beforeEach(() => {
  ctx = build();
});

describe('create', () => {
  it('persists the task immediately and runs it in the background', async () => {
    const task = await ctx.manager.create('Summarise the page', 's1');

    expect(task.state).toBe('QUEUED');
    expect(await ctx.store.getTask(task.id)).toBeDefined();

    await settle(ctx.store, task.id);
    expect((await ctx.store.getTask(task.id))?.state).toBe('COMPLETED');
  });

  it('rejects an empty objective', async () => {
    await expect(ctx.manager.create('   ', 's1')).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('records the result contract when it finishes', async () => {
    const task = await ctx.manager.create('Do the thing', 's1');
    await settle(ctx.store, task.id);

    const finished = await ctx.store.getTask(task.id);
    expect(finished?.result?.outcome).toBe('COMPLETED');
    expect(finished?.result?.summary).toBe('Finished.');
    expect(finished?.finishedAt).toBeDefined();
  });
});

describe('cancel', () => {
  it('moves the task to CANCELLED and stops it', async () => {
    ctx = build([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_read_page', {}, 'tc_2'),
      textResponse('done'),
    ]);
    const task = await ctx.manager.create('Long task', 's1');

    const state = await ctx.manager.cancel(task.id);

    expect(state).toBe('CANCELLED');
    expect((await ctx.store.getTask(task.id))?.state).toBe('CANCELLED');
    expect(ctx.manager.isRunning(task.id)).toBe(false);
  });

  it('is safe to call twice', async () => {
    const task = await ctx.manager.create('Task', 's1');
    await ctx.manager.cancel(task.id);
    await expect(ctx.manager.cancel(task.id)).resolves.toBe('CANCELLED');
  });
});

describe('pause and resume', () => {
  it('pauses a task and clears its run handle', async () => {
    ctx = build([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_read_page', {}, 'tc_2'),
      textResponse('done'),
    ]);
    const task = await ctx.manager.create('Long task', 's1');

    await ctx.manager.pause(task.id);

    expect(ctx.manager.isRunning(task.id)).toBe(false);
    expect((await ctx.store.getTask(task.id))?.state).toBe('PAUSED');
  });

  it('leaves the task paused once the aborted runtime has unwound', async () => {
    // This is the assertion the previous version of this suite was missing, and
    // the omission gave false confidence for a real production defect: the
    // check above reads the state at the instant `pause()` returns, and the
    // aborted runtime used to overwrite it with CANCELLED a moment later.
    //
    // So the state is read again after letting every pending continuation run.
    // Under the defect this fails; the state at the earlier instant does not.
    ctx = build([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_read_page', {}, 'tc_2'),
      textResponse('done'),
    ]);
    const task = await ctx.manager.create('Long task', 's1');

    await ctx.manager.pause(task.id);
    await drain();

    expect((await ctx.store.getTask(task.id))?.state).toBe('PAUSED');
  });

  it('resumes a paused task and lets it finish', async () => {
    ctx = build([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_read_page', {}, 'tc_2'),
      textResponse('done'),
    ]);
    const task = await ctx.manager.create('Long task', 's1');

    await ctx.manager.pause(task.id);
    await drain();
    expect(await ctx.manager.resume(task.id)).toBe('RUNNING');
    await settle(ctx.store, task.id);

    const finished = await ctx.store.getTask(task.id);
    expect(finished?.state).toBe('COMPLETED');
  });

  it('cancels a paused task, and a cancelled task cannot be resumed', async () => {
    ctx = build([toolCallResponse('browser_read_page', {}, 'tc_1'), textResponse('done')]);
    const task = await ctx.manager.create('Long task', 's1');

    await ctx.manager.pause(task.id);
    await drain();
    await expect(ctx.manager.cancel(task.id)).resolves.toBe('CANCELLED');
    await expect(ctx.manager.resume(task.id)).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('refuses to resume a task that already finished', async () => {
    const task = await ctx.manager.create('Quick task', 's1');
    await settle(ctx.store, task.id);

    await expect(ctx.manager.resume(task.id)).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('refuses to resume a task that does not exist', async () => {
    await expect(ctx.manager.resume('ghost')).rejects.toBeInstanceOf(TaskManagerError);
  });
});

describe('retry', () => {
  it('starts a fresh task with the same objective, leaving history intact', async () => {
    const original = await ctx.manager.create('Retry me', 's1');
    await settle(ctx.store, original.id);

    const retried = await ctx.manager.retry(original.id);

    expect(retried.id).not.toBe(original.id);
    expect(retried.objective).toBe('Retry me');
    // The original record is not rewritten.
    expect((await ctx.store.getTask(original.id))?.state).toBe('COMPLETED');
  });

  it('cancels a still-running task before retrying it', async () => {
    ctx = build([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_read_page', {}, 'tc_2'),
      textResponse('done'),
    ]);
    const original = await ctx.manager.create('Retry me', 's1');

    await ctx.manager.retry(original.id);

    expect((await ctx.store.getTask(original.id))?.state).toBe('CANCELLED');
  });

  it('refuses to retry a task that does not exist', async () => {
    await expect(ctx.manager.retry('ghost')).rejects.toBeInstanceOf(TaskManagerError);
  });
});

describe('provider unavailable', () => {
  it('surfaces the failure rather than falling back to another provider', async () => {
    const backing = new SerializedStorageArea(new MemoryStorageArea());
    const store = new TaskStore(new NamespacedStorageArea(backing, 'tasks'));
    const manager = new TaskManager({
      store,
      resolveProvider: () => Promise.reject(new Error('No AI provider is connected.')),
      getPermissionMode: () => Promise.resolve('auto'),
      getActiveTabId: () => Promise.resolve(undefined),
    });

    await expect(manager.create('Do something', 's1')).rejects.toThrow(/No AI provider/);
  });
});

describe('abortAll', () => {
  it('stops everything in flight', async () => {
    ctx = build([
      toolCallResponse('browser_read_page', {}, 'tc_1'),
      toolCallResponse('browser_read_page', {}, 'tc_2'),
      textResponse('done'),
    ]);
    const task = await ctx.manager.create('Long task', 's1');

    ctx.manager.abortAll();

    expect(ctx.manager.isRunning(task.id)).toBe(false);
  });
});

describe('state machine enforcement', () => {
  it('never leaves a task in a non-terminal state once it finishes', async () => {
    const task = await ctx.manager.create('Task', 's1');
    await settle(ctx.store, task.id);

    const finished = await ctx.store.getTask(task.id);
    expect(isTerminal(finished!.state)).toBe(true);
  });
});
