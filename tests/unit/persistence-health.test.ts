/**
 * TEST-PERSISTENCE-001 — durable persistence health (D-3).
 *
 * The property under test is that a failure outlives the worker that saw it.
 * Everything else here exists to keep that property honest: monotonicity, so
 * a later success cannot quietly mean the earlier loss did not happen; a
 * floor, so a failure too severe to record still stops this worker; and a
 * gate that ignores the audit domain, because a gap in the record of an
 * execution is not a failed execution.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea, type StorageArea } from '@/storage/storage-area';
import {
  HEALTH_DOMAINS,
  PERSISTENCE_STATES,
  PersistenceHealthStore,
  describeBlock,
  severityOf,
} from '@/storage/persistence-health';

const newStore = (area?: StorageArea): { store: PersistenceHealthStore; area: StorageArea } => {
  const backing = area ?? new SerializedStorageArea(new MemoryStorageArea());
  return { store: new PersistenceHealthStore(backing), area: backing };
};

describe('the severity ladder', () => {
  it('orders states from healthy to irrecoverable', () => {
    const ordered = [...PERSISTENCE_STATES].map(severityOf);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(severityOf('HEALTHY')).toBe(0);
    expect(severityOf('IRRECOVERABLE')).toBe(PERSISTENCE_STATES.length - 1);
  });

  it('starts every domain healthy and unblocked', async () => {
    const { store } = newStore();
    const snapshot = await store.snapshot();
    expect(snapshot.records.map((record) => record.domain).sort()).toEqual(
      [...HEALTH_DOMAINS].sort(),
    );
    expect(snapshot.records.every((record) => record.state === 'HEALTHY')).toBe(true);
    expect(snapshot.blocked).toBe(false);
  });
});

describe('reports are monotone', () => {
  it('raises a domain and keeps it raised', async () => {
    const { store } = newStore();
    await store.report('task-security', 'DEGRADED', 'a write did not land');
    expect((await store.snapshot()).gating).toBe('DEGRADED');
    await store.report('task-security', 'CORRUPT', 'a record did not parse');
    expect((await store.snapshot()).gating).toBe('CORRUPT');
  });

  it('never lowers a domain through a report', async () => {
    const { store } = newStore();
    await store.report('task-security', 'CORRUPT', 'a record did not parse');
    await store.report('task-security', 'DEGRADED', 'a write did not land');
    await store.report('task-security', 'HEALTHY', 'this must not take effect');
    expect((await store.snapshot()).gating).toBe('CORRUPT');
  });

  it('keeps the *persisted* record monotone, not only the in-memory floor', async () => {
    // Read through a fresh instance on purpose. In the instance that made the
    // reports, the floor would mask a persisted record that had been lowered,
    // so a same-instance assertion cannot tell the two apart — and the
    // instance that matters is the one after a restart, which has no floor.
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new PersistenceHealthStore(area);
    await store.report('task-security', 'CORRUPT', 'a record did not parse');
    await store.report('task-security', 'DEGRADED', 'a write did not land');

    const afterRestart = await new PersistenceHealthStore(area).snapshot();
    expect(afterRestart.gating).toBe('CORRUPT');
    expect(afterRestart.blocked).toBe(true);
  });

  it('counts repeated failures without losing the first time', async () => {
    const { store } = newStore();
    await store.report('audit', 'DEGRADED', 'a record could not be written');
    const first = (await store.snapshot()).records.find((r) => r.domain === 'audit')!;
    await store.report('audit', 'DEGRADED', 'a record could not be written');
    const second = (await store.snapshot()).records.find((r) => r.domain === 'audit')!;
    expect(second.reports).toBe(first.reports + 1);
    expect(second.since).toBe(first.since);
  });
});

describe('a report outlives the instance that made it', () => {
  it('is read back by a fresh store over the same storage', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const first = new PersistenceHealthStore(area);
    await first.report('task-security', 'DEGRADED', 'a write did not land');

    // A new instance is what a restarted service worker has: no memory of the
    // failure, only what was written down.
    const second = new PersistenceHealthStore(area);
    const snapshot = await second.snapshot();
    expect(snapshot.gating).toBe('DEGRADED');
    expect(snapshot.blocked).toBe(true);
  });

  it('is not cleared by later successful writes to the same storage', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new PersistenceHealthStore(area);
    await store.report('task-security', 'DEGRADED', 'a write did not land');
    await area.set('something-else', { fine: true });
    expect((await new PersistenceHealthStore(area).snapshot()).blocked).toBe(true);
  });
});

describe('the in-memory floor', () => {
  it('holds for this worker even when the marker cannot be written', async () => {
    // The stub goes on the *backing* area, not the serializing wrapper: the
    // wrapper's transaction writes through to the area behind it, so stubbing
    // the wrapper would leave the write landing and prove nothing.
    const backing = new MemoryStorageArea();
    const area = new SerializedStorageArea(backing);
    const store = new PersistenceHealthStore(area);
    const original = backing.set.bind(backing);
    backing.set = () => Promise.reject(new Error('quota'));

    await expect(
      store.report('task-security', 'DEGRADED', 'a write did not land'),
    ).resolves.toBeUndefined();
    expect((await store.snapshot()).blocked).toBe(true);

    backing.set = original;
    // A fresh instance has no floor and nothing was persisted, so it cannot
    // know. Asserted rather than left implicit: this is exactly the limit of
    // what a marker kept in the failing store can promise, and the docs say
    // the same thing.
    expect((await new PersistenceHealthStore(area).snapshot()).blocked).toBe(false);
  });

  it('reports irrecoverable storage when health itself cannot be read', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new PersistenceHealthStore(area);
    const inner = area as unknown as { get: (key: string) => Promise<unknown> };
    inner.get = () => Promise.reject(new Error('unreadable'));

    const snapshot = await store.snapshot();
    expect(snapshot.records.find((record) => record.domain === 'storage')?.state).toBe(
      'IRRECOVERABLE',
    );
    expect(snapshot.blocked).toBe(true);
  });
});

describe('which domains gate work', () => {
  it('blocks on task-security and on storage', async () => {
    for (const domain of ['task-security', 'storage'] as const) {
      const { store } = newStore();
      await store.report(domain, 'DEGRADED', 'a write did not land');
      expect((await store.snapshot()).blocked, domain).toBe(true);
    }
  });

  it('does not block on audit, however bad it gets', async () => {
    // P-038's contract: a gap in the record is a gap in the record of an
    // execution that already happened. Blocking on it would turn the one into
    // the other.
    const { store } = newStore();
    await store.report('audit', 'IRRECOVERABLE', 'the trail is gone');
    const snapshot = await store.snapshot();
    expect(snapshot.records.find((record) => record.domain === 'audit')?.state).toBe(
      'IRRECOVERABLE',
    );
    expect(snapshot.blocked).toBe(false);
    expect(snapshot.gating).toBe('HEALTHY');
  });
});

describe('acknowledgement', () => {
  it('is the only way down, and clears both the record and the floor', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new PersistenceHealthStore(area);
    await store.report('task-security', 'CORRUPT', 'a record did not parse');
    expect((await store.snapshot()).blocked).toBe(true);

    const after = await store.acknowledge('task-security');
    expect(after.blocked).toBe(false);
    expect((await new PersistenceHealthStore(area).snapshot()).blocked).toBe(false);
  });

  it('clears one domain without clearing another', async () => {
    const { store } = newStore();
    await store.report('task-security', 'DEGRADED', 'a write did not land');
    await store.report('storage', 'CORRUPT', 'a record did not parse');
    await store.acknowledge('task-security');
    const snapshot = await store.snapshot();
    expect(snapshot.records.find((r) => r.domain === 'storage')?.state).toBe('CORRUPT');
    expect(snapshot.blocked).toBe(true);
  });
});

describe('a malformed stored record', () => {
  it('is not read as healthy, and is not read as meaningful either', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    // A *real* domain carrying a state off the ladder. An unknown domain would
    // never match a lookup, so it would exercise nothing — the record has to
    // be one the reader would otherwise pick up.
    await area.set('persistence-health', {
      records: [
        { domain: 'task-security', state: 'FINE', reason: 'x', since: 1, reports: 1 },
        { domain: 'audit', state: 'CORRUPT', since: 'not-a-number', reason: 'x' },
        { domain: 'nonsense', state: 'DEGRADED', reason: 'x', since: 1 },
      ],
    });
    const snapshot = await new PersistenceHealthStore(area).snapshot();
    // Dropped: a record that does not parse says nothing, and inventing a
    // state from it would be reading meaning into bytes that have none.
    expect(snapshot.records.every((record) => record.state === 'HEALTHY')).toBe(true);
    expect(snapshot.records).toHaveLength(HEALTH_DOMAINS.length);
    expect(snapshot.blocked).toBe(false);
  });
});

describe('a stored value that is not a health record at all', () => {
  // Found by executing §90's malformed-state procedure against real extension
  // storage. The case above — a well-formed container holding records that do
  // not parse — is deliberately lenient, and stays that way. This is the
  // other one: the whole stored value is not something this code could have
  // written. It read as an empty list, and an empty list reads as HEALTHY,
  // so a corrupt record reported that everything was fine. That is a
  // fail-open in the control whose only job is to fail closed.
  const unreadable: [string, unknown][] = [
    ['a truncated string', '{"records":['],
    ['a bare string', 'nonsense'],
    ['a number', 42],
    ['null', null],
    ['an array', [{ domain: 'audit', state: 'CORRUPT' }]],
    ['an object with no records key', { domains: [] }],
    ['an object whose records is not a list', { records: 'CORRUPT' }],
  ];

  it.each(unreadable)('treats %s as a storage fault, not as a clean profile', async (_, value) => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    await area.set('persistence-health', value);
    const snapshot = await new PersistenceHealthStore(area).snapshot();

    const storage = snapshot.records.find((record) => record.domain === 'storage');
    expect(storage?.state).toBe('IRRECOVERABLE');
    expect(snapshot.gating).not.toBe('HEALTHY');
    expect(snapshot.blocked, 'work does not start over an unreadable record').toBe(true);
  });

  it('still reads nothing-written-yet as a clean profile', async () => {
    // The positive control, and the distinction the whole fix rests on: an
    // absent record is a new install, while an unreadable one is evidence.
    // A guard that could not tell them apart would block every first run.
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const snapshot = await new PersistenceHealthStore(area).snapshot();
    expect(snapshot.records.every((record) => record.state === 'HEALTHY')).toBe(true);
    expect(snapshot.blocked).toBe(false);
  });

  it('says the record could not be understood, not that it could not be read', async () => {
    // Two different faults with two different remedies, and a reason that
    // conflated them would send someone looking at the wrong one.
    const area = new SerializedStorageArea(new MemoryStorageArea());
    await area.set('persistence-health', 'nonsense');
    const snapshot = await new PersistenceHealthStore(area).snapshot();
    const storage = snapshot.records.find((record) => record.domain === 'storage');
    expect(storage?.reason).toContain('could not be understood');
  });
});

describe('what a blocked user is told', () => {
  it('names the situation without leaking a storage error', async () => {
    const { store } = newStore();
    await store.report('task-security', 'DEGRADED', 'a write did not land');
    const message = describeBlock(await store.snapshot());
    expect(message).toContain('security state');
    expect(message).not.toContain('quota');
    expect(message).not.toContain('Error');
  });

  it('has something to say for every state on the ladder', async () => {
    for (const state of PERSISTENCE_STATES) {
      const { store } = newStore();
      await store.report('task-security', state, 'reason');
      expect(describeBlock(await store.snapshot()).length).toBeGreaterThan(10);
    }
  });
});
