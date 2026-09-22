/**
 * TEST-SECURITY-027 — persistence failure cannot become silent recovery (D-3).
 *
 * The failure this wave exists for is specific and quiet: a task's security
 * state — its taint, its salt, what it has already read — lives in one place,
 * a write to that place fails, and within minutes MV3 evicts the worker that
 * noticed. What comes back afterwards is a task that looks fine, because the
 * only record that it was not fine was in the memory of a worker that no
 * longer exists.
 *
 * Three claims, and each case below is named for what it would allow if the
 * claim were false:
 *
 *  1. **A failure is written down.** It survives the worker, so the next one
 *     inherits the knowledge rather than a clean slate.
 *  2. **Nothing recovers on its own.** Severity only rises; a later
 *     successful write does not mean the earlier loss did not happen; only a
 *     person, explicitly, lowers it.
 *  3. **Degraded security state stops work, and a degraded audit trail does
 *     not.** Those are opposite requirements and they are held apart on
 *     purpose: a task whose taint is unknown must not run, and a gap in the
 *     record of an execution that already happened must not become a stopped
 *     execution.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { PersistenceHealthStore } from '@/storage/persistence-health';
import { TaskStore, hasUsableSecurityState } from '@/tasks/task-store';
import { AuditLog } from '@/audit/audit-log';
import { TaskManager, TaskManagerError } from '@/background/task-manager';
import { createTask, generateTaintSalt } from '@/tasks/task-model';
import { UNKNOWN_CAPABILITIES } from '@/providers/core/types';
import type { AIProviderAdapter } from '@/providers/core/types';

beforeAll(() => {
  // Starting a task broadcasts, and a broadcast needs `chrome.runtime`.
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const root = resolve(import.meta.dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

/** A provider that is never actually reached: every case below stops first. */
const stubProvider = {
  adapter: { id: 'stub' } as unknown as AIProviderAdapter,
  capabilities: UNKNOWN_CAPABILITIES,
  providerId: 'stub',
  modelId: 'stub-model',
};

function managerOver(health: PersistenceHealthStore, store: TaskStore): TaskManager {
  return new TaskManager({
    store,
    health,
    resolveProvider: () => Promise.resolve(stubProvider),
    getPermissionMode: () => Promise.resolve('manual'),
    getActiveTabId: () => Promise.resolve(undefined),
  });
}

function world() {
  const backing = new MemoryStorageArea();
  const area = new SerializedStorageArea(backing);
  const health = new PersistenceHealthStore(area);
  const store = new TaskStore(area, { health });
  return { backing, area, health, store, manager: managerOver(health, store) };
}

describe('1. a persistence failure is written down', () => {
  it('records a failed task write where the worker cannot take it with it', async () => {
    const { backing, store, health } = world();
    backing.set = () => Promise.reject(new Error('quota'));

    await expect(
      store.saveTask(
        createTask({
          id: 'task_1',
          sessionId: 's',
          objective: 'x',
          providerId: 'p',
          modelId: 'm',
          permissionMode: 'manual',
          now: 1,
        }),
      ),
    ).rejects.toThrow();

    // The floor holds even though the marker could not be written either.
    expect((await health.snapshot()).blocked).toBe(true);
  });

  it('records a task that came back without usable security state', async () => {
    const { area, store, health } = world();
    // What a partially-written or truncated record looks like on the way back.
    await area.set('task:task_2', {
      id: 'task_2',
      sessionId: 's',
      objective: 'x',
      state: 'RUNNING',
      taintSalt: '',
      saltEpoch: 0,
    });

    const task = await store.getTask('task_2');
    expect(task).toBeDefined();
    expect(hasUsableSecurityState(task!)).toBe(false);
    await vi.waitFor(async () => {
      expect((await health.snapshot()).gating).toBe('CORRUPT');
    });
  });

  it('survives a fresh store over the same storage, as a restart would', async () => {
    const { area, health } = world();
    await health.report('task-security', 'DEGRADED', 'a write did not land');
    const afterRestart = new PersistenceHealthStore(area);
    expect((await afterRestart.snapshot()).blocked).toBe(true);
  });
});

