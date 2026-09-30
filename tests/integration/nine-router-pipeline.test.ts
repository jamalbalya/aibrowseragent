/**
 * TEST-9RPIPE-001 — an exact 9Router model id, through every stage.
 *
 * The boundary work of the previous phases established the rule this file
 * enforces: a value that arrives from outside is carried, not parsed. A 9Router
 * model id is the strongest case of that rule the product has — `/` is the
 * ordinary case, not the edge — and it passes through nine stages between the
 * gateway's catalogue and the audit record of a request.
 *
 * So each stage is checked with the same id, and the assertion is always the
 * same: identical, not merely similar. A stage that split it, shortened it, or
 * swapped its separator would still produce something that looked like a model
 * id, which is exactly why equality is asserted rather than eyeballed.
 */
import { describe, expect, it } from 'vitest';
import {
  parseModelCatalogue,
  NINE_ROUTER_PROVIDER_ID,
} from '@/providers/adapters/nine-router-catalog';
import { managementTaskId, managementContext } from '@/security/egress/provider-transport';
import { providerDestination } from '@/security/egress/destination';
import { ConsentStore, type ProviderPin } from '@/security/egress/consent';
import { AuditLog } from '@/audit/audit-log';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { accountAfterSelection } from '@/providers/accounts/account-model';
import { connectionForBrain } from '@/providers/accounts/brain-projection';
import { MAX_MODEL_ID, MAX_OPAQUE_ID } from '@/audit/boundaries';
import { isRecordableModelId } from '@/providers/core/provider-http';
import type { ConnectedAccount } from '@/providers/accounts/account-model';

const area = (): SerializedStorageArea => new SerializedStorageArea(new MemoryStorageArea());

/** The ids the brief names, plus the shapes that broke earlier phases. */
const IDS = [
  'openai/gpt-5.x',
  'anthropic/claude-x',
  'google/gemini-x',
  'vendor/model-name',
  'combo-name',
  'cx/gpt-5.6-terra',
  'org/team/project/model/v2',
  'modèle-日本語-🙂',
  'model with spaces',
  'model@v1(beta)!#?&=',
  'x'.repeat(MAX_MODEL_ID),
] as const;

function account(modelId: string, connectionId = 'conn_1'): ConnectedAccount {
  return {
    connectionId,
    abaUserId: 'user_1',
    providerId: NINE_ROUTER_PROVIDER_ID,
    protocol: 'openai-compatible',
    displayName: '9Router',
    accountLabel: 'localhost:20128 (key …abcd)',
    authKind: 'api_key',
    baseUrl: 'http://localhost:20128/v1',
    modelId,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: 1_700_000_000_000,
  };
}

describe('TEST-9RPIPE-001 — the id survives the pipeline', () => {
  for (const id of IDS) {
    it(`01 — "${id.slice(0, 32)}" is unchanged from catalogue to audit`, async () => {
      // Stage 1: the parser.
      const { models } = parseModelCatalogue({
        object: 'list',
        data: [{ id, object: 'model', owned_by: 'openai' }],
      });
      expect(models).toHaveLength(1);
      const parsed = models[0]!;
      expect(parsed.id).toBe(id);

      // Stage 2: admission. The boundary contract's bound, not a new one.
      expect(isRecordableModelId(parsed.id)).toBe(true);

      // Stage 3: the account record after selection.
      const selected = accountAfterSelection(account(parsed.id), parsed.id);
      expect(selected.modelId).toBe(id);

      // Stage 4: the projection the panel reads.
      const projected = connectionForBrain(selected);
      expect(projected?.modelId).toBe(id);

      // Stage 5: the egress destination.
      const destination = providerDestination(
        NINE_ROUTER_PROVIDER_ID,
        'http://localhost:20128/v1',
        parsed.id,
      );
      expect(destination.modelId).toBe(id);

      // Stage 6: the provider pin.
      const pin: ProviderPin = {
        identity: destination.identity ?? '',
        connectionId: 'conn_1',
        modelId: parsed.id,
      };
      const consent = new ConsentStore();
      consent.pinProvider('task_abc', pin);
      expect(consent.pinnedProvider('task_abc')?.modelId).toBe(id);
      expect(consent.matchesPin('task_abc', pin)).toBe(true);

      // Stage 7: the management task id — opaque and bounded, and *not* carrying
      // the model id verbatim. This is the defect that started the boundary work.
      const taskId = await managementTaskId(NINE_ROUTER_PROVIDER_ID, parsed.id);
      expect(taskId).toMatch(/^[A-Za-z0-9_.:-]{1,80}$/);
      expect(taskId.length).toBeLessThanOrEqual(MAX_OPAQUE_ID);
      expect(taskId).not.toContain('/');
      if (id.length > 8) expect(taskId).not.toContain(id);

      // Stage 8: the egress context the transport carries.
      const context = await managementContext(NINE_ROUTER_PROVIDER_ID, parsed.id, 'ab'.repeat(32));
      expect(context.modelId).toBe(id);
      expect(context.taskId).toBe(taskId);

      // Stage 9: the audit record.
      const log = new AuditLog(area(), { knownTool: () => true });
      const written = await log.record({
        type: 'egress.decided',
        taskId,
        tool: 'provider.request',
        outcome: 'allowed',
        code: 'PROVIDER_PINNED',
        providerId: NINE_ROUTER_PROVIDER_ID,
        modelId: parsed.id,
        ...(destination.identity === null ? {} : { destination: destination.identity }),
      } as never);
      expect(written, `the record was refused: ${log.degradedReason()}`).not.toBeNull();
      // The record holds the id the gateway offered, not a rendering of it.
      expect(written?.modelId).toBe(id);
      expect(log.degradedReason()).toBeNull();
    });
  }

  it('02 — a distinct pair of ids never collapses into one management identity', async () => {
    // Two ids that a naive normalisation would merge: same suffix, same prefix,
    // differing only where a splitter would stop looking.
    const pairs: [string, string][] = [
      ['openai/gpt-5.x', 'azure/gpt-5.x'],
      ['openai/gpt-5.x', 'openai/gpt-5.y'],
      ['a/b/c', 'a/b-c'],
      ['combo-one', 'combo-two'],
    ];
    for (const [left, right] of pairs) {
      expect(await managementTaskId(NINE_ROUTER_PROVIDER_ID, left), `${left} vs ${right}`).not.toBe(
        await managementTaskId(NINE_ROUTER_PROVIDER_ID, right),
      );
    }
  });
});

