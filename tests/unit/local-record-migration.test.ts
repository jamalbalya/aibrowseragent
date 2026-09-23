/**
 * TEST-SECURITY-044 — local schema migration, which the user never runs.
 *
 * A person who installed a Chrome extension has no terminal, no database
 * client and no reason to have either. So every one of these cases is a case
 * the extension has to handle by itself, silently and correctly, on the first
 * read after an update.
 *
 * The six required situations are each here, and each is tested for the same
 * property: **the failure costs at most the record that caused it.** Nothing
 * in this suite is allowed to lose a record it did not fail on.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import { RecordStore, type RecordMigration } from '@/storage/record-store';
import { PersistenceHealthStore } from '@/storage/persistence-health';

interface Note {
  readonly id: string;
  readonly text: string;
  readonly formatVersion: number;
}

function isNote(candidate: unknown): candidate is Note {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const note = candidate as Partial<Note>;
  return typeof note.id === 'string' && typeof note.text === 'string';
}

/** v1 held `body`; v2 renamed it to `text`. A real, ordinary rename. */
const V1_TO_V2: RecordMigration = {
  from: 1,
  to: 2,
  migrate: (stored) => {
    const old = stored as { id?: unknown; body?: unknown };
    if (typeof old.id !== 'string' || typeof old.body !== 'string') {
      throw new Error('a v1 note needs an id and a body');
    }
    return { id: old.id, text: old.body, formatVersion: 2 };
  },
};

function storeFor(
  area: MemoryStorageArea,
  version = 2,
  health?: PersistenceHealthStore,
): RecordStore<Note> {
  return new RecordStore<Note>({
    area,
    kind: 'notes',
    version,
    identify: (note) => note.id,
    validate: isNote,
    migrations: version === 2 ? [V1_TO_V2] : [],
    legacy: [{ kind: 'blob', key: 'notes', version: 1, extract: extractNotes }],
    ...(health === undefined ? {} : { health }),
  });
}

function extractNotes(stored: unknown): readonly unknown[] {
  const blob = stored as { notes?: unknown };
  return Array.isArray(blob.notes) ? blob.notes : [];
}

