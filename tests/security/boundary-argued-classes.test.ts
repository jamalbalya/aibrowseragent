/**
 * TEST-ARGUED-001 — the classes the previous phase argued rather than asserted.
 *
 * That phase's census covered every value whose consumer *refuses*, and closed
 * five defects. It then listed a handful of classes it had reasoned about and not
 * measured: storage keys, consent keys, error messages, the `detail` producers
 * outside the file tools, and the identifiers that are build constants. Each was
 * argued safe on a premise — "no refusing consumer", "a build constant", "bounded
 * by its input".
 *
 * Every premise in this file is now a case. That matters because the one premise
 * of the same kind that was *not* checked — "no producer can author a skill id
 * today" — turned out to be false: the import path is a producer, and it had been
 * there all along. A premise nobody executes is a premise nobody has tested.
 *
 * Where a class genuinely has no refusing consumer, the case says so and pins the
 * property the safety actually rests on, rather than pretending a bound exists.
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_TYPES, AuditLog } from '@/audit/audit-log';
import { auditFieldInventory, declaredAuditFields } from '../helpers/audit-inventory';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ConsentStore } from '@/security/egress/consent';
import { providerDestination } from '@/security/egress/destination';
import {
  MAX_DESTINATION,
  MAX_OPAQUE_ID,
  MAX_STRING,
  OPAQUE_ID_FIELDS,
  fieldLimit,
} from '@/audit/boundaries';
import { newId } from '@/utils/ids';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@/providers/adapters/openai-compatible';
import { ANTHROPIC_PROVIDER_ID } from '@/providers/adapters/anthropic';
import { GEMINI_PROVIDER_ID } from '@/providers/adapters/gemini';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

describe('TEST-ARGUED-001 — free text reaching the trail', () => {
  const INVENTORY = auditFieldInventory(AUDIT_EVENT_TYPES);

  it('01 — only the two file records carry `detail`', () => {
    // The premise: every other `detail` in the tree is a route response or a
    // refusal reason rather than an audit field, so one producer needed bounding.
    // Read from the record literals, so a third carrier has to be added here
    // deliberately instead of arriving with no bound.
    const carriers = [...INVENTORY]
      .filter(([, fields]) => fields.has('detail'))
      .map(([type]) => type)
      .sort();
    expect(carriers).toEqual(['file.attached', 'file.downloaded']);
  });

  it('02 — no audit record carries a provider or page error message', () => {
    // Provider text is bounded on the *task* record — `technicalDetails` is
    // sliced to 200 and redacted — and is excluded from the trail by design.
    // Two halves: the schema declares no field for one, and no producer spreads
    // one in under a different name.
    const declared = declaredAuditFields();
    for (const name of ['technicalDetails', 'errorMessage', 'stack', 'body', 'response']) {
      expect(declared, name).not.toContain(name);
    }
    // And every field any producer actually writes is one the schema declares —
    // which is what stops an error message arriving as an undeclared key, the way
    // `detail` itself once did.
    for (const [type, fields] of INVENTORY) {
      for (const field of fields) {
        expect(declared.has(field), `${type} writes an undeclared field "${field}"`).toBe(true);
      }
    }
  });
});

describe('TEST-ARGUED-001 — keys with no refusing consumer', () => {
  it('03 — a storage key is built from a minted id and stays small', async () => {
    // The premise: storage keys are composed from ids this build mints, and
    // `chrome.storage.local` under `unlimitedStorage` has no per-key refusal —
    // so there is no stricter consumer to disagree with. Both halves asserted:
    // the composed key is small, and a maximal one round-trips rather than being
    // rejected.
    const widest = [
      `task:${newId('task')}`,
      `session:${newId('session')}`,
      `conn:${newId('conn')}`,
      `config:${OPENAI_COMPATIBLE_PROVIDER_ID}`,
      `oauth:${'github'}`,
      `ev:${newId('ev')}`,
      `evp:${newId('ev')}`,
    ];
    for (const key of widest) {
      expect(key.length, key).toBeLessThanOrEqual(64);
    }
    // No refusal path: the area stores and returns it unchanged.
    const store = area();
    const longest = widest.reduce((a, b) => (a.length >= b.length ? a : b));
    await store.set(longest, { ok: true });
    expect(await store.get(longest)).toEqual({ ok: true });
  });

  it('04 — a consent key is bounded by its components, and nothing refuses it', async () => {
    // The premise: the key is NUL-joined from bounded parts and lives in an
    // in-memory Map, so it cannot be "lost" the way a record can. What is worth
    // asserting is that no part of it is unbounded — otherwise the Map grows
    // without limit even though nothing refuses.
    const taskId = 'a'.repeat(MAX_OPAQUE_ID);
    const destination = providerDestination(
      OPENAI_COMPATIBLE_PROVIDER_ID,
      `https://${'h'.repeat(200)}.test/v1`,
      'm'.repeat(MAX_STRING),
    );
    expect(destination.identity).not.toBeNull();
    expect(destination.identity!.length).toBeLessThanOrEqual(MAX_DESTINATION);

    const consent = new ConsentStore();
    const key = {
      taskId,
      destinationIdentity: destination.identity!,
      // A digest, so fixed width by construction.
      taintSignature: 'd'.repeat(64),
      sensitivityCeiling: 'confidential' as const,
      channel: 'ai_provider' as const,
    };
    consent.grant(key, 1_700_000_000_000);
    // Granted and found, with no refusal anywhere: this class is not the record
    // class, and the case says so rather than implying a bound that is not there.
    expect(consent.find({ key, now: 1_700_000_000_001 })).toBeDefined();
    // The bound that does matter: every component has a ceiling.
    const composed =
      key.taskId.length +
      key.destinationIdentity.length +
      key.taintSignature.length +
      key.sensitivityCeiling.length +
      key.channel.length;
    expect(composed).toBeLessThanOrEqual(MAX_OPAQUE_ID + MAX_DESTINATION + 64 + 32);
  });
});

describe('TEST-ARGUED-001 — identifiers that are build constants', () => {
  it('05 — every provider id fits the field that records it', () => {
    // The premise: these are literals in this build. Asserted, because a literal
    // is only short until somebody writes a longer one.
    for (const id of [OPENAI_COMPATIBLE_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, GEMINI_PROVIDER_ID]) {
      expect(id.length, id).toBeLessThanOrEqual(fieldLimit('providerId'));
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('05b — the contract classifies an identifier field as one', () => {
    // Direct, because it is not implied by anything else: the opaque-id check
    // would refuse an over-long identifier on its own, so dropping this branch
    // changes no refusal — it only makes the record-budget arithmetic cost an
    // 80-character id as if it were 256. A mutation that removed it survived
    // every other case, which is what this one is for.
    for (const field of OPAQUE_ID_FIELDS) {
      expect(fieldLimit(field), field).toBe(MAX_OPAQUE_ID);
    }
    // And a field that is not an identifier keeps the generic bound.
    expect(fieldLimit('code')).toBe(MAX_STRING);
    expect(fieldLimit('providerId')).toBe(MAX_STRING);
  });

  it('06 — a minted identifier fits the opaque-id rule, for every prefix used', async () => {
    // Covers workspace, workflow, shortcut, schedule, file and evidence ids in
    // one place: they all come from `newId`, and the rule is the same for all.
    const log = new AuditLog(area(), { knownTool: () => true });
    for (const prefix of [
      'task',
      'session',
      'ws',
      'workflow',
      'shortcut',
      'schedule',
      'file',
      'ev',
    ]) {
      const id = newId(prefix);
      expect(id.length, id).toBeLessThanOrEqual(MAX_OPAQUE_ID);
      expect(id, id).toMatch(/^[A-Za-z0-9_.:-]+$/);
    }
    // And the fields that are opaque-checked accept them.
    expect(
      await log.record({
        type: 'workflow.replay',
        taskId: newId('task'),
        workflowId: newId('workflow'),
        outcome: 'info',
      } as never),
    ).not.toBeNull();
    expect(
      await log.record({
        type: 'shortcut.launched',
        taskId: newId('task'),
        shortcutId: newId('shortcut'),
        outcome: 'info',
      } as never),
    ).not.toBeNull();
    expect(log.degradedReason()).toBeNull();
  });
});