describe('TEST-9RPIPE-001 — pinning across a switch', () => {
  const identity = (): string =>
    providerDestination(NINE_ROUTER_PROVIDER_ID, 'http://localhost:20128/v1').identity ?? '';

  it('03 — switching model within one upstream breaks the pin', () => {
    // 9Router → OpenAI → model A, then model B. Same gateway, same account, same
    // upstream: only the model differs, and the model is part of the pin because
    // two models at one endpoint are two recipients of the data.
    const consent = new ConsentStore();
    const a: ProviderPin = {
      identity: identity(),
      connectionId: 'conn_1',
      modelId: 'openai/model-a',
    };
    consent.pinProvider('task_1', a);
    expect(consent.matchesPin('task_1', a)).toBe(true);

    const b: ProviderPin = { ...a, modelId: 'openai/model-b' };
    expect(consent.matchesPin('task_1', b)).toBe(false);
    // And the pin is not quietly replaced: the task stays bound to what it started on.
    consent.pinProvider('task_1', b);
    expect(consent.pinnedProvider('task_1')?.modelId).toBe('openai/model-a');
  });

  it('04 — switching upstream breaks the pin too', () => {
    // 9Router → OpenAI → model A, then 9Router → Anthropic → model B. The gateway
    // endpoint is identical, so the *only* signal is the model id — which is why
    // dropping it from the pin would let a task silently change brains.
    const consent = new ConsentStore();
    const a: ProviderPin = {
      identity: identity(),
      connectionId: 'conn_1',
      modelId: 'openai/model-a',
    };
    consent.pinProvider('task_2', a);
    const b: ProviderPin = { ...a, modelId: 'anthropic/model-b' };
    expect(consent.matchesPin('task_2', b)).toBe(false);
  });

  it('05 — the same model on a different account is a different recipient', () => {
    const consent = new ConsentStore();
    const a: ProviderPin = {
      identity: identity(),
      connectionId: 'conn_1',
      modelId: 'openai/model-a',
    };
    consent.pinProvider('task_3', a);
    expect(consent.matchesPin('task_3', { ...a, connectionId: 'conn_2' })).toBe(false);
  });

  it('06 — an unchanged selection still matches', () => {
    const consent = new ConsentStore();
    const pin: ProviderPin = {
      identity: identity(),
      connectionId: 'conn_1',
      modelId: 'openai/gpt-5.x',
    };
    consent.pinProvider('task_4', pin);
    expect(consent.matchesPin('task_4', { ...pin })).toBe(true);
  });
});

describe('TEST-9RPIPE-001 — persistence restores the selection', () => {
  it('07 — the group and the exact model both come back', () => {
    const selected = { ...account('openai/gpt-5.x'), upstreamKey: 'up:openai' } as ConnectedAccount;
    const projected = connectionForBrain(selected);
    expect(projected?.modelId).toBe('openai/gpt-5.x');
    expect(projected?.upstreamKey).toBe('up:openai');
  });

  it('08 — an account with no group projects none rather than a default', () => {
    // A provider without groups has no such level, and inventing one would show
    // an upstream selector for a provider that has no upstreams.
    const projected = connectionForBrain(account('gpt-4o'));
    expect(projected?.modelId).toBe('gpt-4o');
    expect(projected && 'upstreamKey' in projected).toBe(false);
  });

  it('09 — the stored group is never consulted to decide the model', () => {
    // A stale group can only affect which level the UI opens on. The model is
    // whatever `modelId` says, and these two disagree on purpose.
    const stale = {
      ...account('anthropic/claude-x'),
      upstreamKey: 'up:openai',
    } as ConnectedAccount;
    expect(connectionForBrain(stale)?.modelId).toBe('anthropic/claude-x');
  });
});