describe('local record migration', () => {
  it('01 — an old version becomes the current one, with no user action', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes', {
      notes: [
        { id: 'n1', body: 'first', formatVersion: 1 },
        { id: 'n2', body: 'second', formatVersion: 1 },
      ],
    });

    // Nothing is called to trigger this. A plain read is what a panel does.
    const notes = await storeFor(area).list();

    expect(notes.map((n) => n.text)).toEqual(['first', 'second']);
    expect(notes.every((n) => n.formatVersion === 2)).toBe(true);
    // The old value is gone only because the new one was verified first.
    expect(await area.get('notes')).toBeUndefined();
    expect(await area.get('notes:v2:n1')).toEqual({
      v: 2,
      record: { id: 'n1', text: 'first', formatVersion: 2 },
    });
  });

  it('02 — a record from an unknown future version is hidden, never guessed at', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes:v2:index', { ids: ['n1'] });
    await area.set('notes:v2:n1', { v: 99, record: { id: 'n1', somethingNew: true } });

    // A downgrade cannot know what a future version means. Reading it as if
    // it were v2 would produce a note with no text; hiding it means the newer
    // build still finds it intact.
    expect(await storeFor(area).list()).toEqual([]);
    expect(await area.get('notes:v2:n1')).not.toBeUndefined();
  });

  it('03 — a malformed record is dropped and the rest are read', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes:v2:index', { ids: ['n1', 'broken', 'n3'] });
    await area.set('notes:v2:n1', { v: 2, record: { id: 'n1', text: 'kept', formatVersion: 2 } });
    await area.set('notes:v2:broken', { v: 2, record: { id: 'broken', text: 42 } });
    await area.set('notes:v2:n3', {
      v: 2,
      record: { id: 'n3', text: 'also kept', formatVersion: 2 },
    });

    const notes = await storeFor(area).list();

    expect(notes.map((n) => n.id)).toEqual(['n1', 'n3']);
  });

  it('04 — partial corruption of the blob costs only the corrupt entries', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes', {
      notes: [
        { id: 'good-1', body: 'kept', formatVersion: 1 },
        { id: 'bad', formatVersion: 1 },
        null,
        { id: 'good-2', body: 'also kept', formatVersion: 1 },
      ],
    });

    const notes = await storeFor(area).list();

    // Two migrated, two quarantined. The two that were readable are readable.
    expect(notes.map((n) => n.id)).toEqual(['good-1', 'good-2']);
  });

  it('05 — a migration that throws leaves that record alone, not the others', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes', {
      notes: [
        { id: 'n1', body: 'fine', formatVersion: 1 },
        { id: 'explodes', body: 'boom', formatVersion: 1 },
      ],
    });

    const store = new RecordStore<Note>({
      area,
      kind: 'notes',
      version: 2,
      identify: (note) => note.id,
      validate: isNote,
      migrations: [
        {
          from: 1,
          to: 2,
          migrate: (stored) => {
            const old = stored as { id?: unknown; body?: unknown };
            if (old.id === 'explodes') throw new Error('this one cannot be migrated');
            return { id: old.id, text: old.body, formatVersion: 2 };
          },
        },
      ],
      legacy: [{ kind: 'blob', key: 'notes', version: 1, extract: extractNotes }],
    });

    expect((await store.list()).map((n) => n.id)).toEqual(['n1']);
  });

  it('06 — an index that is not an index reads empty rather than throwing', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes:v2:index', 'this is not an index');
    await area.set('notes:v2:n1', { v: 2, record: { id: 'n1', text: 'x', formatVersion: 2 } });

    // Empty, and the record is still on disk: a damaged index is recoverable,
    // a deleted record is not.
    expect(await storeFor(area).list()).toEqual([]);
    expect(await area.get('notes:v2:n1')).not.toBeUndefined();
  });

  it('07 — unrelated records are never read, written or removed', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes', { notes: [{ id: 'n1', body: 'mine', formatVersion: 1 }] });
    await area.set('app-settings', { theme: 'dark' });
    await area.set('apiKey:openai', 'sk-not-to-be-touched');
    await area.set('task:t1', { id: 't1' });
    await area.set('audit-index', { ids: ['a1'] });

    await storeFor(area).list();

    expect(await area.get('app-settings')).toEqual({ theme: 'dark' });
    expect(await area.get('apiKey:openai')).toBe('sk-not-to-be-touched');
    expect(await area.get('task:t1')).toEqual({ id: 't1' });
    expect(await area.get('audit-index')).toEqual({ ids: ['a1'] });
  });

  it('08 — a failed migration is reported to persistence health, not swallowed', async () => {
    const area = new MemoryStorageArea();
    const health = new PersistenceHealthStore(new MemoryStorageArea());
    await area.set('notes', {
      notes: [
        { id: 'n1', body: 'fine', formatVersion: 1 },
        { id: 'bad', formatVersion: 1 },
      ],
    });

    await storeFor(area, 2, health).list();

    const snapshot = await health.snapshot();
    const storage = snapshot.records.find((record) => record.domain === 'storage');
    expect(storage?.state).toBe('CORRUPT');
  });

  it('09 — an interrupted upgrade is safe to repeat and does not duplicate', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes', { notes: [{ id: 'n1', body: 'once', formatVersion: 1 }] });

    // Two independent stores over the same area: the second is the "next
    // start" after an interruption, and ids are preserved so it is a no-op.
    await storeFor(area).list();
    await storeFor(area).list();

    const notes = await storeFor(area).list();
    expect(notes).toHaveLength(1);
    expect((await area.get<{ ids: string[] }>('notes:v2:index'))?.ids).toEqual(['n1']);
  });

  it('10 — removing a record removes its key, leaving nothing orphaned', async () => {
    const area = new MemoryStorageArea();
    const store = storeFor(area);
    await store.put({ id: 'n1', text: 'here', formatVersion: 2 });

    await store.remove('n1');

    expect(await area.get('notes:v2:n1')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('11 — a record written without an envelope is read as version 1', async () => {
    const area = new MemoryStorageArea();
    await area.set('notes:v2:index', { ids: ['n1'] });
    // No { v, record } wrapper: what an unversioned build would have written.
    await area.set('notes:v2:n1', { id: 'n1', body: 'legacy shape' });

    expect((await storeFor(area).list())[0]).toEqual({
      id: 'n1',
      text: 'legacy shape',
      formatVersion: 2,
    });
  });

  it('12 — a migration chain with a gap is refused at construction', () => {
    expect(
      () =>
        new RecordStore<Note>({
          area: new MemoryStorageArea(),
          kind: 'notes',
          version: 3,
          identify: (note) => note.id,
          validate: isNote,
          // 1→2 then 3→4: nothing takes a v2 record to v3.
          migrations: [V1_TO_V2, { from: 3, to: 4, migrate: (s) => s }],
        }),
    ).toThrow(/gap/);
  });

  it('13 — the cap evicts the oldest and leaves no key behind', async () => {
    const area = new MemoryStorageArea();
    const store = new RecordStore<Note>({
      area,
      kind: 'notes',
      version: 2,
      identify: (note) => note.id,
      validate: isNote,
      max: 2,
    });

    await store.put({ id: 'a', text: 'a', formatVersion: 2 });
    await store.put({ id: 'b', text: 'b', formatVersion: 2 });
    await store.put({ id: 'c', text: 'c', formatVersion: 2 });

    expect((await store.list()).map((n) => n.id)).toEqual(['c', 'b']);
    expect(await area.get('notes:v2:a')).toBeUndefined();
  });
});
