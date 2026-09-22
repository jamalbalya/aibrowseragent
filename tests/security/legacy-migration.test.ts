/**
 * TEST-SECURITY-039 — migrating a working setup without losing a credential.
 *
 * The user being migrated already has a provider connected and working. A
 * provider API key is something they pay for and may not be able to recover,
 * so the bar is not "usually succeeds" — it is that **no interruption, at any
 * point, leaves them without a usable key**.
 *
 * The ordering is what delivers that, and these cases are written against each
 * of its seams:
 *
 *   1. write the new credential
 *   2. write the account record
 *   3. read both back and verify
 *   4. only then delete the legacy credential
 *   5. only then write the migration marker
 *
 * Interrupted anywhere in 1–3, the legacy key is untouched and the next
 * startup migrates again. Interrupted between 4 and 5, the marker is missing
 * but so is the legacy record, so the next startup finds nothing and stops.
 * There is no ordering here that can delete a credential it has not first
 * proved it can read back from its new home.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryStorageArea, NamespacedStorageArea } from '@/storage/storage-area';
import { AccountStore } from '@/providers/accounts/account-store';
import {
  migrateLegacyConnection,
  protocolForLegacyProvider,
  type LegacyConnection,
  type MigrationCredentialPorts,
} from '@/providers/accounts/migrate-legacy';
import { credentialKeyFor, UNASSIGNED_ABA_USER } from '@/providers/accounts/account-model';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const NOW = 1_700_000_000_000;

/**
 * Both credential key spaces, with a fault injectable at each step.
 *
 * The two spaces are kept visibly separate in the snapshot — `apiKey:` for
 * the legacy provider-keyed scheme and `conn:` for the connection-keyed one —
 * so an assertion about "the legacy key survived" cannot accidentally be
 * satisfied by the new one.
 */
class FaultyCredentials implements MigrationCredentialPorts {
  private readonly keys = new Map<string, string>();
  failOn: { set?: boolean; clear?: boolean; getAfterSet?: boolean } = {};
  private setCount = 0;

  seedLegacy(providerId: string, value: string): void {
    this.keys.set(`apiKey:${providerId}`, value);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.keys);
  }

  readLegacy(providerId: string): Promise<string | undefined> {
    return Promise.resolve(this.keys.get(`apiKey:${providerId}`));
  }

  clearLegacy(providerId: string): Promise<void> {
    if (this.failOn.clear) return Promise.reject(new Error('storage full'));
    this.keys.delete(`apiKey:${providerId}`);
    return Promise.resolve();
  }

  readConnection(connectionId: string): Promise<string | undefined> {
    if (this.failOn.getAfterSet && this.setCount > 0) {
      // Models a read-back that does not return what was written — the exact
      // condition step 3 exists to detect.
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.keys.get(`conn:${connectionId}`));
  }

  writeConnection(connectionId: string, apiKey: string): Promise<void> {
    if (this.failOn.set) return Promise.reject(new Error('storage full'));
    this.setCount += 1;
    this.keys.set(`conn:${connectionId}`, apiKey);
    return Promise.resolve();
  }
}

interface Fixture {
  readonly store: AccountStore;
  readonly credentials: FaultyCredentials;
  readonly legacy: () => LegacyConnection | undefined;
  readonly ports: Parameters<typeof migrateLegacyConnection>[0];
}

const DEFAULT_LEGACY: LegacyConnection = {
  providerId: 'openai-compatible',
  modelId: 'gpt-4o',
  accountLabel: 'api.openai.com',
  createdAt: NOW - 1000,
};

/** `null` means a fresh install with no legacy connection at all. */
function fixture(legacy: LegacyConnection | null = DEFAULT_LEGACY): Fixture {
  const credentials = new FaultyCredentials();
  if (legacy) credentials.seedLegacy(legacy.providerId, 'sk-legacy-value');
  const store = new AccountStore(new NamespacedStorageArea(new MemoryStorageArea(), 'accounts'), {
    newId: () => 'conn-migrated',
  });
  const state: { legacy: LegacyConnection | undefined } = { legacy: legacy ?? undefined };
  return {
    store,
    credentials,
    legacy: () => state.legacy,
    ports: {
      store,
      credentials,
      readLegacyConnection: () => Promise.resolve(state.legacy),
      clearLegacyConnection: () => {
        state.legacy = undefined;
        return Promise.resolve();
      },
      now: () => NOW,
    },
  };
}

