/**
 * TEST-MGMTAUDIT-001 — a capability check with a namespaced model id, end to
 * end through the real audit log and the real evidence store.
 *
 * `management-task-id.test.ts` pins the identifier in isolation. This pins the
 * behaviour the user actually reported: configure an OpenAI-compatible endpoint
 * with `cx/gpt-5.6-terra`, run the capability doctor, and the audit trail must
 * hold a record for every probe and report itself healthy.
 *
 * The pieces are the production ones — `CapabilityDoctor`, `AuditLog`,
 * `EvidenceStore`, `PersistenceHealthStore`, `recordWithEvidence` — assembled
 * the way `service-worker.ts` assembles them. Only the adapter is a stub, and
 * only so the test needs no network: the id under test is built from the model
 * string, which a stub carries exactly as a real endpoint would.
 */
import { describe, expect, it } from 'vitest';
import { CapabilityDoctor } from '@/providers/capability-doctor/capability-doctor';
import { AuditLog } from '@/audit/audit-log';
import { recordWithEvidence } from '@/audit/record-with-evidence';
import { EvidenceStore } from '@/evidence/evidence-store';
import { PersistenceHealthStore } from '@/storage/persistence-health';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { buildEgressEvidence } from '@/security/egress/egress-evidence';
import { providerDestination } from '@/security/egress/destination';
import { authorizeEgress } from '@/security/egress/egress-gate';
import { ConsentStore } from '@/security/egress/consent';
import { FULL_CAPABILITIES } from '../fixtures/fake-provider';
import type {
  AIProviderAdapter,
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  ModelCapabilities,
} from '@/providers/core/types';
import type { EgressContext } from '@/security/egress/provider-transport';

/** The model identifier that produced the production report. */
const MODEL = 'cx/gpt-5.6-terra';
const PROVIDER = 'openai-compatible';

/**
 * An adapter that answers every probe and records the egress context it was
 * handed.
 *
 * Capturing the context is the point: the doctor builds it once and hands the
 * same value to every probe, and the id inside it is what the consent pin, the
 * egress decision and the audit record all key on.
 */
function stubAdapter(seen: EgressContext[]): AIProviderAdapter {
  const note = (request: Partial<CanonicalRequest>): void => {
    if (request.egress) seen.push(request.egress);
  };
  const ok = (): CanonicalResponse => ({
    text: 'ok',
    toolCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1 },
  });

  const adapter: AIProviderAdapter = {
    id: PROVIDER,
    displayName: 'OpenAI-compatible',
    kind: 'api' as const,
    authKind: 'api_key',
    connect: () => Promise.resolve({ authenticated: true }),
    disconnect: () => Promise.resolve(),
    listModels: () => Promise.resolve([{ id: MODEL, displayName: MODEL }]),
    getCapabilities: (): Promise<ModelCapabilities> => Promise.resolve(FULL_CAPABILITIES),
    validateConnection: () => Promise.resolve({ reachable: true, latencyMs: 1 }),
    generate: (request: CanonicalRequest): Promise<CanonicalResponse> => {
      note(request);
      const asked = JSON.stringify(request.messages);
      if ((request.tools?.length ?? 0) > 0) {
        return Promise.resolve({
          text: '',
          toolCalls: [{ toolCallId: 'c1', name: 'capability_probe', arguments: { status: 'ok' } }],
          finishReason: 'tool_call',
          usage: { promptTokens: 1, completionTokens: 1 },
        });
      }
      if (asked.includes('measuring usable context')) {
        return Promise.resolve({
          text: 'ok',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1_480, completionTokens: 1 },
        });
      }
      if (asked.includes('JSON object')) {
        return Promise.resolve({
          text: '{"ok":true}',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
        });
      }
      return Promise.resolve(ok());
    },
  };

  adapter.stream = async function* (request: CanonicalRequest): AsyncIterable<CanonicalEvent> {
    note(request);
    yield { type: 'text_delta', delta: 'ok' };
    yield { type: 'done', response: ok() };
  };

  return adapter;
}

interface Wiring {
  readonly audit: AuditLog;
  readonly evidence: EvidenceStore;
  readonly health: PersistenceHealthStore;
}

function wire(): Wiring {
  const area = new MemoryStorageArea();
  const health = new PersistenceHealthStore(new SerializedStorageArea(area));
  return {
    health,
    audit: new AuditLog(new SerializedStorageArea(new MemoryStorageArea()), {
      // The production predicate: only what the tool registry holds. Nothing
      // here registers `provider.request`, exactly as the worker does not.
      knownTool: () => false,
      health,
    }),
    evidence: new EvidenceStore(new SerializedStorageArea(new MemoryStorageArea())),
  };
}

