/**
 * TEST-SECURITY-028 — what a provider switch must not carry with it (P-033).
 *
 * Switching provider is already covered as a *capability*: three adapters
 * pass one conformance suite and every ordered pair is exercised in real
 * Chromium. What this suite is about is the state left behind, which is where
 * a switch goes wrong quietly rather than loudly.
 *
 * Two findings this wave fixed, and the cases below are written against them:
 *
 *  1. A capability measured for one provider and model was carried forward as
 *     a claim about another, because the connection record was spread and
 *     only two of its fields replaced. A stale measurement is worse than no
 *     measurement: it reads as evidence. (Specification §24B makes the same
 *     argument for web providers, in a tri-state vocabulary this type does
 *     not use — see the note in the capabilities case below.)
 *  2. A half-finished task could be resumed onto whichever provider was
 *     active by then, under a record still naming the one it started on.
 *     §60 forbids a silent provider fallback, and that is one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { TaskStore } from '@/tasks/task-store';
import { TaskManager } from '@/background/task-manager';
import { createTask, generateTaintSalt } from '@/tasks/task-model';
import {
  isUnverified,
  REQUESTABLE_CAPABILITIES,
  UNKNOWN_CAPABILITIES,
} from '@/providers/core/types';
import type { AIProviderAdapter, ModelCapabilities } from '@/providers/core/types';
import type { ProviderConnection } from '@/providers/registry/provider-registry';
import { connectionAfterSwitch, isProviderSwitch } from '@/background/provider-switch';
import { resolveBrainAccount } from '@/providers/accounts/resolve-brain';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const root = resolve(import.meta.dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

const capable: ModelCapabilities = {
  ...UNKNOWN_CAPABILITIES,
  text: true,
  toolCalling: true,
  vision: true,
};

/**
 * The real function the route calls. Imported, not re-implemented: an earlier
 * version of this suite carried its own copy of the logic, and two mutations
 * to the route survived because the copy was what was being exercised.
 */
const applySwitch = (
  existing: ProviderConnection | null,
  providerId: string,
  modelId: string,
): ProviderConnection =>
  connectionAfterSwitch(existing, providerId, modelId, () => ({
    providerId,
    modelId,
    authKind: 'api-key',
    createdAt: 1,
    status: 'connected',
  }));

const connected: ProviderConnection = {
  providerId: 'openai-compatible',
  modelId: 'model-a',
  authKind: 'api-key',
  createdAt: 1,
  status: 'limited',
  capabilities: capable,
  lastValidated: 42,
};

describe('a switch does not carry a measurement with it', () => {
  it('drops capabilities measured for the previous model', () => {
    const next = applySwitch(connected, 'openai-compatible', 'model-b');
    expect(next['capabilities']).toBeUndefined();
    expect(next['modelId']).toBe('model-b');
  });

  it('drops capabilities measured for the previous provider', () => {
    const next = applySwitch(connected, 'anthropic', 'model-a');
    expect(next['capabilities']).toBeUndefined();
    expect(next['providerId']).toBe('anthropic');
  });

  it('drops the timestamp that said when the measurement was made', () => {
    // A `lastValidated` left behind would date a measurement that no longer
    // describes anything, which is how a stale claim survives a review.
    expect(applySwitch(connected, 'anthropic', 'model-b')['lastValidated']).toBeUndefined();
  });

  it('does not carry a readiness decided from the previous measurement', () => {
    expect(connected.status).toBe('limited');
    expect(applySwitch(connected, 'anthropic', 'model-b')['status']).toBe('connected');
  });

  it('keeps everything when nothing actually changed', () => {
    // Re-selecting the current pair is not a switch, and re-measuring on
    // every settings save would be its own kind of wrong.
    const same = applySwitch(connected, 'openai-compatible', 'model-a');
    expect(same['capabilities']).toBe(capable);
    expect(same['lastValidated']).toBe(42);
    expect(same['status']).toBe('limited');
  });

  it('recognises a switch, and recognises a re-selection as not one', () => {
    expect(isProviderSwitch(connected, 'anthropic', 'model-a')).toBe(true);
    expect(isProviderSwitch(connected, 'openai-compatible', 'model-b')).toBe(true);
    expect(isProviderSwitch(connected, 'openai-compatible', 'model-a')).toBe(false);
    expect(isProviderSwitch(null, 'anthropic', 'model-a')).toBe(false);
  });

  it('is the function the route actually calls', () => {
    const worker = read('src/background/service-worker.ts');
    const handler = worker.slice(
      worker.indexOf("router.on('provider.setActive'"),
      worker.indexOf("router.on('connector.list'"),
    );
    expect(handler).toContain('connectionAfterSwitch');
    expect(handler).toContain('isProviderSwitch');
    expect(handler).toContain('capabilities_invalidated');
  });

  it('records the invalidation in the trail', () => {
    const worker = read('src/background/service-worker.ts');
    const handler = worker.slice(
      worker.indexOf("router.on('provider.setActive'"),
      worker.indexOf("router.on('connector.list'"),
    );
    // A switch that silently discards a measurement is still a decision worth
    // being able to read back.
    expect(handler).toContain("type: 'provider.selected'");
  });
});

