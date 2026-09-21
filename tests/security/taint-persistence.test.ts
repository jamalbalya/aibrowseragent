/**
 * TEST-SECURITY-012 — taint persistence, concurrency and restart (B2 step 1).
 *
 * The Stage 2 defect was that accumulated taint lived only in a local array
 * inside the runtime and died with the service worker, so a resumed task
 * evaluated as though it had read nothing. These tests rebuild the store over
 * the same backing storage, which is what a worker restart actually does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
} from '@/storage/storage-area';
import { TaskStore, hasUsableSecurityState } from '@/tasks/task-store';
import { createTask, isValidTaintSalt, type AgentTask } from '@/tasks/task-model';
import { taintSources } from '@/security/taint/taint-state';
import { isVerifiableUnderCurrentSalt } from '@/security/egress/egress-evidence';
import { hmacContent } from '@/evidence/evidence-model';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';

const page: TaintSource = {
  sourceType: 'web_page',
  site: 'example.com',
  sensitivity: 'confidential',
};
const docs: TaintSource = {
  sourceType: 'page_html',
  site: 'docs.example',
  sensitivity: 'internal',
};

let backing: MemoryStorageArea;

/** A store over the same storage, as a restarted worker would build. */
function newGeneration(): TaskStore {
  return new TaskStore(new NamespacedStorageArea(new SerializedStorageArea(backing), 'tasks'));
}

function makeTask(): AgentTask {
  return createTask({
    id: 'task_1',
    sessionId: 's1',
    objective: 'Read the page',
    providerId: 'fake',
    modelId: 'm',
    permissionMode: 'auto',
    now: 1,
    taintSalt: 'a'.repeat(64),
  });
}

beforeEach(() => {
  backing = new MemoryStorageArea();
});

describe('taint persistence', () => {
  it('starts a new task explicitly clean and usable', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());
    const stored = await store.getTask('task_1');
    expect(stored!.taintState).toEqual({ kind: 'KNOWN_UNTAINTED' });
    expect(hasUsableSecurityState(stored!)).toBe(true);
  });

  it('records the first taint addition', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());
    const state = await store.appendTaint('task_1', [page]);
    expect(state).toEqual({ kind: 'TAINTED', sources: [page] });
  });

  it('deduplicates a repeated addition', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());
    await store.appendTaint('task_1', [page]);
    const state = await store.appendTaint('task_1', [page]);
    expect(taintSources(state!)).toHaveLength(1);
  });

  it('loses nothing when two tool calls finish at the same moment', async () => {
    // The reason the append runs inside updateTask's mutator: a read-modify-
    // write built in memory and saved blindly would drop one of these.
    const store = newGeneration();
    await store.saveTask(makeTask());

    await Promise.all([store.appendTaint('task_1', [page]), store.appendTaint('task_1', [docs])]);

    const stored = await store.getTask('task_1');
    expect(taintSources(stored!.taintState)).toHaveLength(2);
  });

  it('loses nothing under many concurrent additions', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());

    const sources: TaintSource[] = Array.from({ length: 20 }, (_, i) => ({
      sourceType: 'web_page',
      site: `site-${i}.example`,
      sensitivity: 'internal' as const,
    }));
    await Promise.all(sources.map((source) => store.appendTaint('task_1', [source])));

    const stored = await store.getTask('task_1');
    expect(taintSources(stored!.taintState)).toHaveLength(20);
  });

  it('survives a worker restart', async () => {
    const first = newGeneration();
    await first.saveTask(makeTask());
    await first.appendTaint('task_1', [page]);

    // Every in-memory object is discarded; only storage remains.
    const revived = newGeneration();
    const stored = await revived.getTask('task_1');

    expect(stored!.taintState).toEqual({ kind: 'TAINTED', sources: [page] });
    expect(hasUsableSecurityState(stored!)).toBe(true);
  });

  it('keeps taint across several restarts and additions', async () => {
    await newGeneration().saveTask(makeTask());
    await newGeneration().appendTaint('task_1', [page]);
    await newGeneration().appendTaint('task_1', [docs]);
    const stored = await newGeneration().getTask('task_1');
    expect(taintSources(stored!.taintState)).toHaveLength(2);
  });

  it('reports a missing task rather than inventing a state', async () => {
    const store = newGeneration();
    expect(await store.appendTaint('nope', [page])).toBeUndefined();
  });
});

