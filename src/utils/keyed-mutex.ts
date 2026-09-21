/**
 * Per-key mutual exclusion.
 *
 * Used wherever a read-modify-write must be atomic across concurrent callers:
 * task record updates, site policy updates, and tab locks held by tasks.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Runs `fn` with exclusive access to `key`. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Run regardless of whether the previous holder resolved or rejected.
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    // Drop the entry once the queue drains so the map does not grow unbounded.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** True when a holder is queued or running for `key`. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