describe('an unmeasured provider claims nothing rather than the last answer', () => {
  it('falls back to the conservative set when nothing was measured', async () => {
    // Both resolve paths fall back to the conservative set, and each names the
    // scoped measurement it checked first rather than the raw stored record —
    // a measurement only counts on the pair it was taken on.
    //
    // The account path is now **run** rather than read: the resolver is given
    // a record whose measurement belongs to a different model, and what comes
    // back must be the conservative set and not that measurement.
    const resolved = await resolveBrainAccount(
      {
        connectionId: 'conn_a',
        providerId: 'openai-compatible',
        displayName: 'An account',
        modelId: 'model-a',
        capabilities: {
          toolCalling: true,
          streaming: true,
          vision: true,
          maxContextTokens: 9,
          unverified: [],
        },
        capabilityScope: { connectionId: 'conn_a', modelId: 'model-b' },
      } as never,
      {
        adapterFor: () => ({ connect: () => Promise.resolve({ authenticated: true }) }) as never,
        keyFor: () => Promise.resolve('a-key'),
        staleMessage: () => 'stale',
      },
    );
    expect(resolved.capabilities).toEqual(UNKNOWN_CAPABILITIES);

    // The legacy single-provider slot still lives in the worker.
    const worker = read('src/background/service-worker.ts');
    expect(worker).toContain('slotMeasured ?? UNKNOWN_CAPABILITIES');
    expect(read('src/providers/accounts/resolve-brain.ts')).toContain(
      'measured ?? UNKNOWN_CAPABILITIES',
    );

    // Every boolean is conservative: unmeasured reads as "do not rely on it".
    for (const [field, value] of Object.entries(UNKNOWN_CAPABILITIES)) {
      if (field === 'unverified') continue;
      expect(value === false || value === null, field).toBe(true);
    }

    // And the set says *why* they are false. This used to be the one thing the
    // boolean matrix could not express — "nothing measured" was byte-identical
    // to "measured, and absent" — so an adapter that honestly could not know
    // wrote `false` and every reader downstream, including the probe that
    // existed to settle it, read a measurement. `unverified` is the third
    // state, and this constant is the case it was introduced for.
    expect(UNKNOWN_CAPABILITIES.unverified).toEqual(REQUESTABLE_CAPABILITIES);
    for (const capability of REQUESTABLE_CAPABILITIES) {
      expect(isUnverified(UNKNOWN_CAPABILITIES, capability), capability).toBe(true);
    }
  });
});

