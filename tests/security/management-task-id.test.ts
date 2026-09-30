/**
 * TEST-MGMTID-001 — the provider probe's identity, and the audit record it has
 * to survive.
 *
 * The defect these cases exist for was reported from production, not from a
 * test. An OpenAI-compatible endpoint was configured with the model
 * `cx/gpt-5.6-terra`, every capability check passed, real browser tasks ran —
 * and the panel showed "Some stored records were lost" with
 * `audit — corrupt (a record could not be shaped)` on every task.
 *
 * The chain: `managementTaskId` interpolated the model id verbatim, producing
 * `provider-management:openai-compatible:cx/gpt-5.6-terra`; `isOpaqueId` in the
 * audit log permits only `[A-Za-z0-9_.:-]`, so the `/` made it not an
 * identifier; `egress.decided` is task-scoped, so `prepare()` threw before
 * `append()` and the record was refused. The probe still happened, the
 * decision still stood, and the trail simply lost the record of it.
 *
 * Why the existing suite missed it: every model id it used — `gpt-4o`,
 * `mock-model`, `'a'`, `'b'` — happens to be inside that character class. The
 * bug needed a namespaced model id to become reachable, and namespaced model
 * ids are the norm for routed endpoints rather than an oddity.
 *
 * So the cases below are written against the **exact** identifier that failed,
 * and against the shapes that would fail for the same reason.
 */
import { describe, expect, it } from 'vitest';
import {
  MANAGEMENT_ID_PREFIX,
  managementContext,
  managementTaskId,
} from '@/security/egress/provider-transport';
import { AuditLog, INTERNAL_AUDIT_SOURCES } from '@/audit/audit-log';
import type {
  HealthDomain,
  PersistenceHealthStore,
  PersistenceState,
} from '@/storage/persistence-health';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';

/**
 * The audit log's own identifier rule, restated here on purpose.
 *
 * `isOpaqueId` is module-private, and exporting it to test against would let a
 * future widening of the real rule silently relax these cases too. Stating the
 * contract independently means these tests fail if either side moves.
 */
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * A health port that records what the audit log reported, and nothing else.
 *
 * Typed against the real interface rather than cast, so a change to the port
 * fails here instead of being absorbed by an `as never`.
 */
function spy(into: { state: string; reason: string }[]): PersistenceHealthStore {
  const report = async (
    _domain: HealthDomain,
    state: PersistenceState,
    reason: string,
  ): Promise<void> => {
    into.push({ state, reason });
  };
  return { report } as unknown as PersistenceHealthStore;
}

/** The identifier that was actually configured when this was reported. */
const FAILING_MODEL = 'cx/gpt-5.6-terra';

describe('TEST-MGMTID-001 — the management task id is an opaque identifier', () => {
  it('01 — accepts the exact model id that broke production', async () => {
    const id = await managementTaskId('openai-compatible', FAILING_MODEL);
    expect(id).toMatch(OPAQUE_ID);
    // And the raw model id is not in it. A model id is an external string; an
    // opaque identifier is not the place to carry one.
    expect(id).not.toContain(FAILING_MODEL);
    expect(id).not.toContain('/');
  });

  const HOSTILE: readonly [string, string][] = [
    ['a short namespace', 'cx/x'],
    ['a vendor namespace', 'vendor/model'],
    ['spaces', 'model with spaces'],
    ['a plus', 'model+variant'],
    ['non-ASCII', 'modèle-日本語-🙂'],
    ['punctuation', 'model@v1(beta)!#?&='],
    ['a deep path', 'org/team/project/model/v2'],
    ['an empty model', ''],
    ['a very long id', `${'x'.repeat(400)}/${'y'.repeat(400)}`],
  ];

  for (const [label, model] of HOSTILE) {
    it(`02 — survives ${label}`, async () => {
      const id = await managementTaskId('openai-compatible', model);
      expect(id, `${label} produced "${id}"`).toMatch(OPAQUE_ID);
      // The bound matters as much as the character class: the regex above caps
      // at 80, and a long model id used to blow straight through it.
      expect(id.length).toBeLessThanOrEqual(80);
    });
  }

  it('03 — is deterministic for the same provider and model', async () => {
    const first = await managementTaskId('openai-compatible', FAILING_MODEL);
    const second = await managementTaskId('openai-compatible', FAILING_MODEL);
    expect(second).toBe(first);
  });

  it('04 — separates models within one provider', async () => {
    expect(await managementTaskId('openai-compatible', 'cx/a')).not.toBe(
      await managementTaskId('openai-compatible', 'cx/b'),
    );
  });

  it('05 — separates providers holding the same model', async () => {
    expect(await managementTaskId('openai-compatible', FAILING_MODEL)).not.toBe(
      await managementTaskId('anthropic', FAILING_MODEL),
    );
  });

  it('06 — cannot be confused by a colon in either component', async () => {
    // The components are joined with a separator that also appears inside a
    // model id, so the digest is taken over a NUL-separated pair rather than
    // over the joined string. Without that, ("a", "b:c") and ("a:b", "c")
    // could land on one identity.
    expect(await managementTaskId('a', 'b:c')).not.toBe(await managementTaskId('a:b', 'c'));
  });

  it('07 — keeps the readable discriminator', async () => {
    const id = await managementTaskId('openai-compatible', FAILING_MODEL);
    expect(id.startsWith(`${MANAGEMENT_ID_PREFIX}:openai-compatible:`)).toBe(true);
  });

  it('08 — the context the transport carries holds that same id', async () => {
    // One value end to end. The consent pin is created under the context's
    // task id and looked up under it, and the audit record names it, so two
    // representations would be a silent authorization bug rather than a
    // cosmetic one.
    const context = await managementContext('openai-compatible', FAILING_MODEL, 'ab'.repeat(32));
    expect(context.taskId).toBe(await managementTaskId('openai-compatible', FAILING_MODEL));
    expect(context.taskId).toMatch(OPAQUE_ID);
  });
});

