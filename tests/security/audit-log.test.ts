/**
 * TEST-SECURITY-017 — unified audit trail and export (Stage 3 Wave B).
 *
 * The trail exists to answer "what did the agent do", and the danger in
 * building one is that it quietly becomes a second copy of everything the
 * evidence model was careful not to keep. These tests hold the opposite
 * property: the trail records decisions and references, and refuses anything
 * that looks like the data behind them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import {
  AuditLog,
  ProhibitedAuditFieldError,
  assertAuditSafe,
  buildAuditExport,
} from '@/audit/audit-log';

let area: MemoryStorageArea;
let audit: AuditLog;

beforeEach(() => {
  area = new MemoryStorageArea();
  audit = new AuditLog(new SerializedStorageArea(area), { now: () => 1_700_000_000_000 });
});

describe('recording', () => {
  it('records a permission decision', async () => {
    const event = await audit.record({
      type: 'permission.decided',
      taskId: 'task_1',
      tool: 'browser.navigate',
      site: 'example.com',
      risk: 'R2',
      outcome: 'allowed',
      code: 'approved',
    });
    expect(event.id).toMatch(/^aud_/);
    expect(event.at).toBe(1_700_000_000_000);
    expect(await audit.list()).toHaveLength(1);
  });

  it('records an egress decision pointing at evidence rather than repeating it', async () => {
    await audit.record({
      type: 'egress.decided',
      taskId: 'task_1',
      destination: 'https://elsewhere.example',
      outcome: 'denied',
      code: 'CONSENT_REQUIRED',
      evidenceIds: ['ev_1'],
    });
    const [event] = await audit.list();
    expect(event!.evidenceIds).toEqual(['ev_1']);
    // The digest and the size stay in evidence; the trail holds neither.
    expect(JSON.stringify(event)).not.toMatch(/payloadDigest|payloadBytes/);
  });

  it('returns events newest first', async () => {
    await audit.record({ type: 'task.created', taskId: 'a', outcome: 'info', at: 1 });
    await audit.record({ type: 'task.created', taskId: 'b', outcome: 'info', at: 2 });
    expect((await audit.list()).map((e) => e.taskId)).toEqual(['b', 'a']);
  });

  it('loses nothing when events are recorded concurrently', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        audit.record({ type: 'tool.invoked', taskId: `t${i}`, outcome: 'allowed' }),
      ),
    );
    expect(await audit.list(100)).toHaveLength(25);
  });

  it('caps retention and drops the oldest first', async () => {
    const small = new AuditLog(new SerializedStorageArea(area), { maxEvents: 3 });
    for (let i = 0; i < 6; i += 1) {
      await small.record({ type: 'tool.invoked', taskId: `t${i}`, outcome: 'allowed', at: i });
    }
    const events = await small.list();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.taskId)).toEqual(['t5', 't4', 't3']);
  });
});

describe('querying across tasks', () => {
  beforeEach(async () => {
    await audit.record({
      type: 'tool.invoked',
      taskId: 'a',
      site: 'example.com',
      outcome: 'allowed',
    });
    await audit.record({
      type: 'tool.invoked',
      taskId: 'b',
      site: 'other.example',
      outcome: 'allowed',
    });
    await audit.record({
      type: 'tool.refused',
      taskId: 'a',
      site: 'example.com',
      outcome: 'denied',
    });
  });

  it('filters by task', async () => {
    expect(await audit.forTask('a')).toHaveLength(2);
  });

  it('answers what happened on a site, which is the point of unifying it', async () => {
    const events = await audit.forSite('example.com');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.site === 'example.com')).toBe(true);
  });

  it('matches a site case-insensitively', async () => {
    expect(await audit.forSite('EXAMPLE.com')).toHaveLength(2);
  });
});

describe('sensitive material is refused, not redacted after the fact', () => {
  it.each([
    'password',
    'secret',
    'token',
    'cookie',
    'apiKey',
    'api_key',
    'authorization',
    'credentials',
    'session',
    'payload',
    'content',
    'body',
  ])('rejects a record carrying "%s"', (field) => {
    expect(() => assertAuditSafe({ type: 'tool.invoked', [field]: 'anything' })).toThrow(
      ProhibitedAuditFieldError,
    );
  });

  it('refuses the write rather than storing a stripped version', async () => {
    await expect(
      audit.record({
        type: 'tool.invoked',
        outcome: 'allowed',
        // A caller spreading a wider object into the record.
        ...({ password: 'hunter2' } as unknown as Record<string, never>),
      }),
    ).rejects.toThrow(ProhibitedAuditFieldError);

    expect(await audit.list()).toHaveLength(0);
  });

  it('still redacts a secret-shaped value that arrives in an allowed field', async () => {
    // `detail` is extension-authored, so this should not happen — but if it
    // does, the value must not land in storage intact.
    const event = await audit.record({
      type: 'tool.refused',
      outcome: 'denied',
      detail: 'refused: sk-abcdefghijklmnopqrstuvwxyz0123456789012345',
    });
    expect(event.detail).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });
});

describe('export', () => {
  it('states in the document what it does not contain', () => {
    const doc = buildAuditExport([], 1);
    expect(doc.format).toBe('aiba-audit/1');
    expect(doc.notice).toMatch(/no page content/i);
    expect(doc.notice).toMatch(/no credentials/i);
  });

  it('carries the events and their count', async () => {
    await audit.record({ type: 'task.created', taskId: 'a', outcome: 'info' });
    const doc = buildAuditExport(await audit.list(), 2);
    expect(doc.eventCount).toBe(1);
    expect(doc.events[0]!.taskId).toBe('a');
  });

  it('refuses to build from an event carrying prohibited material', () => {
    const poisoned = [
      { id: 'x', at: 1, type: 'tool.invoked', outcome: 'allowed', cookie: 'a=b' },
    ] as never;
    expect(() => buildAuditExport(poisoned, 1)).toThrow(ProhibitedAuditFieldError);
  });

  it('writes nothing anywhere, so building an export is not itself a transfer', async () => {
    // The separation that keeps export from becoming an unguarded way out:
    // building the document is pure, and moving it is a separate decision.
    await audit.record({ type: 'task.created', taskId: 'a', outcome: 'info' });
    const before = JSON.stringify(await area.get('audit:audit-index'));
    buildAuditExport(await audit.list(), 3);
    const after = JSON.stringify(await area.get('audit:audit-index'));
    expect(after).toBe(before);
  });

  it('contains no page text even when the trail describes a page action', async () => {
    await audit.record({
      type: 'tool.invoked',
      taskId: 'a',
      tool: 'browser.read_page',
      site: 'example.com',
      outcome: 'allowed',
      evidenceIds: ['ev_page'],
    });
    const serialised = JSON.stringify(buildAuditExport(await audit.list(), 4));
    expect(serialised).toContain('ev_page');
    expect(serialised).toContain('browser.read_page');
    // The reference is there; the thing it references is not.
    expect(serialised).not.toMatch(/Widget Catalogue|hunter2/);
  });
});
