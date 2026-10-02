/**
 * TEST-BRAIN-001 — the account the user selected is the account that runs.
 *
 * ## The claim this file exists to stop being taken on trust
 *
 * "Select an AI account and the agent uses it" is the product's central
 * promise, and until now every test around it checked something adjacent: the
 * selector widget, the account store, the consent pin, the capability scope.
 * Each of those is a component of the answer and none of them *is* the answer.
 * A build could pass all of them and still send every request to whichever
 * account happened to be connected first.
 *
 * So these cases drive the real path — the real `AccountStore` over a real
 * serialised storage area, the real brain selection, the real
 * `resolveBrainAccount` — and assert on **what the adapter was handed**: the
 * key, the base URL and the model. The adapter is the only thing replaced,
 * because it is the thing that would otherwise open a socket, and it records
 * its arguments so the assertion can be about them rather than about the
 * selection that was supposed to produce them.
 *
 * ## Two accounts on one provider, deliberately
 *
 * The interesting failure is not "the wrong provider". It is **the right
 * provider and the wrong account** — a personal key and a work key on the same
 * endpoint — because one adapter instance per provider family is shared, and
 * leaving the previous account's credential in it is a cross-account leak that
 * no provider-level test can see. Every case below uses two accounts that
 * differ only in their credential, their model and their endpoint.
 *
 * ## No credential of any kind
 *
 * The keys here are fixed strings that are not credentials for anything, and
 * nothing in this file reaches the network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { AccountStore } from '@/providers/accounts/account-store';
import { UNKNOWN_CAPABILITIES } from '@/providers/core/types';
import {
  BrainUnavailable,
  resolveBrainAccount,
  type ResolveBrainDeps,
} from '@/providers/accounts/resolve-brain';
import type { ConnectedAccount } from '@/providers/accounts/account-model';
import type { AIProviderAdapter, ModelCapabilities } from '@/providers/core/types';

const OWNER = 'aba_user_under_test';

/** Not credentials: fixed strings that authenticate nothing. */
const KEY_PERSONAL = 'key-for-the-personal-account';
const KEY_WORK = 'key-for-the-work-account';

/** A measurement: every field answered, nothing left unverified. */
const MEASURED: ModelCapabilities = {
  ...UNKNOWN_CAPABILITIES,
  text: true,
  streaming: true,
  toolCalling: true,
  unverified: [],
};

/** What an adapter was asked to connect as, recorded in order. */
interface Connect {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly measuredCapabilities?: ModelCapabilities;
}

let area: MemoryStorageArea;
let accounts: AccountStore;
/** The credential vault, keyed by connection exactly as the worker keys it. */
let vault: Map<string, string>;
let connects: Connect[];
/** How many adapter instances were handed out, per provider family. */
let adapterHandouts: string[];

function adapter(): AIProviderAdapter {
  return {
    connect: (config: unknown) => {
      connects.push(config as Connect);
      return Promise.resolve({ authenticated: true });
    },
  } as unknown as AIProviderAdapter;
}

/**
 * One shared adapter instance per provider family, as the worker has.
 *
 * Shared on purpose: a registry that minted a fresh adapter per call would
 * make the cross-account leak these cases look for impossible by accident, and
 * the production registry does not do that.
 */
let instances: Map<string, AIProviderAdapter>;

function deps(): ResolveBrainDeps {
  return {
    adapterFor: (providerId) => {
      adapterHandouts.push(providerId);
      const existing = instances.get(providerId);
      if (existing) return existing;
      const made = adapter();
      instances.set(providerId, made);
      return made;
    },
    keyFor: (connectionId) => Promise.resolve(vault.get(connectionId)),
    staleMessage: (modelId) => `"${modelId}" is no longer offered`,
  };
}

function account(overrides: Partial<ConnectedAccount>): ConnectedAccount {
  return {
    connectionId: 'conn_personal',
    abaUserId: OWNER,
    providerId: 'openai-compatible',
    protocol: 'openai-compatible',
    displayName: 'OpenAI (personal)',
    accountLabel: 'api.personal.test · …ount',
    authKind: 'api_key',
    modelId: 'model-personal',
    status: 'connected',
    createdAt: 1_700_000_000_000,
    ...overrides,
  } as ConnectedAccount;
}

/** Connects an account for real, and stores its credential where the worker would. */
async function connect(overrides: Partial<ConnectedAccount>, apiKey: string): Promise<string> {
  const record = account(overrides);
  await accounts.put(record);
  vault.set(record.connectionId, apiKey);
  return record.connectionId;
}