describe('a task does not change provider underneath itself', () => {
  async function world(active: { providerId: string; modelId: string }) {
    const area = new SerializedStorageArea(new MemoryStorageArea());
    const store = new TaskStore(area);
    const manager = new TaskManager({
      store,
      resolveProvider: () =>
        Promise.resolve({
          adapter: { id: active.providerId } as unknown as AIProviderAdapter,
          capabilities: UNKNOWN_CAPABILITIES,
          providerId: active.providerId,
          modelId: active.modelId,
        }),
      getPermissionMode: () => Promise.resolve('manual'),
      getActiveTabId: () => Promise.resolve(undefined),
    });
    const task = {
      ...createTask({
        id: 'task_switch',
        sessionId: 's',
        objective: 'x',
        providerId: 'openai-compatible',
        modelId: 'model-a',
        permissionMode: 'manual',
        now: 1,
      }),
      taintSalt: generateTaintSalt(),
      state: 'PAUSED' as const,
    };
    await store.saveTask(task);
    return { store, manager };
  }

  it('fails a resume onto a different model rather than continuing quietly', async () => {
    const { store, manager } = await world({
      providerId: 'openai-compatible',
      modelId: 'model-b',
    });
    await manager.resume('task_switch');
    // `resume` schedules execution; the refusal lands on the task record.
    await new Promise((resolve_) => setTimeout(resolve_, 20));
    const task = await store.getTask('task_switch');
    expect(task?.state).toBe('FAILED');
    expect(task?.error?.code).toBe('POLICY_BLOCKED');
    expect(task?.error?.userMessage).toContain('model-b');
  });

  it('fails a resume onto a different provider', async () => {
    const { store, manager } = await world({ providerId: 'anthropic', modelId: 'model-a' });
    await manager.resume('task_switch');
    await new Promise((resolve_) => setTimeout(resolve_, 20));
    expect((await store.getTask('task_switch'))?.error?.code).toBe('POLICY_BLOCKED');
  });

  it('resumes normally when the provider and model are the same', async () => {
    const { store, manager } = await world({
      providerId: 'openai-compatible',
      modelId: 'model-a',
    });
    await manager.resume('task_switch');
    await new Promise((resolve_) => setTimeout(resolve_, 20));
    const task = await store.getTask('task_switch');
    // It gets past the check; what it does next is the runtime's business and
    // fails for an unrelated reason in this harness. What matters here is
    // that it was not refused as a substitution.
    expect(task?.error?.code).not.toBe('POLICY_BLOCKED');
  });

  it('names both models, so the person can tell what happened', async () => {
    const { store, manager } = await world({
      providerId: 'openai-compatible',
      modelId: 'model-b',
    });
    await manager.resume('task_switch');
    await new Promise((resolve_) => setTimeout(resolve_, 20));
    const message = (await store.getTask('task_switch'))?.error?.userMessage ?? '';
    expect(message).toContain('model-a');
    expect(message).toContain('model-b');
  });

  it('binds the provider once per execution, not per turn', () => {
    // The adapter and its capabilities are resolved once and handed to the
    // runtime for the whole run, so a switch mid-run cannot change what the
    // turn in flight is talking to.
    const source = read('src/background/task-manager.ts');
    const execute = source.slice(
      source.indexOf('private async execute'),
      source.indexOf('\n  async ', source.indexOf('private async execute')),
    );
    expect([...execute.matchAll(/resolveProvider\(\)/g)]).toHaveLength(1);
  });
});

describe('what a switch does not touch', () => {
  it('adds no second authorization path', () => {
    const worker = read('src/background/service-worker.ts');
    const handler = worker.slice(
      worker.indexOf("router.on('provider.setActive'"),
      worker.indexOf("router.on('connector.list'"),
    );
    for (const forbidden of ['authorizeEgress', 'requestApproval', 'dispatch(']) {
      expect(handler, forbidden).not.toContain(forbidden);
    }
  });

  it('leaves the consent pin to the consent store', () => {
    // Consent is pinned to a canonical provider destination and a model, so
    // changing either already invalidates the grant. Re-implementing that at
    // the switch would be a second place for the rule to be wrong.
    const consent = read('src/security/egress/consent.ts');
    expect(consent).toContain('ProviderPin');
    const worker = read('src/background/service-worker.ts');
    const handler = worker.slice(
      worker.indexOf("router.on('provider.setActive'"),
      worker.indexOf("router.on('connector.list'"),
    );
    expect(handler).not.toContain('consent');
  });

  it('keeps credentials per provider, so a switch moves none', () => {
    const worker = read('src/background/service-worker.ts');
    // Every credential read is keyed by the provider being resolved.
    expect(worker).toContain('credentialStore.getApiKey(settings.activeProviderId)');
    expect(worker).toContain('credentialStore.getConfig(settings.activeProviderId)');
  });
});