describe('2. nothing recovers on its own', () => {
  it('does not clear when a later write succeeds', async () => {
    const { area, store, health } = world();
    await health.report('task-security', 'DEGRADED', 'a write did not land');
    await store.saveTask(
      createTask({
        id: 'task_3',
        sessionId: 's',
        objective: 'x',
        providerId: 'p',
        modelId: 'm',
        permissionMode: 'manual',
        now: 1,
      }),
    );
    expect((await new PersistenceHealthStore(area).snapshot()).blocked).toBe(true);
  });

  it('cannot be lowered by a report, only by an acknowledgement', async () => {
    const { health } = world();
    await health.report('task-security', 'CORRUPT', 'a record did not parse');
    await health.report('task-security', 'HEALTHY', 'pretend it is fine');
    expect((await health.snapshot()).gating).toBe('CORRUPT');
    await health.acknowledge('task-security');
    expect((await health.snapshot()).blocked).toBe(false);
  });

  it('has no code path from a failure handler to an acknowledgement', () => {
    // The one rule that keeps the ladder monotone in practice rather than in
    // principle: nothing that notices a failure may also clear it.
    for (const file of [
      'src/tasks/task-store.ts',
      'src/audit/audit-log.ts',
      'src/background/task-manager.ts',
    ]) {
      expect(read(file), `${file} clears health`).not.toContain('acknowledge');
    }
  });
});

