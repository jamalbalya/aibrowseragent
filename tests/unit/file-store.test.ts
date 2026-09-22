/**
 * TEST-FILE-002 — staged file lifetime and task scoping.
 *
 * The property being held here is a negative one: a file a user chose for one
 * task is not reachable from another, and nothing keeps the bytes after the
 * task that needed them is over.
 */
import { describe, expect, it } from 'vitest';
import { StagedFileStore } from '@/files/file-store';

function stage(store: StagedFileStore, taskId: string, name = 'cv.pdf', byteLength = 1024) {
  return store.stage({
    taskId,
    name,
    mimeType: 'application/pdf',
    dataBase64: 'QUFB',
    byteLength,
    origin: 'local',
    source: 'local_selection',
    sensitivity: 'confidential',
  });
}

describe('staging', () => {
  it('returns a record carrying the specification’s file fields', () => {
    const store = new StagedFileStore({ now: () => 1_700_000_000_000 });
    const record = stage(store, 'task_1');

    expect(record.id).toMatch(/^file_/);
    expect(record).toMatchObject({
      taskId: 'task_1',
      origin: 'local',
      source: 'local_selection',
      name: 'cv.pdf',
      mimeType: 'application/pdf',
      byteLength: 1024,
      sensitivity: 'confidential',
      createdAt: 1_700_000_000_000,
    });
  });

  it('keeps contents out of the record entirely', () => {
    const store = new StagedFileStore();
    const record = stage(store, 'task_1');
    // Not redacted afterwards — there is nowhere in the type to put them.
    expect(JSON.stringify(record)).not.toContain('QUFB');
  });

  it('gives every file a distinct id', () => {
    const store = new StagedFileStore();
    const ids = [stage(store, 't'), stage(store, 't'), stage(store, 't')].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('task scoping', () => {
  it('does not hand one task’s file to another', () => {
    // The ids are unguessable, but a lookup that ignored the task would make
    // this a matter of not guessing rather than of not being able to.
    const store = new StagedFileStore();
    const mine = stage(store, 'task_mine');

    expect(store.get('task_mine', mine.id)).toBeDefined();
    expect(store.get('task_other', mine.id)).toBeUndefined();
    expect(store.has('task_other', mine.id)).toBe(false);
  });

  it('lists records for one task only, and without bytes', () => {
    const store = new StagedFileStore();
    stage(store, 'task_a', 'a.pdf');
    stage(store, 'task_b', 'b.pdf');

    const listed = store.listForTask('task_a');
    expect(listed.map((r) => r.name)).toEqual(['a.pdf']);
    expect(JSON.stringify(listed)).not.toContain('QUFB');
  });

  it('returns nothing for a task that staged nothing', () => {
    expect(new StagedFileStore().listForTask('task_none')).toEqual([]);
  });
});

describe('lifetime', () => {
  it('drops everything a task staged, and frees the space', () => {
    const store = new StagedFileStore();
    const record = stage(store, 'task_1', 'cv.pdf', 4096);
    expect(store.bytesHeld).toBe(4096);

    store.clearTask('task_1');
    expect(store.get('task_1', record.id)).toBeUndefined();
    expect(store.bytesHeld).toBe(0);
  });

  it('leaves other tasks alone when one is cleared', () => {
    const store = new StagedFileStore();
    stage(store, 'task_a');
    const keep = stage(store, 'task_b');

    store.clearTask('task_a');
    expect(store.get('task_b', keep.id)).toBeDefined();
  });

  it('clearing a task that staged nothing is not an error', () => {
    const store = new StagedFileStore();
    expect(() => store.clearTask('task_none')).not.toThrow();
  });

  it('clears everything at once', () => {
    const store = new StagedFileStore();
    stage(store, 'task_a');
    stage(store, 'task_b');
    store.clearAll();
    expect(store.bytesHeld).toBe(0);
    expect(store.listForTask('task_a')).toEqual([]);
  });
});

describe('capacity', () => {
  it('refuses rather than evicting when full', () => {
    // Evicting would make a later attach fail for a reason unrelated to the
    // task that caused it.
    const store = new StagedFileStore({ maxTotalBytes: 1000 });
    stage(store, 'task_1', 'a.pdf', 600);
    expect(() => stage(store, 'task_1', 'b.pdf', 600)).toThrow(/No room/);
    expect(store.listForTask('task_1')).toHaveLength(1);
  });

  it('accepts again once space is freed', () => {
    const store = new StagedFileStore({ maxTotalBytes: 1000 });
    stage(store, 'task_1', 'a.pdf', 900);
    store.clearTask('task_1');
    expect(() => stage(store, 'task_2', 'b.pdf', 900)).not.toThrow();
  });
});
