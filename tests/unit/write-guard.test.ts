/**
 * TEST-CONNECTOR-003 — duplicate-write protection.
 *
 * The failure this stands against is not a model calling a tool twice. It is
 * the one where the write **succeeded and we do not know it**: the request
 * times out, the socket drops, or the worker is evicted after the service
 * committed the change but before the answer came back. Retrying then files
 * a second issue.
 *
 * So the load-bearing assertions here are the ones about `uncertain`. A guard
 * that only deduplicated confirmed successes would pass half this file and
 * still send the duplicate.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { outcomeIsUncertain, WriteGuard, writeKey } from '@/connectors/core/write-guard';

const TASK = 'task_1';
let clock = 1_700_000_000_000;
let guard: WriteGuard;
let area: SerializedStorageArea;

beforeEach(() => {
  clock = 1_700_000_000_000;
  area = new SerializedStorageArea(new MemoryStorageArea());
  guard = new WriteGuard(area, () => clock);
});

async function key(args: unknown, overrides: Record<string, string> = {}): Promise<string> {
  return await writeKey({
    taskId: TASK,
    connectorId: 'github',
    operationId: 'create_issue',
    args,
    ...overrides,
  });
}

function claimFor(k: string) {
  return guard.claim({ key: k, connectorId: 'github', operationId: 'create_issue', taskId: TASK });
}

describe('the write key', () => {
  it('is the same for the same intent', async () => {
    expect(await key({ title: 'a', body: 'b' })).toBe(await key({ title: 'a', body: 'b' }));
  });

  it('ignores the order the arguments were written in', async () => {
    // `{a,b}` and `{b,a}` are the same write. A key that distinguished them
    // would let a re-serialised retry slip past the guard.
    expect(await key({ title: 'a', body: 'b' })).toBe(await key({ body: 'b', title: 'a' }));
  });

  it('canonicalises nested objects and preserves array order', async () => {
    expect(await key({ o: { x: 1, y: 2 }, list: [1, 2] })).toBe(
      await key({ o: { y: 2, x: 1 }, list: [1, 2] }),
    );
    // Array order is meaning, not formatting.
    expect(await key({ list: [1, 2] })).not.toBe(await key({ list: [2, 1] }));
  });

  it('separates two different writes', async () => {
    expect(await key({ title: 'a' })).not.toBe(await key({ title: 'b' }));
  });

  it('separates the same write in different tasks, connectors and operations', async () => {
    const base = await key({ title: 'a' });
    expect(await key({ title: 'a' }, { taskId: 'task_2' })).not.toBe(base);
    expect(await key({ title: 'a' }, { connectorId: 'other' })).not.toBe(base);
    expect(await key({ title: 'a' }, { operationId: 'comment_issue' })).not.toBe(base);
  });

  it('is a hex digest, not the arguments', async () => {
    const k = await key({ title: 'secret-sounding title', body: 'sensitive body' });
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain('secret');
  });
});

describe('claiming', () => {
  it('lets a first attempt proceed', async () => {
    expect(await claimFor(await key({ title: 'a' }))).toMatchObject({ kind: 'proceed' });
  });

  it('persists the claim before the request, so an eviction leaves a trace', async () => {
    const k = await key({ title: 'a' });
    await claimFor(k);
    // Nothing settled it: the record exists and says a request went out.
    const records = await guard.list(TASK);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ key: k, outcome: 'in_flight', operationId: 'create_issue' });
  });

  it('refuses a second attempt while the first is still in flight', async () => {
    const k = await key({ title: 'a' });
    await claimFor(k);
    expect(await claimFor(k)).toMatchObject({ kind: 'in_flight' });
  });

  it('returns the recorded outcome instead of resending a completed write', async () => {
    const k = await key({ title: 'a' });
    await claimFor(k);
    await guard.settle(k, 'completed', 'https://service.test/issues/7');

    const replay = await claimFor(k);
    expect(replay.kind).toBe('already_completed');
    if (replay.kind === 'already_completed') {
      expect(replay.record.resultRef).toBe('https://service.test/issues/7');
    }
  });

  it('refuses to replay a write whose outcome is unknown', async () => {
    // The case the whole module exists for. A machine cannot find out
    // whether the issue was filed; only a person can look.
    const k = await key({ title: 'a' });
    await claimFor(k);
    await guard.markUncertain(k);
    expect(await claimFor(k)).toMatchObject({ kind: 'uncertain' });
  });

  it('allows a retry of a write the service explicitly rejected', async () => {
    // The service answered and said no, so nothing happened on its side.
    // Refusing the retry here would block a legitimate correction.
    const k = await key({ title: 'a' });
    await claimFor(k);
    await guard.settle(k, 'failed');
    expect(await claimFor(k)).toMatchObject({ kind: 'proceed' });
  });

  it('lets a confirmed replay through once the record is forgotten', async () => {
    const k = await key({ title: 'a' });
    await claimFor(k);
    await guard.markUncertain(k);
    await guard.forget(k);
    expect(await claimFor(k)).toMatchObject({ kind: 'proceed' });
  });

  it('does not confuse two concurrent writes in one task', async () => {
    const first = await key({ title: 'a' });
    const second = await key({ title: 'b' });
    expect(await claimFor(first)).toMatchObject({ kind: 'proceed' });
    expect(await claimFor(second)).toMatchObject({ kind: 'proceed' });
    expect(await guard.list(TASK)).toHaveLength(2);
  });

  it('serialises two simultaneous claims of the same key', async () => {
    // Two tool calls landing at once must not both be told to proceed.
    const k = await key({ title: 'a' });
    const [a, b] = await Promise.all([claimFor(k), claimFor(k)]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['in_flight', 'proceed']);
  });

  it('survives a storage round trip, as a worker restart would', async () => {
    const k = await key({ title: 'a' });
    await claimFor(k);
    await guard.markUncertain(k);

    // A new guard over the same area is what the next worker generation sees.
    const revived = new WriteGuard(area, () => clock);
    expect(
      await revived.claim({
        key: k,
        connectorId: 'github',
        operationId: 'create_issue',
        taskId: TASK,
      }),
    ).toMatchObject({ kind: 'uncertain' });
  });
});

describe('the record index', () => {
  it('scopes a listing to one task', async () => {
    await claimFor(await key({ title: 'a' }));
    await guard.claim({
      key: await key({ title: 'a' }, { taskId: 'task_2' }),
      connectorId: 'github',
      operationId: 'create_issue',
      taskId: 'task_2',
    });
    expect(await guard.list(TASK)).toHaveLength(1);
    expect(await guard.list()).toHaveLength(2);
  });

  it('drops records older than the retention window', async () => {
    const old = await key({ title: 'old' });
    await claimFor(old);
    await guard.markUncertain(old);

    clock += 8 * 24 * 3600_000;
    // A week-old uncertain write is no longer useful: whatever happened has
    // long since been seen, and holding it would block a legitimate retry
    // forever.
    expect(await claimFor(old)).toMatchObject({ kind: 'proceed' });
  });

  it('keeps a record that is inside the window', async () => {
    const k = await key({ title: 'a' });
    await claimFor(k);
    await guard.markUncertain(k);
    clock += 6 * 24 * 3600_000;
    expect(await claimFor(k)).toMatchObject({ kind: 'uncertain' });
  });

  it('caps how many records it keeps', async () => {
    for (let i = 0; i < 260; i += 1) {
      await guard.claim({
        key: await key({ n: i }),
        connectorId: 'github',
        operationId: 'create_issue',
        taskId: TASK,
      });
    }
    expect((await guard.list()).length).toBeLessThanOrEqual(200);
  });

  it('keeps the newest records when it evicts', async () => {
    for (let i = 0; i < 210; i += 1) {
      await guard.claim({
        key: await key({ n: i }),
        connectorId: 'github',
        operationId: 'create_issue',
        taskId: TASK,
      });
    }
    const newest = await key({ n: 209 });
    const records = await guard.list();
    expect(records.some((record) => record.key === newest)).toBe(true);
  });
});

describe('deciding whether an outcome is knowable', () => {
  it.each([
    ['400, the service rejected the request', 400, false],
    ['401, it refused the credential', 401, false],
    ['403, it refused the operation', 403, false],
    ['404, there was nothing to write to', 404, false],
    ['409, it said the state conflicts', 409, false],
    ['422, it said the request is invalid', 422, false],
    ['429, it declined to process', 429, false],
    ['500, it may have committed first', 500, true],
    ['502, a gateway answered, not the origin', 502, true],
    ['503, likewise', 503, true],
    ['504, the gateway timed out after forwarding', 504, true],
  ])('%s → uncertain: %s', (_label, status, uncertain) => {
    expect(outcomeIsUncertain(undefined, status)).toBe(uncertain);
  });

  it('treats a timeout as unknown', () => {
    expect(outcomeIsUncertain(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it('treats an abort as unknown', () => {
    // The request was cancelled locally; the service may already have acted.
    expect(outcomeIsUncertain(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('treats an unclassified transport failure as unknown', () => {
    expect(outcomeIsUncertain(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('prefers the status when one is present', () => {
    // A status means the service answered, whatever error object came with it.
    expect(outcomeIsUncertain(new TypeError('x'), 422)).toBe(false);
  });
});
