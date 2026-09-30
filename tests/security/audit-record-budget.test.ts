/**
 * TEST-BUDGET-001 — the whole-record budget, proved for every event type.
 *
 * The previous phase closed five producer/consumer mismatches and left this one
 * open with the honest note that it was argued rather than proved. The argument
 * was: every field is inside its own limit, and no producer fills them all. The
 * gap was that `MAX_ARRAY_ENTRIES × MAX_ARRAY_STRING` — 32 × 128 — serialises to
 * about 4190 characters on its own, more than `MAX_EVENT_BYTES`. So the
 * field-level bounds did **not** imply the record bound, and three types could
 * cross it while every field was legal: `egress.decided`, `connector.operation`
 * and `connector.auth`.
 *
 * "No producer does this today" is the argument that preceded every other defect
 * in `boundaries.ts`, so it is not relied on here. `MAX_ARRAY_ENTRIES` is now 8,
 * and this file proves the implication holds.
 *
 * It proves it without a hand-kept table. The event types and the fields each
 * one carries are read out of `src/` by scanning for the audit record literals,
 * so a field added to a record, or a new record type, is measured on the next
 * run rather than whenever somebody remembers to update a list. A table here
 * would drift exactly the way the two constants drifted.
 */
import { describe, expect, it } from 'vitest';
import { auditFieldInventory } from '../helpers/audit-inventory';
import {
  ARRAY_FIELDS,
  BOOLEAN_FIELDS,
  arrayLimit,
  MAX_ARRAY_STRING,
  MAX_EVENT_BYTES,
  MAX_OPAQUE_ID,
  NUMERIC_FIELDS,
  OPAQUE_ID_FIELDS,
  recordWidth,
  fieldLimit,
} from '@/audit/boundaries';
import { AUDIT_EVENT_TYPES, AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';

const INVENTORY = auditFieldInventory(AUDIT_EVENT_TYPES);

describe('TEST-BUDGET-001 — the population is real', () => {
  it('01 — every declared event type has a producer in src/', () => {
    // The population assertion, in the direction that matters here: a type this
    // file does not measure is a type the budget is unproved for.
    const missing = AUDIT_EVENT_TYPES.filter((type) => !INVENTORY.has(type));
    expect(missing, 'declared types with no record literal found').toEqual([]);
    expect(AUDIT_EVENT_TYPES.length).toBeGreaterThanOrEqual(50);
    expect(INVENTORY.size).toBe(AUDIT_EVENT_TYPES.length);
  });

  it('02 — the scan found real fields, so an empty scan cannot pass', () => {
    // Without this, a scanner that silently matched nothing would "prove" the
    // budget for 50 empty records.
    const total = [...INVENTORY.values()].reduce((sum, set) => sum + set.size, 0);
    expect(total).toBeGreaterThan(150);
    // And the types known to be the widest must have found their widest fields.
    expect([...(INVENTORY.get('egress.decided') ?? [])].sort()).toContain('evidenceIds');
    expect([...(INVENTORY.get('connector.auth') ?? [])].sort()).toContain('scopes');
    expect([...(INVENTORY.get('file.downloaded') ?? [])].sort()).toContain('fileName');
  });
});

describe('TEST-BUDGET-001 — every type fits the record budget', () => {
  for (const type of AUDIT_EVENT_TYPES) {
    it(`03 — ${type} at its widest fits ${MAX_EVENT_BYTES}`, () => {
      const fields = INVENTORY.get(type) ?? new Set<string>();
      const width = recordWidth(fields);
      expect(
        width,
        `${type} can reach ${width} characters with fields: ${[...fields].sort().join(', ')}`,
      ).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    });
  }

  it('04 — the widest type is reported, so the margin is visible', () => {
    const widths = AUDIT_EVENT_TYPES.map((type) => ({
      type,
      width: recordWidth(INVENTORY.get(type) ?? new Set<string>()),
    })).sort((a, b) => b.width - a.width);
    const widest = widths[0]!;
    // Not an arbitrary assertion: it fails if the margin ever falls below a
    // tenth of the budget, which is the point at which the next added field is
    // likely to cross it and somebody should look rather than be surprised.
    expect(
      MAX_EVENT_BYTES - widest.width,
      `${widest.type} is the widest at ${widest.width} of ${MAX_EVENT_BYTES}`,
    ).toBeGreaterThan(MAX_EVENT_BYTES / 10);
  });
});

describe('TEST-BUDGET-001 — the real log agrees, at real maxima', () => {
  const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

  /** A value of the right shape, at the widest the contract allows. */
  function widest(field: string): unknown {
    if (ARRAY_FIELDS.has(field)) {
      return Array.from({ length: arrayLimit(field) }, () => 'e'.repeat(MAX_ARRAY_STRING));
    }
    if (NUMERIC_FIELDS.has(field)) return 1_700_000_000_000;
    if (BOOLEAN_FIELDS.has(field)) return true;
    if (OPAQUE_ID_FIELDS.has(field)) return 'a'.repeat(MAX_OPAQUE_ID);
    return 's'.repeat(fieldLimit(field));
  }

  for (const type of AUDIT_EVENT_TYPES) {
    it(`05 — the log stores a maximal ${type}`, async () => {
      const log = new AuditLog(area(), { knownTool: () => true });
      const event: Record<string, unknown> = { type, outcome: 'info' };
      for (const field of INVENTORY.get(type) ?? []) {
        if (field === 'type' || field === 'outcome' || field === 'at') continue;
        event[field] = widest(field);
      }
      // Computed width and observed acceptance have to agree. If the log refuses
      // this, the arithmetic above is wrong — which is the failure worth having.
      const written = await log.record(event as never);
      expect(written, `a maximal ${type} was refused: ${log.degradedReason()}`).not.toBeNull();
      const observed = JSON.stringify(written).length;
      expect(observed).toBeLessThanOrEqual(MAX_EVENT_BYTES);
      // The arithmetic has to be an over-estimate of the real thing, not merely a
      // number under the budget. Two mutations — costing a list as a scalar, and
      // forgetting the fields `append` adds — left the computed width far below
      // reality and every "is it under 4096" case still passed. This is the
      // assertion that catches them: the model must bound the measurement.
      const computed = recordWidth(INVENTORY.get(type) ?? new Set<string>());
      expect(
        computed,
        `${type}: computed ${computed} but the stored record is ${observed}`,
      ).toBeGreaterThanOrEqual(observed);
    });
  }
});

describe('TEST-BUDGET-001 — multibyte content', () => {
  const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

  it('06 — the budget is counted in code units, and UTF-8 bytes exceed it', async () => {
    // Worth stating rather than assuming: `assertAuditShape` measures
    // `JSON.stringify(event).length`, which is UTF-16 code units. A record of
    // emoji therefore occupies more *bytes* on disk than the number the check
    // compared. That is a property of the limit, not a defect — storage is
    // quota-bounded separately and compaction handles it — but a reader of
    // "4096 bytes" should know it is 4096 code units.
    const log = new AuditLog(area(), { knownTool: () => true });
    // `MAX_FILENAME` is odd and an emoji is two code units, so the widest whole
    // number of them is one short of the limit.
    const emoji = '🙂'.repeat(Math.floor(fieldLimit('fileName') / 2));
    expect(emoji.length).toBe(fieldLimit('fileName') - 1);
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(emoji.length);
    const written = await log.record({
      type: 'file.selected',
      outcome: 'allowed',
      fileName: emoji,
    } as never);
    expect(written).not.toBeNull();
    expect(written?.fileName).toBe(emoji);
  });

  it('07 — a surrogate pair is never split, because nothing truncates', async () => {
    // The failure a character-counted limit invites is a slice through a
    // surrogate pair, which yields a lone surrogate and a record that no longer
    // round-trips. Nothing in the record path truncates, so this holds — and it
    // is asserted rather than assumed.
    const log = new AuditLog(area(), { knownTool: () => true });
    const name = `${'🙂'.repeat(126)}ab`;
    expect(name.length).toBe(254);
    const written = await log.record({
      type: 'file.selected',
      outcome: 'allowed',
      fileName: name,
    } as never);
    expect(written?.fileName).toBe(name);
    expect(JSON.parse(JSON.stringify(written)).fileName).toBe(name);
    expect([...(written?.fileName ?? '')].length).toBe(128);
  });

  it('08 — a list of multibyte entries at full cardinality still fits', async () => {
    const log = new AuditLog(area(), { knownTool: () => true });
    const entries = Array.from({ length: arrayLimit('evidenceIds') }, () =>
      '🙂'.repeat(MAX_ARRAY_STRING / 2),
    );
    expect(entries[0]!.length).toBe(MAX_ARRAY_STRING);
    const written = await log.record({
      type: 'egress.decided',
      taskId: 'task_abc',
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
      evidenceIds: entries,
    } as never);
    expect(written).not.toBeNull();
  });
});

describe('TEST-BUDGET-001 — the bounds still refuse what they refused', () => {
  const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

  it('09 — one entry over the cardinality is refused', async () => {
    const log = new AuditLog(area(), { knownTool: () => true });
    const entries = (n: number): string[] => Array.from({ length: n }, () => 'e');
    // Per field, so each is checked at its own limit rather than at a shared one.
    for (const [field, type] of [
      ['scopes', 'connector.auth'],
      ['evidenceIds', 'egress.decided'],
    ] as const) {
      const limit = arrayLimit(field);
      const base =
        type === 'egress.decided'
          ? { type, taskId: 'task_abc', tool: 'provider.request', outcome: 'allowed' }
          : { type, outcome: 'allowed' };
      expect(
        await log.record({ ...base, [field]: entries(limit) } as never),
        `${field} at ${limit}`,
      ).not.toBeNull();
      expect(
        await log.record({ ...base, [field]: entries(limit + 1) } as never),
        `${field} at ${limit + 1}`,
      ).toBeNull();
    }
    // And the two limits are genuinely different, which is the point of splitting
    // them: a flat number would have had to serve the widest record.
    expect(arrayLimit('scopes')).not.toBe(arrayLimit('evidenceIds'));
  });

  it('10 — an oversized record is still refused, and now names itself', async () => {
    // The budget is not weakened. A record that somehow arrives over it is
    // refused, and the refusal says so rather than naming a field.
    const reports: { state: string; reason: string }[] = [];
    const log = new AuditLog(area(), {
      knownTool: () => true,
      health: {
        report: async (_d: unknown, state: string, reason: string): Promise<void> => {
          reports.push({ state, reason });
        },
      } as never,
    });
    // Every field inside its own limit; the record over the budget. Only
    // reachable by hand, which is the point of asserting it.
    const wide: Record<string, unknown> = { type: 'task.state', taskId: 'task_1', outcome: 'info' };
    for (let i = 0; i < 40; i++) wide[`spare${i}`] = 's'.repeat(200);
    expect(await log.record(wide as never)).toBeNull();
    expect(reports).toEqual([
      { state: 'CORRUPT', reason: 'a record could not be shaped: (record)' },
    ]);
  });
});