describe('TEST-MGMTAUDIT-001 — a namespaced model id keeps its probe records', () => {
  it('01 — the doctor hands every probe one opaque probe identity', async () => {
    const seen: EgressContext[] = [];
    await new CapabilityDoctor().run(stubAdapter(seen), MODEL);

    expect(seen.length).toBeGreaterThan(0);
    const ids = new Set(seen.map((context) => context.taskId));
    // One identity for the whole run. Two would mean the consent pin was
    // created under one id and looked up under another.
    expect(ids.size).toBe(1);
    const [taskId] = [...ids];
    expect(taskId).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
    expect(taskId).not.toContain('/');
    // The model the doctor was asked about still reaches the adapter intact —
    // only the *identifier* is digested, not the configuration.
    expect(seen[0]?.modelId).toBe(MODEL);
  });

  it('02 — every probe decision is recorded, and the trail stays healthy', async () => {
    const seen: EgressContext[] = [];
    await new CapabilityDoctor().run(stubAdapter(seen), MODEL);
    const { audit, evidence, health } = wire();

    // Replays what the guarded transport's `onDecision` does for each probe,
    // through the production gate and the production ordering.
    for (const context of seen) {
      const destination = providerDestination(
        context.providerId,
        'https://api.example.test/v1',
        MODEL,
      );
      const decision = authorizeEgress(
        {
          taskId: context.taskId,
          taintState: context.taintState,
          taintSalt: context.taintSalt,
          destination,
          payload: 'ping',
          taintSignature: context.taintSignature,
          now: 1_700_000_000_000,
        },
        { consent: new ConsentStore() },
      );
      const built = await buildEgressEvidence({
        taskId: context.taskId,
        sourceTool: 'provider.request',
        destination,
        decision,
        payload: 'ping',
        taintSalt: context.taintSalt,
        saltEpoch: context.saltEpoch,
        now: 1_700_000_000_000,
      });
      await recordWithEvidence({ audit, evidence }, built, (evidenceId) => ({
        type: 'egress.decided',
        taskId: context.taskId,
        tool: 'provider.request',
        outcome: decision.verdict === 'allow' ? 'allowed' : 'confirmed',
        code: decision.code,
        evidenceIds: [evidenceId],
      }));
    }

    const events = await audit.list();
    // Every probe left a record. Before the fix this list was empty and the
    // banner said the trail was corrupt.
    expect(events.length).toBe(seen.length);
    expect(events.every((event) => event.type === 'egress.decided')).toBe(true);
    // And the name survived rather than becoming `(unknown)`.
    expect(events.every((event) => event.tool === 'provider.request')).toBe(true);

    const snapshot = await health.snapshot();
    const audits = snapshot.records.filter((record) => record.domain === 'audit');
    expect(audits.every((record) => record.state === 'HEALTHY')).toBe(true);
    expect(audit.degradedReason()).toBeNull();
  });

  it('03 — no evidence is left that the trail does not point at', async () => {
    const seen: EgressContext[] = [];
    await new CapabilityDoctor().run(stubAdapter(seen), MODEL);
    const { audit, evidence } = wire();

    const destination = providerDestination(PROVIDER, 'https://api.example.test/v1', MODEL);
    for (const context of seen) {
      const decision = authorizeEgress(
        {
          taskId: context.taskId,
          taintState: context.taintState,
          taintSalt: context.taintSalt,
          destination,
          payload: 'ping',
          taintSignature: context.taintSignature,
          now: 1_700_000_000_000,
        },
        { consent: new ConsentStore() },
      );
      const built = await buildEgressEvidence({
        taskId: context.taskId,
        sourceTool: 'provider.request',
        destination,
        decision,
        payload: 'ping',
        taintSalt: context.taintSalt,
        saltEpoch: context.saltEpoch,
        now: 1_700_000_000_000,
      });
      await recordWithEvidence({ audit, evidence }, built, (evidenceId) => ({
        type: 'egress.decided',
        taskId: context.taskId,
        tool: 'provider.request',
        outcome: 'allowed',
        code: decision.code,
        evidenceIds: [evidenceId],
      }));
    }

    const referenced = new Set(
      (await audit.list()).flatMap((event) => [...(event.evidenceIds ?? [])]),
    );
    // Listed per task, which is the only listing the store offers — and the
    // probe's task id is the one the doctor minted, so this is exactly the set
    // the probes produced.
    const stored = (await evidence.listForTask(seen[0]!.taskId)).map((reference) => reference.id);
    expect(stored.length).toBeGreaterThan(0);
    // The invariant: nothing in the evidence store is unaccounted for.
    const orphans = stored.filter((id: string) => !referenced.has(id));
    expect(orphans).toEqual([]);
  });

  it('04 — a refused record stores no evidence at all', async () => {
    // The ordering rule, measured directly. A record the log refuses must not
    // leave a blob behind — that is the whole reason the order changed.
    const { evidence } = wire();
    const refusing = new AuditLog(new SerializedStorageArea(new MemoryStorageArea()), {
      knownTool: () => false,
    });

    const destination = providerDestination(PROVIDER, 'https://api.example.test/v1', MODEL);
    const built = await buildEgressEvidence({
      taskId: 'task_ok',
      sourceTool: 'provider.request',
      destination,
      decision: authorizeEgress(
        {
          taskId: 'task_ok',
          taintState: { kind: 'KNOWN_UNTAINTED' },
          taintSalt: 'ab'.repeat(32),
          destination,
          payload: 'ping',
          taintSignature: 'management',
          now: 1_700_000_000_000,
        },
        { consent: new ConsentStore() },
      ),
      payload: 'ping',
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      now: 1_700_000_000_000,
    });

    await recordWithEvidence({ audit: refusing, evidence }, built, (evidenceId) => ({
      type: 'egress.decided',
      // Not an opaque identifier, so the log refuses the record. The old order
      // would have stored the blob before finding that out.
      taskId: 'task/with/slashes',
      tool: 'provider.request',
      outcome: 'allowed',
      code: 'PROVIDER_PINNED',
      evidenceIds: [evidenceId],
    }));

    expect(await refusing.list()).toEqual([]);
    expect(await evidence.listForTask('task_ok')).toEqual([]);
    expect(await evidence.listForTask('task/with/slashes')).toEqual([]);
  });
});