describe('TEST-SECURITY-039 — legacy credential migration', () => {
  it('01 — migrates the connection, the credential and the brain', async () => {
    const f = fixture();

    const outcome = await migrateLegacyConnection(f.ports);

    expect(outcome).toEqual({ kind: 'migrated', connectionId: 'conn-migrated' });
    const account = await f.store.get('conn-migrated');
    expect(account?.providerId).toBe('openai-compatible');
    expect(account?.modelId).toBe('gpt-4o');
    expect(account?.abaUserId).toBe(UNASSIGNED_ABA_USER);
    expect(f.credentials.snapshot()).toEqual({ 'conn:conn-migrated': 'sk-legacy-value' });
    // The upgraded installation keeps working with no re-selection.
    expect(await f.store.getBrain(UNASSIGNED_ABA_USER)).toEqual({
      connectionId: 'conn-migrated',
      modelId: 'gpt-4o',
    });
  });

  it('02 — drops capability measurements rather than rescoping them', async () => {
    const f = fixture();
    await migrateLegacyConnection(f.ports);

    const account = await f.store.get('conn-migrated');
    // Measured before the account had an identity, so they cannot be scoped
    // to one now. A stale measurement reads as evidence, which is worse than
    // none, because nothing downstream can tell the two apart.
    expect(account?.capabilities).toBeNull();
    expect(account?.capabilityScope).toBeNull();
  });

  it('03 — a failure writing the new credential keeps the legacy one', async () => {
    const f = fixture();
    f.credentials.failOn.set = true;

    const outcome = await migrateLegacyConnection(f.ports);

    expect(outcome.kind).toBe('failed');
    expect(f.credentials.snapshot()).toEqual({ 'apiKey:openai-compatible': 'sk-legacy-value' });
    expect(f.legacy()).toBeDefined();
    // No marker, so the next startup tries again rather than giving up.
    expect(await f.store.migrationRecord()).toBeUndefined();
  });

  it('04 — a credential that will not read back is never deleted from its old home', async () => {
    const f = fixture();
    f.credentials.failOn.getAfterSet = true;

    const outcome = await migrateLegacyConnection(f.ports);

    expect(outcome.kind).toBe('failed');
    expect(f.credentials.snapshot()['apiKey:openai-compatible']).toBe('sk-legacy-value');
    expect(f.legacy()).toBeDefined();
    expect(await f.store.migrationRecord()).toBeUndefined();
  });

  it('05 — a failure deleting the legacy key leaves both copies, never none', async () => {
    const f = fixture();
    f.credentials.failOn.clear = true;

    const outcome = await migrateLegacyConnection(f.ports);

    expect(outcome.kind).toBe('failed');
    const keys = f.credentials.snapshot();
    // Both present. Duplication is recoverable; absence is not.
    expect(keys['apiKey:openai-compatible']).toBe('sk-legacy-value');
    expect(keys['conn:conn-migrated']).toBe('sk-legacy-value');
  });

  it('06 — re-running after a success is a no-op, not a duplicate', async () => {
    const f = fixture();
    await migrateLegacyConnection(f.ports);

    const second = await migrateLegacyConnection(f.ports);

    expect(second).toEqual({ kind: 'skipped', reason: 'Migration already ran.' });
    expect((await f.store.list()).length).toBe(1);
  });

  it('07 — re-running after a failure retries and succeeds', async () => {
    const f = fixture();
    f.credentials.failOn.set = true;
    expect((await migrateLegacyConnection(f.ports)).kind).toBe('failed');

    f.credentials.failOn.set = false;
    const retry = await migrateLegacyConnection(f.ports);

    expect(retry).toEqual({ kind: 'migrated', connectionId: 'conn-migrated' });
    expect(f.credentials.snapshot()).toEqual({ 'conn:conn-migrated': 'sk-legacy-value' });
  });

  it('08 — a fresh install records that there was nothing to migrate', async () => {
    const f = fixture(null);

    const outcome = await migrateLegacyConnection(f.ports);

    expect(outcome.kind).toBe('skipped');
    expect((await f.store.list()).length).toBe(0);
    // Recorded, so the check does not run on every single startup forever.
    expect(await f.store.migrationRecord()).toBeDefined();
  });

  it('09 — a connection with no credential is not carried forward as working', async () => {
    const f = fixture();
    // The record exists but the key does not: an account built from this
    // would fail at its first request with an error the user cannot act on.
    await f.credentials.clearLegacy('openai-compatible');

    const outcome = await migrateLegacyConnection(f.ports);

    expect(outcome.kind).toBe('skipped');
    expect((await f.store.list()).length).toBe(0);
  });

  it('10 — never throws, because startup has to continue either way', async () => {
    const f = fixture();
    const exploding = {
      ...f.ports,
      readLegacyConnection: () => Promise.reject(new Error('storage unavailable')),
    };

    await expect(migrateLegacyConnection(exploding)).resolves.toMatchObject({ kind: 'failed' });
  });

  it('11 — maps legacy provider ids onto the right wire protocol', () => {
    expect(protocolForLegacyProvider('anthropic')).toBe('anthropic');
    expect(protocolForLegacyProvider('gemini')).toBe('gemini');
    expect(protocolForLegacyProvider('openai-compatible')).toBe('openai-compatible');
    // An unknown vendor speaks the protocol the shared adapter implements,
    // which is what makes DeepSeek, Groq and the rest work without an adapter
    // each.
    expect(protocolForLegacyProvider('deepseek')).toBe('openai-compatible');
  });

  it('12 — the migrated account is unowned, not handed to whoever signs in', async () => {
    const f = fixture();
    await migrateLegacyConnection(f.ports);

    const offer = await f.store.associationOffer('usr_123');
    expect(offer.accounts.map((a) => a.connectionId)).toEqual(['conn-migrated']);
    // Still unowned: the offer is a question, not a transfer.
    expect((await f.store.get('conn-migrated'))?.abaUserId).toBe(UNASSIGNED_ABA_USER);
    // And the credential is exactly where migration put it.
    expect(await f.credentials.readConnection(credentialKeyFor('conn-migrated'))).toBe(
      'sk-legacy-value',
    );
  });
});