describe('3a. degraded security state stops work', () => {
  it('refuses to start a task', async () => {
    const { manager, health } = world();
    await health.report('task-security', 'DEGRADED', 'a write did not land');
    await expect(manager.create('do something', 'session_1')).rejects.toBeInstanceOf(
      TaskManagerError,
    );
  });

  it('refuses to resume a task', async () => {
    const { manager, store, health } = world();
    await store.saveTask({
      ...createTask({
        id: 'task_4',
        sessionId: 's',
        objective: 'x',
        providerId: 'p',
        modelId: 'm',
        permissionMode: 'manual',
        now: 1,
      }),
      taintSalt: generateTaintSalt(),
      state: 'PAUSED',
    });
    await health.report('task-security', 'CORRUPT', 'a record did not parse');
    await expect(manager.resume('task_4')).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('refuses to retry a task', async () => {
    const { manager, health } = world();
    await health.report('storage', 'IRRECOVERABLE', 'storage is gone');
    await expect(manager.retry('task_4')).rejects.toBeInstanceOf(TaskManagerError);
  });

  it('refuses before it reaches the provider, so nothing is resolved first', async () => {
    const backing = new MemoryStorageArea();
    const area = new SerializedStorageArea(backing);
    const health = new PersistenceHealthStore(area);
    const store = new TaskStore(area, { health });
    let resolved = 0;
    const manager = new TaskManager({
      store,
      health,
      resolveProvider: () => {
        resolved += 1;
        return Promise.resolve(stubProvider);
      },
      getPermissionMode: () => Promise.resolve('manual'),
      getActiveTabId: () => Promise.resolve(undefined),
    });

    await health.report('task-security', 'DEGRADED', 'a write did not land');
    await expect(manager.create('do something', 'session_1')).rejects.toBeInstanceOf(
      TaskManagerError,
    );
    expect(resolved).toBe(0);
  });

  it('tells the user what is wrong without handing them a storage error', async () => {
    const { manager, health } = world();
    await health.report('task-security', 'DEGRADED', 'a write did not land');
    try {
      await manager.create('do something', 'session_1');
      expect.unreachable();
    } catch (error) {
      const agentError = (error as TaskManagerError).agentError;
      expect(agentError.code).toBe('POLICY_BLOCKED');
      expect(agentError.userMessage).toBeTruthy();
      expect(agentError.userMessage).not.toContain('quota');
      expect(agentError.retryable).toBe(false);
    }
  });

  it('lets work start again once a person has acknowledged it', async () => {
    const { manager, health } = world();
    await health.report('task-security', 'DEGRADED', 'a write did not land');
    await expect(manager.create('x', 's')).rejects.toBeInstanceOf(TaskManagerError);
    await health.acknowledge('task-security');
    await expect(manager.create('x', 's')).resolves.toHaveProperty('id');
  });
});

describe('3b. a degraded audit trail does not stop work', () => {
  it('keeps the gate open however bad the trail gets', async () => {
    const { manager, health } = world();
    await health.report('audit', 'IRRECOVERABLE', 'the trail is gone');
    await expect(manager.create('x', 's')).resolves.toHaveProperty('id');
  });

  it('records a lost audit record durably, without throwing or blocking', async () => {
    const backing = new MemoryStorageArea();
    const area = new SerializedStorageArea(backing);
    const health = new PersistenceHealthStore(area);
    const audit = new AuditLog(area, { health });

    backing.set = () => Promise.reject(new Error('quota'));
    // Still `null` rather than a throw: this is reached from the dispatch
    // path, and a throw here would travel into an execution that already
    // happened.
    await expect(
      audit.record({ type: 'task.created', outcome: 'info', taskId: 't' }),
    ).resolves.toBeNull();

    const snapshot = await health.snapshot();
    expect(snapshot.records.find((record) => record.domain === 'audit')?.state).toBe('DEGRADED');
    expect(snapshot.blocked).toBe(false);
  });

  it('keeps the durable audit record after a later successful write', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const health = new PersistenceHealthStore(area);
    const audit = new AuditLog(area, { health });

    // A refused shape raises the durable marker…
    await audit.record({ type: 'not-a-type', outcome: 'info' } as never);
    await vi.waitFor(async () => {
      const snapshot = await health.snapshot();
      expect(snapshot.records.find((r) => r.domain === 'audit')?.state).toBe('CORRUPT');
    });

    // …and a write that works afterwards clears the in-memory note but not
    // the durable one. The earlier record is still missing.
    await audit.record({ type: 'task.created', outcome: 'info', taskId: 't' });
    expect(audit.degradedReason()).toBeNull();
    const snapshot = await new PersistenceHealthStore(area).snapshot();
    expect(snapshot.records.find((r) => r.domain === 'audit')?.state).toBe('CORRUPT');
  });
});

describe('the gate is not a second authorization path', () => {
  it('is consulted only where work begins, never mid-execution', () => {
    const source = read('src/background/task-manager.ts');
    const calls = [...source.matchAll(/requireHealthyPersistence\('([^']+)'\)/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(['resuming a task', 'retrying a task', 'starting a task']);
    // Not inside the runtime loop: aborting work that is already authorised
    // and already happening is a different failure from refusing to begin.
    // Bounded to the method body: `resume` and `retry` sit further down the
    // file and do call it, so slicing to the end of the file would make this
    // assertion say the opposite of what it means.
    const start = source.indexOf('private async execute');
    const end = source.indexOf('\n  async ', start);
    const execute = source.slice(start, end === -1 ? undefined : end);
    expect(execute.length).toBeGreaterThan(200);
    expect(execute).not.toContain('requireHealthyPersistence');
  });

  it('adds no gate of its own to dispatch, policy, permission or egress', () => {
    for (const file of [
      'src/tools/registry/tool-registry.ts',
      'src/policy/policy-engine.ts',
      'src/security/egress/egress-gate.ts',
    ]) {
      expect(read(file)).not.toContain('persistence-health');
      expect(read(file)).not.toContain('PersistenceHealth');
    }
  });

  it('never claims the marker is a guarantee', () => {
    const source = read('src/storage/persistence-health.ts');
    expect(source).toContain('is not a guarantee');
    expect(source.toLowerCase()).not.toContain('guaranteed to survive');
  });
});
