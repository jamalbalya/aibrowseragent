/**
 * Duplicate-write protection for connector operations.
 *
 * The failure this exists for is not a model calling a tool twice. It is the
 * one where **the write succeeded and we do not know it**: the request times
 * out, the socket drops, or the service worker is evicted after the service
 * committed the change but before the response came back. Retrying then
 * sends a second email, files a second issue, posts a second message.
 *
 * "The request failed" therefore does not mean "the remote operation did not
 * happen", and the whole design follows from refusing to assume it does.
 *
 * Three states, and the middle one is the point:
 *
 *   `in_flight`  a request was sent and no answer has come back
 *   `uncertain`  it never came back, so the outcome is genuinely unknown
 *   `completed`  the service answered, and what it said is recorded
 *
 * A replay of a `completed` operation returns the recorded outcome instead of
 * sending anything. A replay of an `uncertain` one is **refused** and has to
 * be confirmed by a person, because only they can look and see whether the
 * issue was already filed.
 *
 * Where a service supports an idempotency key, the key below is sent with the
 * request and the service does the deduplication properly. Where it does not
 * — GitHub, for instance, has no such header — this record is the only thing
 * standing between a timeout and a duplicate.
 */

import { getLogger } from '@/logging/logger';
import { update, type TransactionalStorageArea } from '@/storage/storage-area';

const log = getLogger('agent');

export type WriteOutcome = 'in_flight' | 'uncertain' | 'completed' | 'failed';

export interface WriteRecord {
  readonly key: string;
  readonly connectorId: string;
  readonly operationId: string;
  readonly taskId: string;
  readonly outcome: WriteOutcome;
  readonly startedAt: number;
  readonly settledAt?: number;
  /** A service-side identifier, so a completed replay can point at the result. */
  readonly resultRef?: string;
}

interface WriteIndex {
  readonly records: WriteRecord[];
}

const INDEX_KEY = 'connector-writes';
/** Records older than this are dropped; a stale uncertain write is not useful. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 200;

/**
 * A deterministic key for one intended write.
 *
 * Derived from the task, the connector, the operation and the arguments, so
 * the same intent produces the same key across a retry, a worker restart and
 * a repeated model tool call — and two genuinely different writes never
 * collide. Arguments are canonicalised with sorted keys, because
 * `{a:1,b:2}` and `{b:2,a:1}` are the same intent.
 *
 * This is a SHA-256 of non-secret operation metadata. It is not an
 * authorization token and is never accepted as one.
 */
export async function writeKey(input: {
  taskId: string;
  connectorId: string;
  operationId: string;
  args: unknown;
}): Promise<string> {
  const canonical = JSON.stringify({
    taskId: input.taskId,
    connectorId: input.connectorId,
    operationId: input.operationId,
    args: canonicalise(input.args),
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** Sorts object keys recursively so equal intents serialise identically. */
function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, canonicalise(nested)]),
  );
}

export type ClaimResult =
  | { readonly kind: 'proceed'; readonly key: string }
  | { readonly kind: 'already_completed'; readonly record: WriteRecord }
  | { readonly kind: 'uncertain'; readonly record: WriteRecord }
  | { readonly kind: 'in_flight'; readonly record: WriteRecord };

export class WriteGuard {
  constructor(
    private readonly area: TransactionalStorageArea,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Claims a write before it is sent.
   *
   * The claim is persisted **first**, so a worker evicted mid-request leaves
   * an `in_flight` record behind rather than no trace at all. That record is
   * what later becomes `uncertain`.
   */
  async claim(input: {
    key: string;
    connectorId: string;
    operationId: string;
    taskId: string;
  }): Promise<ClaimResult> {
    let result: ClaimResult = { kind: 'proceed', key: input.key };

    await update<WriteIndex>(this.area, INDEX_KEY, { records: [] }, (index) => {
      const fresh = index.records.filter((record) => this.now() - record.startedAt < RETENTION_MS);
      const existing = fresh.find((record) => record.key === input.key);

      if (existing) {
        if (existing.outcome === 'completed') {
          result = { kind: 'already_completed', record: existing };
          return { records: fresh };
        }
        if (existing.outcome === 'uncertain') {
          result = { kind: 'uncertain', record: existing };
          return { records: fresh };
        }
        if (existing.outcome === 'in_flight') {
          result = { kind: 'in_flight', record: existing };
          return { records: fresh };
        }
        // A previously failed write is a normal thing to retry: the service
        // answered and said no, so nothing happened on its side.
      }

      const record: WriteRecord = {
        key: input.key,
        connectorId: input.connectorId,
        operationId: input.operationId,
        taskId: input.taskId,
        outcome: 'in_flight',
        startedAt: this.now(),
      };
      return {
        records: [record, ...fresh.filter((r) => r.key !== input.key)].slice(0, MAX_RECORDS),
      };
    });

    return result;
  }

  /** Records that the service answered. */
  async settle(key: string, outcome: 'completed' | 'failed', resultRef?: string): Promise<void> {
    await this.mark(key, outcome, resultRef);
  }

  /**
   * Records that no answer arrived.
   *
   * The state that makes the guard worth having: the next attempt is refused
   * rather than retried, because whether the write landed is unknown and a
   * machine cannot find out.
   */
  async markUncertain(key: string): Promise<void> {
    await this.mark(key, 'uncertain');
    log.warn('A connector write has an unknown outcome and will not be replayed silently.', {
      key,
    });
  }

  /** Clears a record so a confirmed replay can proceed. */
  async forget(key: string): Promise<void> {
    await update<WriteIndex>(this.area, INDEX_KEY, { records: [] }, (index) => ({
      records: index.records.filter((record) => record.key !== key),
    }));
  }

  async list(taskId?: string): Promise<WriteRecord[]> {
    const index = (await this.area.get<WriteIndex>(INDEX_KEY)) ?? { records: [] };
    return taskId === undefined
      ? index.records
      : index.records.filter((record) => record.taskId === taskId);
  }

  private async mark(key: string, outcome: WriteOutcome, resultRef?: string): Promise<void> {
    await update<WriteIndex>(this.area, INDEX_KEY, { records: [] }, (index) => ({
      records: index.records.map((record) =>
        record.key === key
          ? {
              ...record,
              outcome,
              settledAt: this.now(),
              ...(resultRef === undefined ? {} : { resultRef }),
            }
          : record,
      ),
    }));
  }
}

/**
 * Whether a failure leaves the remote outcome unknown.
 *
 * A refusal the service articulated — 400, 403, 422 — means it decided not
 * to act, so nothing happened. A timeout or a dropped connection means the
 * request may have been fully processed and only the answer was lost.
 */
export function outcomeIsUncertain(error: unknown, status?: number): boolean {
  if (status !== undefined) {
    // 5xx is ambiguous: a gateway can time out after the origin committed.
    return status >= 500;
  }
  if (error instanceof DOMException) {
    return error.name === 'TimeoutError' || error.name === 'AbortError';
  }
  // An unclassified transport failure is ambiguous by definition.
  return true;
}
