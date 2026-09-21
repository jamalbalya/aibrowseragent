/**
 * TEST-STORAGE-001 — Storage layer (REQ-STORAGE-001).
 */
import { describe, expect, it } from 'vitest';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
  isTransactional,
  update,
} from '@/storage/storage-area';
import { KeyedMutex } from '@/utils/keyed-mutex';

describe('MemoryStorageArea', () => {
  it('stores and retrieves values', async () => {
    const area = new MemoryStorageArea();
    await area.set('k', { n: 1 });
    expect(await area.get('k')).toEqual({ n: 1 });
  });

  it('returns undefined for a missing key', async () => {
    expect(await new MemoryStorageArea().get('nope')).toBeUndefined();
  });

  it('clones on read so callers cannot mutate stored state by reference', async () => {
    const area = new MemoryStorageArea();
    await area.set('k', { items: [1] });
    const first = (await area.get<{ items: number[] }>('k'))!;
    first.items.push(2);
    const second = (await area.get<{ items: number[] }>('k'))!;
    expect(second.items).toEqual([1]);
  });
});

describe('NamespacedStorageArea', () => {
  it('isolates keys between namespaces', async () => {
    const backing = new MemoryStorageArea();
    const a = new NamespacedStorageArea(backing, 'a');
    const b = new NamespacedStorageArea(backing, 'b');

    await a.set('shared', 'from-a');
    await b.set('shared', 'from-b');

    expect(await a.get('shared')).toBe('from-a');
    expect(await b.get('shared')).toBe('from-b');
  });

  it('lists only its own keys', async () => {
    const backing = new MemoryStorageArea();
    const a = new NamespacedStorageArea(backing, 'a');
    await a.set('one', 1);
    await new NamespacedStorageArea(backing, 'b').set('two', 2);
    expect(await a.keys()).toEqual(['one']);
  });

  it('clears only its own keys', async () => {
    const backing = new MemoryStorageArea();
    const a = new NamespacedStorageArea(backing, 'a');
    const b = new NamespacedStorageArea(backing, 'b');
    await a.set('x', 1);
    await b.set('y', 2);
    await a.clear();
    expect(await a.get('x')).toBeUndefined();
    expect(await b.get('y')).toBe(2);
  });

  it('forwards transactions so wrapping does not downgrade atomicity', async () => {
    const inner = new SerializedStorageArea(new MemoryStorageArea());
    const wrapped = new NamespacedStorageArea(inner, 'ns');
    expect(isTransactional(wrapped)).toBe(true);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        update<number>(wrapped, 'counter', 0, (current) => current + 1),
      ),
    );
    expect(await wrapped.get('counter')).toBe(20);
  });
});

describe('SerializedStorageArea', () => {
  it('does not lose concurrent read-modify-write updates', async () => {
    // Two interleaved get/set pairs would otherwise produce 1, not 50.
    const area = new SerializedStorageArea(new MemoryStorageArea());
    await Promise.all(
      Array.from({ length: 50 }, () =>
        update<{ n: number }>(area, 'counter', { n: 0 }, (current) => ({ n: current.n + 1 })),
      ),
    );
    expect(await area.get<{ n: number }>('counter')).toEqual({ n: 50 });
  });

  it('keeps operations on different keys independent', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    await Promise.all([
      update<number>(area, 'a', 0, (n) => n + 1),
      update<number>(area, 'b', 0, (n) => n + 10),
    ]);
    expect(await area.get('a')).toBe(1);
    expect(await area.get('b')).toBe(10);
  });

  it('continues serving a key after an operation on it rejects', async () => {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    await expect(
      area.transaction('k', 0, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await area.set('k', 5);
    expect(await area.get('k')).toBe(5);
  });
});

describe('KeyedMutex', () => {
  it('serialises work on the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const slow = mutex.run('k', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('first');
    });
    const fast = mutex.run('k', () => {
      order.push('second');
      return Promise.resolve();
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    const slow = mutex.run('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    const fast = mutex.run('b', () => {
      order.push('fast');
      return Promise.resolve();
    });

    await Promise.all([slow, fast]);
    expect(order).toEqual(['fast', 'slow']);
  });

  it('releases the lock when the holder rejects', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(mutex.run('k', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('drops the queue entry once it drains', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', () => Promise.resolve());
    // Allow the cleanup microtask to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(mutex.isBusy('k')).toBe(false);
  });
});
