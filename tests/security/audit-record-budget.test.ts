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
  serialisedWidth,
  MAX_MODEL_ID,
} from '@/audit/boundaries';
import { AUDIT_EVENT_TYPES, AuditLog, assertAuditShape } from '@/audit/audit-log';
import { isRecordableModelId } from '@/providers/core/provider-http';
import { parseModelCatalogue } from '@/providers/adapters/nine-router-catalog';
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

describe('TEST-BUDGET-001 — the proof survives JSON escaping', () => {
  const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

  /**
   * Character classes that serialise to more than they measure.
   *
   * This is the gap the earlier proof had. It filled every string field with
   * `'s'`, which JSON writes as one character, so the arithmetic was only ever
   * checked against the one class of content that does not expand. Measured
   * with the others, two event types crossed the 4096 budget on quotes alone
   * (`connector.auth` reached 5505) and seventeen crossed it on control
   * characters (up to 15745) — while every field was inside its own limit,
   * because the limits counted code units and the budget counted serialised
   * characters.
   */
  const CLASSES: Record<string, (n: number) => string> = {
    // One serialised character each: the baseline, and the only class the
    // original proof used.
    ascii: (n) => 's'.repeat(n),
    // Two each: `\"` and `\\`.
    quotes: (n) => '"'.repeat(n),
    backslashes: (n) => '\\'.repeat(n),
    // Six each: `\u0000`.
    nul: (n) => '\u0000'.repeat(n),
    controls: (n) => '\u0001'.repeat(n),
    // One per code unit: non-ASCII is left literal, so emoji cost exactly
    // their code-unit length and a 256 limit still means 128 of them.
    emoji: (n) => '🙂'.repeat(Math.floor(n / 2)),
    unicode: (n) => 'é日'.repeat(Math.floor(n / 2)),
    // All of them at once, which is what an adversarial producer would send.
    mixed: (n) => '"\u0001s🙂\\'.repeat(Math.max(1, Math.floor(n / 5))),
  };

  /** The widest value of this class that still satisfies the field's bound. */
  function atLimit(fill: (n: number) => string, limit: number): string {
    let n = limit;
    while (n > 0 && serialisedWidth(fill(n)) > limit) n -= 1;
    return fill(n);
  }

  it('09 — the measure is the real serialiser, and it sees the expansion', () => {
    // Stated first, because every case below depends on it. If this is
    // measuring code units the rest of the file proves nothing.
    expect(serialisedWidth('s')).toBe(1);
    expect(serialisedWidth('"')).toBe(2);
    expect(serialisedWidth('\\')).toBe(2);
    expect(serialisedWidth('\u0000')).toBe(6);
    expect(serialisedWidth('\u0001')).toBe(6);
    // Non-ASCII is not escaped, so it costs its code units and nothing more.
    expect(serialisedWidth('🙂')).toBe(2);
    expect(serialisedWidth('é')).toBe(1);
    // A lone surrogate is escaped, which `length` alone would miss entirely.
    expect(serialisedWidth('\ud800')).toBe(6);
    // And it agrees with the serialiser that actually writes the record.
    for (const value of ['s', '"', '\\', '\u0000', '🙂', 'é', '\ud800']) {
      expect(serialisedWidth(value), JSON.stringify(value)).toBe(JSON.stringify(value).length - 2);
    }
  });

  for (const [label, fill] of Object.entries(CLASSES)) {
    it(`10 — every type fits ${MAX_EVENT_BYTES} when filled with ${label}`, async () => {
      for (const type of AUDIT_EVENT_TYPES) {
        const fields = INVENTORY.get(type) ?? new Set<string>();
        const event: Record<string, unknown> = { type, outcome: 'info' };
        for (const field of fields) {
          if (field === 'type' || field === 'outcome' || field === 'at') continue;
          if (ARRAY_FIELDS.has(field)) {
            event[field] = Array.from({ length: arrayLimit(field) }, () =>
              atLimit(fill, MAX_ARRAY_STRING),
            );
          } else if (NUMERIC_FIELDS.has(field)) event[field] = 1_700_000_000_000;
          else if (BOOLEAN_FIELDS.has(field)) event[field] = true;
          // Opaque ids are this build's own and cannot contain any of this.
          else if (OPAQUE_ID_FIELDS.has(field)) event[field] = 'a'.repeat(MAX_OPAQUE_ID);
          else event[field] = atLimit(fill, fieldLimit(field));
        }

        // Accepted — not refused. A refusal would be audit loss, which is the
        // outcome this whole bound exists to prevent, so "the validator caught
        // it" is not a passing answer here.
        const log = new AuditLog(area(), { knownTool: () => true });
        const written = await log.record(event as never);
        expect(
          written,
          `${type} filled with ${label} was refused: ${log.degradedReason()}`,
        ).not.toBeNull();

        const observed = JSON.stringify(written).length;
        expect(observed, `${type} with ${label} serialised to ${observed}`).toBeLessThanOrEqual(
          MAX_EVENT_BYTES,
        );
        // And the model still bounds the measurement for this class. This is
        // the assertion that fails if `fieldValueWidth` goes back to costing a
        // string at its code-unit length.
        const computed = recordWidth(fields);
        expect(
          computed,
          `${type} with ${label}: computed ${computed} but stored ${observed}`,
        ).toBeGreaterThanOrEqual(observed);
      }
    });
  }

  it('11 — the widest record over all classes is named, with its margin', async () => {
    let worst = { type: '', label: '', observed: 0 };
    for (const [label, fill] of Object.entries(CLASSES)) {
      for (const type of AUDIT_EVENT_TYPES) {
        const fields = INVENTORY.get(type) ?? new Set<string>();
        const event: Record<string, unknown> = { type, outcome: 'info' };
        for (const field of fields) {
          if (field === 'type' || field === 'outcome' || field === 'at') continue;
          if (ARRAY_FIELDS.has(field)) {
            event[field] = Array.from({ length: arrayLimit(field) }, () =>
              atLimit(fill, MAX_ARRAY_STRING),
            );
          } else if (NUMERIC_FIELDS.has(field)) event[field] = 1_700_000_000_000;
          else if (BOOLEAN_FIELDS.has(field)) event[field] = true;
          else if (OPAQUE_ID_FIELDS.has(field)) event[field] = 'a'.repeat(MAX_OPAQUE_ID);
          else event[field] = atLimit(fill, fieldLimit(field));
        }
        const log = new AuditLog(area(), { knownTool: () => true });
        const written = await log.record(event as never);
        const observed = JSON.stringify(written).length;
        if (observed > worst.observed) worst = { type, label, observed };
      }
    }
    expect(
      MAX_EVENT_BYTES - worst.observed,
      `the widest record is ${worst.type} filled with ${worst.label} at ${worst.observed} of ${MAX_EVENT_BYTES}`,
    ).toBeGreaterThan(MAX_EVENT_BYTES / 10);
  });

  it('12 — a value over its serialised bound is refused at the field, naming it', () => {
    // The other half of requirement: a record that cannot fit is rejected
    // before it can be appended, and the refusal says which field — so the
    // chain is never extended with something unreadable.
    const overQuoted = '"'.repeat(fieldLimit('modelId'));
    expect(serialisedWidth(overQuoted)).toBeGreaterThan(fieldLimit('modelId'));
    expect(() =>
      assertAuditShape({ type: 'egress.decided', outcome: 'allowed', modelId: overQuoted }),
    ).toThrow(/modelId/);

    // And the same content one character inside the bound is accepted, so the
    // case above is not passing because everything throws.
    const justInside = atLimit((n) => '"'.repeat(n), fieldLimit('modelId'));
    expect(() =>
      assertAuditShape({ type: 'egress.decided', outcome: 'allowed', modelId: justInside }),
    ).not.toThrow();
  });

  it('12b — an array *entry* over its serialised bound is refused too', () => {
    // The same rule, on the other kind of field, and it needs its own case.
    // A mutation that reverted only the array-entry check to `entry.length`
    // survived the whole suite: every other case here builds its arrays with
    // `atLimit`, which measures serialised width and therefore keeps producing
    // legal entries whatever the validator does. Nothing was asserting that an
    // illegal one is rejected.
    //
    // It matters because the array fields are the widest contributors to the
    // record. Sixteen `scopes` of 128 quote characters measure 128 each by
    // `length` and 256 each once written — which is how `connector.auth` came
    // to serialise to 5505 characters against a 4096 budget with every field
    // inside its own limit.
    const overQuoted = '"'.repeat(MAX_ARRAY_STRING);
    expect(serialisedWidth(overQuoted)).toBeGreaterThan(MAX_ARRAY_STRING);
    expect(() =>
      assertAuditShape({
        type: 'connector.auth',
        outcome: 'allowed',
        scopes: [overQuoted],
      }),
    ).toThrow(/scopes/);

    // Control characters expand six-fold, so even a short entry can cross it.
    expect(() =>
      assertAuditShape({
        type: 'connector.auth',
        outcome: 'allowed',
        scopes: ['\u0000'.repeat(Math.floor(MAX_ARRAY_STRING / 6) + 1)],
      }),
    ).toThrow(/scopes/);

    // And a full-width entry inside the serialised bound is accepted, so the
    // cases above are not passing because every array throws.
    const justInside = atLimit((n) => '"'.repeat(n), MAX_ARRAY_STRING);
    expect(serialisedWidth(justInside)).toBeLessThanOrEqual(MAX_ARRAY_STRING);
    expect(() =>
      assertAuditShape({
        type: 'connector.auth',
        outcome: 'allowed',
        scopes: Array.from({ length: arrayLimit('scopes') }, () => justInside),
      }),
    ).not.toThrow();
  });

  it('13 — an id no record could carry is refused at admission, not at the record', () => {
    // Where the bound has to be enforced for the trail to stay complete. If
    // the only check were at the record, the model would be offered, selected,
    // used — and every request made with it would lose its audit record while
    // succeeding, which is the defect this bound was introduced for.
    expect(isRecordableModelId('s'.repeat(MAX_MODEL_ID))).toBe(true);
    expect(isRecordableModelId('s'.repeat(MAX_MODEL_ID + 1))).toBe(false);
    // 256 code units, 512 serialised: admitted by a `length` check and
    // unrecordable in fact.
    expect(isRecordableModelId('"'.repeat(MAX_MODEL_ID))).toBe(false);
    expect(isRecordableModelId('\u0000'.repeat(MAX_MODEL_ID))).toBe(false);
    // Emoji are not escaped, so 128 of them fit exactly and are admitted.
    expect(isRecordableModelId('🙂'.repeat(MAX_MODEL_ID / 2))).toBe(true);

    // And the catalogue parser refuses such an entry rather than shortening it,
    // so it never becomes selectable.
    const hostile = parseModelCatalogue({
      object: 'list',
      data: [
        { id: '"'.repeat(MAX_MODEL_ID), object: 'model', owned_by: 'cx' },
        { id: 'cx/fine', object: 'model', owned_by: 'cx' },
      ],
    });
    expect(hostile.models.map((model) => model.id)).toEqual(['cx/fine']);
    expect(hostile.refused.map((entry) => entry.reason)).toEqual(['id-unrecordable']);
  });
});