/** Resolves whatever the brain currently is, through the production path. */
async function resolveBrain(): Promise<ReturnType<typeof resolveBrainAccount>> {
  const brain = await accounts.getBrainAccount(OWNER);
  if (brain === null) throw new Error('no brain is selected');
  return resolveBrainAccount(brain, deps());
}

beforeEach(() => {
  area = new MemoryStorageArea();
  accounts = new AccountStore(new SerializedStorageArea(area));
  vault = new Map();
  connects = [];
  adapterHandouts = [];
  instances = new Map();
});

describe('the selected account, and no other, reaches the adapter', () => {
  beforeEach(async () => {
    await connect(
      { connectionId: 'conn_personal', baseUrl: 'https://api.personal.test' },
      KEY_PERSONAL,
    );
    await connect(
      {
        connectionId: 'conn_work',
        displayName: 'OpenAI (work)',
        baseUrl: 'https://api.work.test',
        modelId: 'model-work',
      },
      KEY_WORK,
    );
  });

  it('sends the selected account’s credential, endpoint and model', async () => {
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');
    const resolved = await resolveBrain();

    expect(resolved.connectionId).toBe('conn_personal');
    expect(connects).toHaveLength(1);
    expect(connects[0]).toMatchObject({
      apiKey: KEY_PERSONAL,
      baseUrl: 'https://api.personal.test',
      model: 'model-personal',
      providerId: 'openai-compatible',
    });
    // And not the other account's, which is the failure a provider-level test
    // cannot see: both of these are the same provider.
    expect(connects[0]!.apiKey).not.toBe(KEY_WORK);
    expect(connects[0]!.baseUrl).not.toBe('https://api.work.test');
  });

  it('switches every subsequent request when the brain changes', async () => {
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');
    await resolveBrain();
    await accounts.setBrain(OWNER, 'conn_work', 'model-work');
    await resolveBrain();

    expect(connects.map((entry) => entry.apiKey)).toEqual([KEY_PERSONAL, KEY_WORK]);
    expect(connects.map((entry) => entry.model)).toEqual(['model-personal', 'model-work']);
    expect(connects.map((entry) => entry.baseUrl)).toEqual([
      'https://api.personal.test',
      'https://api.work.test',
    ]);
  });

  it('reconnects the shared adapter on every resolution, so no credential lingers', async () => {
    // The whole reason the adapter is not cached. One instance per provider
    // family is handed out twice here, and if the second resolution skipped
    // `connect` the instance would still be holding the first account's key.
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');
    await resolveBrain();
    await accounts.setBrain(OWNER, 'conn_work', 'model-work');
    await resolveBrain();

    expect(adapterHandouts).toEqual(['openai-compatible', 'openai-compatible']);
    expect(instances.size).toBe(1);
    // Two connects on one instance: the second overwrote the first.
    expect(connects).toHaveLength(2);
    expect(connects[1]!.apiKey).toBe(KEY_WORK);
  });

  it('keeps resolving the same account across repeated requests', async () => {
    // A follow-up turn or a tool-use cycle must not drift. Three resolutions,
    // one selection, one answer.
    await accounts.setBrain(OWNER, 'conn_work', 'model-work');
    for (let turn = 0; turn < 3; turn += 1) await resolveBrain();
    expect(new Set(connects.map((entry) => entry.apiKey))).toEqual(new Set([KEY_WORK]));
    expect(connects).toHaveLength(3);
  });

  it('survives a worker restart with the same selection', async () => {
    await accounts.setBrain(OWNER, 'conn_work', 'model-work');

    // A restart loses every in-memory object and keeps the storage area.
    accounts = new AccountStore(new SerializedStorageArea(area));
    instances = new Map();
    connects = [];

    const resolved = await resolveBrain();
    expect(resolved.connectionId).toBe('conn_work');
    expect(connects[0]!.apiKey).toBe(KEY_WORK);
  });
});