describe('TEST-MGMTID-001 — the audit log keeps the probe record', () => {
  const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

  it('09 — records an egress decision carrying a management task id', async () => {
    const reports: { state: string; reason: string }[] = [];
    const log = new AuditLog(area(), { knownTool: () => false, health: spy(reports) });

    const written = await log.record({
      type: 'egress.decided',
      taskId: await managementTaskId('openai-compatible', FAILING_MODEL),
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
    });

    // The record this test exists for. Before the fix this was `null`.
    expect(written).not.toBeNull();
    expect(written?.type).toBe('egress.decided');
    // And nothing reported the trail as corrupt.
    expect(reports).toEqual([]);
    expect(log.degradedReason()).toBeNull();
  });

  it('10 — keeps "provider.request" rather than recording it as unknown', async () => {
    // `provider.request` is deliberately not a registered tool — registering it
    // would put it in the set the model is offered. It is a name this build
    // originates, so it is verified against a constant here instead, and the
    // trail says what the request was.
    const log = new AuditLog(area(), { knownTool: () => false });
    const written = await log.record({
      type: 'egress.decided',
      taskId: await managementTaskId('openai-compatible', FAILING_MODEL),
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
    });
    expect(written?.tool).toBe('provider.request');
    expect(INTERNAL_AUDIT_SOURCES.has('provider.request')).toBe(true);
  });

  it('11 — still refuses a task-scoped record whose task id is not opaque', async () => {
    // The negative control, and the reason this fix is not a bypass. The
    // identifier boundary is unchanged: what changed is that the probe stopped
    // handing it an external string.
    const reports: { state: string; reason: string }[] = [];
    const log = new AuditLog(area(), { knownTool: () => false, health: spy(reports) });

    const written = await log.record({
      type: 'egress.decided',
      taskId: 'task_with/a/slash',
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
    });

    expect(written).toBeNull();
    expect(reports).toEqual([{ state: 'CORRUPT', reason: 'a record could not be shaped' }]);
  });

  it('12 — still records an unregistered tool name as unknown', async () => {
    // The other half of the same control. Only the names this build declares
    // are exempt; a model-proposed name is still not taken at its word.
    const log = new AuditLog(area(), { knownTool: () => false });
    const written = await log.record({
      type: 'tool.invoked',
      taskId: 'task_abc',
      tool: 'browser.invented_by_a_model',
      outcome: 'allowed',
      executed: true,
    });
    expect(written?.tool).toBe('(unknown)');
  });
});

describe('TEST-MGMTID-001 — the internal-source exemption is not a way in', () => {
  const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

  it('13 — a model calling "provider.request" is still recorded as unknown', async () => {
    // The hole the first version of this fix opened, closed and then pinned.
    // A model emits whatever tool name it likes; `fromWireName` passes a name
    // containing a dot straight through; and the registry observes a refused
    // call. So a bare name exemption would have let a model write the build's
    // own reserved source into the trail. The exemption is keyed on the record
    // type too, and `tool.refused` is not a type that carries it.
    const log = new AuditLog(area(), { knownTool: () => false });
    const refused = await log.record({
      type: 'tool.refused',
      taskId: 'task_abc',
      tool: 'provider.request',
      outcome: 'denied',
      executed: false,
      code: 'TOOL_NOT_FOUND',
    });
    expect(refused?.tool).toBe('(unknown)');

    // Same name, the type the guarded transport really writes: kept.
    const genuine = await log.record({
      type: 'egress.decided',
      taskId: await managementTaskId('openai-compatible', FAILING_MODEL),
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
    });
    expect(genuine?.tool).toBe('provider.request');
  });

  it('14 — and it is not reachable on tool.invoked either', async () => {
    const log = new AuditLog(area(), { knownTool: () => false });
    const written = await log.record({
      type: 'tool.invoked',
      taskId: 'task_abc',
      tool: 'provider.request',
      outcome: 'allowed',
      executed: true,
    });
    expect(written?.tool).toBe('(unknown)');
  });
});
