import { KeyedMutex } from '@/utils/keyed-mutex';

/**
 * Storage abstraction.
 *
 * MV3 service workers are evicted aggressively, so every durable value goes
 * through here rather than living in memory. The interface is deliberately
 * tiny so it can be backed by `chrome.storage.local`, `chrome.storage.session`
 * (for values that must not survive a browser restart) or an in-memory map
 * under test.
 */
export interface StorageArea {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

/**
 * A storage area that can run an atomic read-modify-write.
 *
 * `update()` prefers this over a plain get/set pair, which two concurrent
 * callers could interleave.
 */
export interface TransactionalStorageArea extends StorageArea {
  transaction<T>(key: string, fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T>;
}

export function isTransactional(area: StorageArea): area is TransactionalStorageArea {
  return typeof (area as Partial<TransactionalStorageArea>).transaction === 'function';
}

/** In-memory area. Used by unit tests and as a fallback outside Chrome. */
export class MemoryStorageArea implements StorageArea {
  private readonly map = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    // Structured-clone so callers cannot mutate stored state by reference,
    // matching chrome.storage semantics.
    return Promise.resolve(value === undefined ? undefined : (structuredClone(value) as T));
  }

  set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.map.keys()]);
  }

  clear(): Promise<void> {
    this.map.clear();
    return Promise.resolve();
  }
}

/** Backed by a `chrome.storage.StorageArea`. */
export class ChromeStorageArea implements StorageArea {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.area.get(key);
    return result[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }

  async keys(): Promise<string[]> {
    const all = await this.area.get(null);
    return Object.keys(all);
  }

  async clear(): Promise<void> {
    await this.area.clear();
  }
}

/** Prefixes every key, so independent stores can share one backing area. */
export class NamespacedStorageArea implements TransactionalStorageArea {
  constructor(
    private readonly inner: StorageArea,
    private readonly namespace: string,
  ) {}

  private full(key: string): string {
    return `${this.namespace}:${key}`;
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.inner.get<T>(this.full(key));
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.inner.set(this.full(key), value);
  }

  remove(key: string): Promise<void> {
    return this.inner.remove(this.full(key));
  }

  async keys(): Promise<string[]> {
    const prefix = `${this.namespace}:`;
    const all = await this.inner.keys();
    return all.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  async clear(): Promise<void> {
    for (const key of await this.keys()) {
      await this.remove(key);
    }
  }

  /** Delegates to the inner area so atomicity survives namespacing. */
  transaction<T>(key: string, fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T> {
    const full = this.full(key);
    if (isTransactional(this.inner)) {
      return this.inner.transaction(full, fallback, mutate);
    }
    return (async () => {
      const current = (await this.inner.get<T>(full)) ?? fallback;
      const next = await mutate(current);
      await this.inner.set(full, next);
      return next;
    })();
  }
}

/**
 * Serialises operations per key using a shared mutex.
 *
 * Two tool executions completing at once would otherwise read-modify-write the
 * same task record and lose one update. `transaction` extends that exclusion
 * across a full read-modify-write rather than each individual call.
 */
export class SerializedStorageArea implements TransactionalStorageArea {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly inner: StorageArea) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.mutex.run(key, () => this.inner.get<T>(key));
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.mutex.run(key, () => this.inner.set(key, value));
  }

  remove(key: string): Promise<void> {
    return this.mutex.run(key, () => this.inner.remove(key));
  }

  keys(): Promise<string[]> {
    return this.inner.keys();
  }

  clear(): Promise<void> {
    return this.inner.clear();
  }

  /** Atomic read-modify-write: no other operation on `key` interleaves. */
  transaction<T>(key: string, fallback: T, mutate: (current: T) => T | Promise<T>): Promise<T> {
    return this.mutex.run(key, async () => {
      const current = (await this.inner.get<T>(key)) ?? fallback;
      const next = await mutate(current);
      await this.inner.set(key, next);
      return next;
    });
  }
}

/**
 * Atomic read-modify-write.
 *
 * When `area` supports transactions the whole cycle is atomic. Any other area
 * gets best-effort sequential semantics, which is why every durable store in
 * this project is constructed over a serialised area.
 */
export async function update<T>(
  area: StorageArea,
  key: string,
  fallback: T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  if (isTransactional(area)) {
    return area.transaction(key, fallback, mutate);
  }
  const current = (await area.get<T>(key)) ?? fallback;
  const next = await mutate(current);
  await area.set(key, next);
  return next;
}
