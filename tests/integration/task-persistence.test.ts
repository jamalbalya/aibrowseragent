/**
 * TEST-TASK-002 — Persistence and MV3 restart recovery (REQ-TASK-002).
 *
 * MV3 service workers are evicted without warning. These tests simulate that
 * by discarding every in-memory object and rebuilding the stores over the same
 * backing storage, which is exactly what a worker restart does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageArea,
  SerializedStorageArea,
  NamespacedStorageArea,
} from '@/storage/storage-area';
import { TaskStore } from '@/tasks/task-store';
import { LifecycleManager } from '@/background/lifecycle-manager';
import { DebuggerManager } from '@/tools/debugger/debugger-manager';
import { createTask, type AgentTask, type TaskState } from '@/tasks/task-model';
import { FieldObservationStore } from '@/policy/field-observation-store';

const backing = { area: new MemoryStorageArea() };

/** Builds fresh stores over the same storage, as a worker restart would. */
function newWorkerGeneration(): { store: TaskStore; lifecycle: LifecycleManager } {
  const area = new NamespacedStorageArea(new SerializedStorageArea(backing.area), 'tasks');
  const store = new TaskStore(area);
  const lifecycle = new LifecycleManager({
    fieldObservations: new FieldObservationStore(),
    store,
    debuggerManager: new DebuggerManager({
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      sendCommand: () => Promise.resolve({}),
      onEvent: { addListener: () => undefined, removeListener: () => undefined },
      onDetach: { addListener: () => undefined, removeListener: () => undefined },
    }),
  });
  return { store, lifecycle };
}

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  ...createTask({
    id: 'task_1',
    sessionId: 's1',
    objective: 'Summarise the page',
    providerId: 'fake',
    modelId: 'm',
    permissionMode: 'auto',
    now: 1000,
  }),
  ...overrides,
});

beforeEach(() => {
  backing.area = new MemoryStorageArea();
});

describe('persistence across a worker restart', () => {
  it('recovers a stored task in a new worker generation', async () => {
    const first = newWorkerGeneration();
    await first.store.saveTask(task({ state: 'RUNNING' }));

    // Everything in memory is gone.
    const second = newWorkerGeneration();
    const recovered = await second.store.getTask('task_1');

    expect(recovered?.objective).toBe('Summarise the page');
    expect(recovered?.state).toBe('RUNNING');
  });

  it('parks an interrupted task instead of resuming it blind', async () => {
    const first = newWorkerGeneration();
    await first.store.saveTask(task({ state: 'RUNNING' }));

    const second = newWorkerGeneration();
    const report = await second.lifecycle.recoverInterruptedTasks();

    expect(report.recovered).toBe(1);
    const recovered = await second.store.getTask('task_1');
    expect(recovered?.state).toBe('PAUSED');
    // The user is told why, so a paused task is not a mystery.
    expect(recovered?.currentStepSummary).toContain('restarted');
  });

  it('does not disturb tasks that already finished', async () => {
    const first = newWorkerGeneration();
    for (const state of ['COMPLETED', 'FAILED', 'CANCELLED'] as TaskState[]) {
      await first.store.saveTask(task({ id: `task_${state}`, state }));
    }

    const second = newWorkerGeneration();
    const report = await second.lifecycle.recoverInterruptedTasks();

    expect(report.recovered).toBe(0);
    expect((await second.store.getTask('task_COMPLETED'))?.state).toBe('COMPLETED');
  });

  it('is idempotent across repeated restarts', async () => {
    const first = newWorkerGeneration();
    await first.store.saveTask(task({ state: 'RUNNING' }));

    await newWorkerGeneration().lifecycle.recoverInterruptedTasks();
    const third = newWorkerGeneration();
    const report = await third.lifecycle.recoverInterruptedTasks();

    // Already PAUSED, so there is nothing more to recover.
    expect(report.recovered).toBe(0);
    expect((await third.store.getTask('task_1'))?.state).toBe('PAUSED');
  });
});

describe('TaskStore', () => {
  it('lists tasks newest first', async () => {
    const { store } = newWorkerGeneration();
    await store.saveTask(task({ id: 'a' }));
    await store.saveTask(task({ id: 'b' }));
    await store.saveTask(task({ id: 'c' }));

    expect((await store.listTasks()).map((t) => t.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not duplicate an index entry when a task is saved twice', async () => {
    const { store } = newWorkerGeneration();
    await store.saveTask(task({ id: 'a' }));
    await store.saveTask(task({ id: 'a', state: 'PLANNING' }));

    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.state).toBe('PLANNING');
  });

  it('applies concurrent updates without losing any of them', async () => {
    const { store } = newWorkerGeneration();
    await store.saveTask(task());

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.updateTask('task_1', (current) => ({
          ...current,
          steps: [
            ...current.steps,
            {
              id: `step_${i}`,
              index: i,
              kind: 'tool_call' as const,
              summary: `step ${i}`,
              status: 'success' as const,
              startedAt: i,
            },
          ],
        })),
      ),
    );

    expect((await store.getTask('task_1'))?.steps).toHaveLength(20);
  });

  it('returns undefined when updating a task that does not exist', async () => {
    const { store } = newWorkerGeneration();
    expect(await store.updateTask('ghost', (t) => t)).toBeUndefined();
  });

  it('evicts completed tasks past the retention cap but keeps live ones', async () => {
    const area = new NamespacedStorageArea(new SerializedStorageArea(backing.area), 'tasks');
    const store = new TaskStore(area, { maxTasks: 3 });

    await store.saveTask(task({ id: 'old-live', state: 'PAUSED' }));
    for (let i = 0; i < 5; i += 1) {
      await store.saveTask(task({ id: `done-${i}`, state: 'COMPLETED' }));
    }

    // The live task must survive even though it is the oldest.
    expect(await store.getTask('old-live')).toBeDefined();
    expect((await store.listTasks(50)).length).toBeLessThanOrEqual(4);
  });

  it('lists only interrupted tasks', async () => {
    const { store } = newWorkerGeneration();
    await store.saveTask(task({ id: 'live', state: 'RUNNING' }));
    await store.saveTask(task({ id: 'done', state: 'COMPLETED' }));

    expect((await store.listInterrupted()).map((t) => t.id)).toEqual(['live']);
  });

  it('persists and lists sessions', async () => {
    const { store } = newWorkerGeneration();
    await store.saveSession({
      id: 's1',
      providerId: 'fake',
      modelId: 'm',
      permissionMode: 'auto',
      createdAt: 1,
      lastActiveAt: 1,
    });

    expect((await store.getSession('s1'))?.providerId).toBe('fake');
    expect(await store.listSessions()).toHaveLength(1);
  });

  it('deletes a task and removes it from the index', async () => {
    const { store } = newWorkerGeneration();
    await store.saveTask(task());
    await store.deleteTask('task_1');

    expect(await store.getTask('task_1')).toBeUndefined();
    expect(await store.listTasks()).toEqual([]);
  });
});
