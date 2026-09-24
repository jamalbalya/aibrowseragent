/**
 * Where the worker keeps what the last page read observed about each field.
 *
 * It exists because classification has to happen in the worker and the facts
 * it classifies only exist in the page. `browser.read_page` is the one place
 * those facts cross the boundary, so they are held here between the read and
 * the write that follows it.
 *
 * Deliberately in memory and nowhere else. A field observation is a fact about
 * a page as it was a moment ago, and persisting it would turn a stale fact
 * into a durable one — the service worker being evicted is precisely the case
 * where the right answer is "I no longer know", and `lookup` returning
 * `undefined` is how that answer is given. `classifyField(undefined)` is
 * `UNKNOWN`, which is more restricted than `ORDINARY`, so an emptied store
 * costs a confirmation rather than granting a write.
 *
 * Bound to three things at once — tab, snapshot generation and handle —
 * because any one of them alone is forgeable or stale:
 *
 *  - tab, so one page's observations never answer for another's;
 *  - generation, so a handle minted by an earlier read cannot be answered by
 *    a later read's observations, or the reverse;
 *  - handle, which is the thing actually being written to.
 */
import type { FieldObservation } from './field-sensitivity';

/** One page read: a generation, and what it saw. */
interface TabSnapshot {
  readonly generation: number;
  readonly byElementId: ReadonlyMap<string, FieldObservation>;
}

/**
 * The generation encoded in a handle.
 *
 * Handles are `e{generation}-{index}`. Parsing rather than trusting a
 * separately supplied generation is the point: the handle the model names is
 * the handle the lookup is answered for, so a mismatch cannot be papered over
 * by a caller passing the generation it wishes were current.
 */
export function generationOfHandle(handle: string): number | null {
  const head = handle.split('-')[0];
  if (head === undefined || !head.startsWith('e')) return null;
  const generation = Number(head.slice(1));
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

export class FieldObservationStore {
  private readonly byTab = new Map<number, TabSnapshot>();

  /**
   * Replaces everything known about a tab.
   *
   * Replaces rather than merges: a new snapshot is a new truth about the page,
   * and keeping an older generation's entries alongside it would mean a stale
   * handle could still be answered.
   */
  record(tabId: number, generation: number, fields: readonly FieldObservation[]): void {
    const byElementId = new Map<string, FieldObservation>();
    for (const field of fields) byElementId.set(field.elementId, field);
    this.byTab.set(tabId, { generation, byElementId });
  }

  /**
   * What was observed about this handle, or `undefined`.
   *
   * Every uncertain case returns `undefined` and none of them throws: no tab,
   * an evicted store, a handle from another generation, a handle that was
   * never registered. They are all the same fact — this build cannot say what
   * that field is — and they all resolve to `UNKNOWN` downstream.
   */
  lookup(tabId: number | undefined, elementId: string): FieldObservation | undefined {
    if (tabId === undefined) return undefined;
    const snapshot = this.byTab.get(tabId);
    if (!snapshot) return undefined;

    const generation = generationOfHandle(elementId);
    if (generation === null || generation !== snapshot.generation) return undefined;

    return snapshot.byElementId.get(elementId);
  }

  /** Drops a tab's observations, when the tab is gone or has navigated. */
  forget(tabId: number): void {
    this.byTab.delete(tabId);
  }

  /** Drops everything. Used by tests and by an explicit session reset. */
  clear(): void {
    this.byTab.clear();
  }
}