describe('damaged records fail closed', () => {
  it('reads a record written before the field existed as UNKNOWN', async () => {
    // A Stage 2 record: `taint: []`, no taintState. Reading that as an empty
    // and therefore clean set is the fail-open this replaces.
    await backing.set('tasks:task:legacy', {
      ...makeTask(),
      taintState: undefined,
      taint: [],
    });
    const stored = await newGeneration().getTask('legacy');
    expect(stored!.taintState).toEqual({ kind: 'UNKNOWN', reason: 'field-absent' });
    expect(hasUsableSecurityState(stored!)).toBe(false);
  });

  it('reads a malformed taint state as UNKNOWN', async () => {
    await backing.set('tasks:task:bad', { ...makeTask(), taintState: { kind: 'CLEAN' } });
    const stored = await newGeneration().getTask('bad');
    expect(stored!.taintState).toEqual({ kind: 'UNKNOWN', reason: 'malformed' });
  });

  it('reads a record with a missing salt as unusable', async () => {
    await backing.set('tasks:task:nosalt', { ...makeTask(), taintSalt: undefined });
    const stored = await newGeneration().getTask('nosalt');
    expect(hasUsableSecurityState(stored!)).toBe(false);
  });

  it('does not let an addition repair an UNKNOWN state', async () => {
    await backing.set('tasks:task:legacy', { ...makeTask(), taintState: undefined });
    const store = newGeneration();
    const state = await store.appendTaint('legacy', [page]);
    expect(state!.kind).toBe('UNKNOWN');
  });

  it('leaves a healthy salt and epoch alone', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());
    const same = await store.ensureSalt('task_1', 'b'.repeat(64));
    expect(same!.taintSalt).toBe('a'.repeat(64));
    expect(same!.saltEpoch).toBe(1);
  });

  it('replaces a missing salt and bumps the epoch', async () => {
    await backing.set('tasks:task:nosalt', { ...makeTask(), id: 'nosalt', taintSalt: undefined });
    const store = newGeneration();
    const repaired = await store.ensureSalt('nosalt', 'b'.repeat(64));
    expect(repaired!.taintSalt).toBe('b'.repeat(64));
    expect(repaired!.saltEpoch).toBeGreaterThan(1);
  });

  it('replaces a corrupt salt rather than digesting under a weak key', async () => {
    // Truncated or non-hex still produces a digest, and a digest under a weak
    // key reads as evidence while proving nothing.
    for (const bad of ['', 'zz'.repeat(32), 'ab'.repeat(8), 42 as unknown as string]) {
      await backing.set('tasks:task:bad', { ...makeTask(), id: 'bad', taintSalt: bad });
      const repaired = await newGeneration().ensureSalt('bad', 'c'.repeat(64));
      expect(repaired!.taintSalt).toBe('c'.repeat(64));
      expect(isValidTaintSalt(repaired!.taintSalt)).toBe(true);
    }
  });

  it('keeps concurrent recovery to a single epoch bump', async () => {
    // The check and the write share one mutator, so the second recovery sees
    // the first's result instead of deciding the salt is broken again.
    await backing.set('tasks:task:race', { ...makeTask(), id: 'race', taintSalt: undefined });
    const store = newGeneration();

    await Promise.all([
      store.ensureSalt('race', 'd'.repeat(64)),
      store.ensureSalt('race', 'e'.repeat(64)),
      store.ensureSalt('race', 'f'.repeat(64)),
    ]);

    const stored = await store.getTask('race');
    expect(stored!.saltEpoch).toBe(2);
    expect(isValidTaintSalt(stored!.taintSalt)).toBe(true);
  });

  it('never weakens taint while recovering the key', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());
    await store.appendTaint('task_1', [page]);
    await backing.set('tasks:task:task_1', {
      ...(await store.getTask('task_1'))!,
      taintSalt: 'nonsense',
    });

    const repaired = await newGeneration().ensureSalt('task_1', 'b'.repeat(64));
    expect(repaired!.taintState.kind).toBe('TAINTED');
    expect(taintSources(repaired!.taintState)).toHaveLength(1);
  });

  it('keeps the recovered salt across a worker restart', async () => {
    await backing.set('tasks:task:r', { ...makeTask(), id: 'r', taintSalt: undefined });
    await newGeneration().ensureSalt('r', 'b'.repeat(64));

    const revived = await newGeneration().getTask('r');
    expect(revived!.taintSalt).toBe('b'.repeat(64));
    expect(revived!.saltEpoch).toBe(2);
  });

  it('does not repair a task that is not stored', async () => {
    expect(await newGeneration().ensureSalt('missing', 'b'.repeat(64))).toBeUndefined();
  });
});

describe('storage failure', () => {
  it('surfaces a write failure instead of silently dropping taint', async () => {
    const store = newGeneration();
    await store.saveTask(makeTask());

    const failing = new NamespacedStorageArea(new SerializedStorageArea(backing), 'tasks');
    // A store whose backing write throws must not report success: the runtime
    // relies on the return value to decide whether it may continue.
    const broken = new TaskStore({
      get: (key: string) => failing.get(key),
      set: () => Promise.reject(new Error('quota exceeded')),
      remove: () => Promise.resolve(),
      keys: () => Promise.resolve([]),
      clear: () => Promise.resolve(),
    });

    await expect(broken.appendTaint('task_1', [page])).rejects.toThrow('quota exceeded');
  });
});

describe('evidence across a salt rotation', () => {
  it('does not treat evidence from an earlier epoch as verifiable under the new key', async () => {
    // V-2 requirement 9. The record is kept; what it must not do is claim to
    // be checkable against a key that cannot reproduce it.
    const older = { saltEpoch: 1, payloadDigest: 'a'.repeat(64) };
    const current = { saltEpoch: 2, payloadDigest: 'b'.repeat(64) };

    expect(isVerifiableUnderCurrentSalt(older, 2)).toBe(false);
    expect(isVerifiableUnderCurrentSalt(current, 2)).toBe(true);
  });

  it('treats a record with no digest as unverifiable rather than trivially valid', () => {
    expect(isVerifiableUnderCurrentSalt({ saltEpoch: 2 }, 2)).toBe(false);
  });

  it('produces a different digest under a rotated key', async () => {
    const before = await hmacContent('a'.repeat(64), 'payload');
    const after = await hmacContent('b'.repeat(64), 'payload');
    expect(before).not.toBe(after);
  });

  it('refuses to digest without a key rather than falling back to a plain hash', async () => {
    await expect(hmacContent('', 'payload')).rejects.toThrow(/without a task salt/i);
  });
});