describe('a selection that cannot be used is refused, never substituted', () => {
  it('refuses rather than falling back to the other connected account', async () => {
    // §60 forbids a silent provider fallback. The shape that would break it:
    // two accounts connected, the selected one unusable, and a resolution that
    // helpfully uses the other.
    await connect({ connectionId: 'conn_personal' }, KEY_PERSONAL);
    await connect({ connectionId: 'conn_work', modelId: 'model-work' }, KEY_WORK);
    await accounts.setBrain(OWNER, 'conn_work', 'model-work');

    // The selected account's credential is gone from this device.
    vault.delete('conn_work');

    const error = await resolveBrain().catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BrainUnavailable);
    expect((error as BrainUnavailable).refusal).toBe('NO_CREDENTIAL_ON_DEVICE');
    // Nothing was connected as anybody.
    expect(connects).toEqual([]);
  });

  it('refuses a brain with no model chosen', async () => {
    await connect({ connectionId: 'conn_personal', modelId: null }, KEY_PERSONAL);
    await accounts.setBrain(OWNER, 'conn_personal', null);

    const error = await resolveBrain().catch((thrown: unknown) => thrown);
    expect((error as BrainUnavailable).refusal).toBe('NO_MODEL_SELECTED');
    expect(connects).toEqual([]);
  });

  it('refuses a model the last discovery did not offer, before reading a key', async () => {
    await connect({ connectionId: 'conn_personal', modelStale: true }, KEY_PERSONAL);
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');

    const error = await resolveBrain().catch((thrown: unknown) => thrown);
    expect((error as BrainUnavailable).refusal).toBe('MODEL_STALE');
    expect(connects).toEqual([]);
  });

  it('refuses when the provider rejects the stored credential', async () => {
    await connect({ connectionId: 'conn_personal' }, KEY_PERSONAL);
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');
    const brain = await accounts.getBrainAccount(OWNER);

    const error = await resolveBrainAccount(brain!, {
      ...deps(),
      adapterFor: () =>
        ({
          connect: () =>
            Promise.resolve({
              authenticated: false,
              error: { userMessage: 'That key was revoked.' },
            }),
        }) as unknown as AIProviderAdapter,
    }).catch((thrown: unknown) => thrown);

    expect((error as BrainUnavailable).refusal).toBe('CREDENTIAL_REJECTED');
    expect((error as BrainUnavailable).message).toContain('revoked');
  });

  it('leaves nothing selected when the selected account is disconnected', async () => {
    // Disconnecting the brain must clear the brain, not promote a neighbour.
    await connect({ connectionId: 'conn_personal' }, KEY_PERSONAL);
    await connect({ connectionId: 'conn_work', modelId: 'model-work' }, KEY_WORK);
    await accounts.setBrain(OWNER, 'conn_work', 'model-work');

    await accounts.remove('conn_work', {
      read: (id) => Promise.resolve(vault.get(id)),
      write: (id, key) => {
        vault.set(id, key);
        return Promise.resolve();
      },
      clear: (id) => {
        vault.delete(id);
        return Promise.resolve();
      },
    });

    expect(await accounts.getBrainAccount(OWNER)).toBeNull();
    expect(vault.has('conn_work')).toBe(false);
    // The other account is still connected and is still not the brain.
    expect((await accounts.list()).map((entry) => entry.connectionId)).toEqual(['conn_personal']);
  });
});

describe('what the adapter is told about the model it is about to drive', () => {
  it('passes a measurement taken on this exact account and model', async () => {
    await connect(
      {
        connectionId: 'conn_personal',
        capabilities: MEASURED,
        capabilityScope: { connectionId: 'conn_personal', modelId: 'model-personal' },
      },
      KEY_PERSONAL,
    );
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');

    const resolved = await resolveBrain();
    expect(connects[0]!.measuredCapabilities).toEqual(MEASURED);
    expect(resolved.capabilities).toEqual(MEASURED);
  });

  it('passes none when the measurement belongs to another account', async () => {
    // The leak this guards: a measurement from the work account vouching for
    // the personal one. It reads as evidence, which is worse than silence.
    await connect(
      {
        connectionId: 'conn_personal',
        capabilities: MEASURED,
        capabilityScope: { connectionId: 'conn_work', modelId: 'model-personal' },
      },
      KEY_PERSONAL,
    );
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');

    const resolved = await resolveBrain();
    expect(connects[0]!.measuredCapabilities).toBeUndefined();
    expect(resolved.capabilities).toEqual(UNKNOWN_CAPABILITIES);
  });

  it('passes none when the measurement belongs to another model', async () => {
    await connect(
      {
        connectionId: 'conn_personal',
        capabilities: MEASURED,
        capabilityScope: { connectionId: 'conn_personal', modelId: 'model-other' },
      },
      KEY_PERSONAL,
    );
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');

    const resolved = await resolveBrain();
    expect(connects[0]!.measuredCapabilities).toBeUndefined();
    expect(resolved.capabilities).toEqual(UNKNOWN_CAPABILITIES);
  });
});

describe('two owners never see each other’s accounts', () => {
  it('resolves nothing for an owner who selected nothing', async () => {
    await connect({ connectionId: 'conn_personal' }, KEY_PERSONAL);
    await accounts.setBrain(OWNER, 'conn_personal', 'model-personal');

    // A different local owner partition. The brain is per owner, so this one
    // has none — and the answer is "nothing selected", not "somebody else's".
    expect(await accounts.getBrainAccount('aba_someone_else')).toBeNull();
    expect(connects).toEqual([]);
  });
});
