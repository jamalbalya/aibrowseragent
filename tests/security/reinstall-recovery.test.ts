/**
 * TEST-SECURITY-037 — reinstall, recovery, and not starting from zero.
 *
 * An extension reinstall, a Chrome profile recreation and a full Chrome
 * reinstall are the same event as far as this code can observe: local storage
 * is gone and a user turns up who can authenticate. So they are modelled the
 * same way — by discarding the backing area and rebuilding every store over a
 * fresh one, which is exactly what those events do.
 *
 * What cannot be automated is the uninstall itself. Chrome offers no way to
 * drive it, so the real thing is a HUMAN-BLOCKED acceptance step and is
 * recorded as blocked rather than reported as passing. What *is* automated
 * here is everything that happens after: that restoration binds to the
 * existing user rather than inventing one, that a restored connection admits
 * it has no key instead of pretending, and that a device already in use is
 * not overwritten by a remote copy that knows less than it does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
  type StorageArea,
} from '@/storage/storage-area';
import { CredentialStore } from '@/config/settings';
import { AccountStore, type CredentialPort } from '@/providers/accounts/account-store';
import {
  credentialKeyFor,
  UNASSIGNED_ABA_USER,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';
import {
  needsReconnect,
  restoreConnections,
  type ConnectionMetadata,
} from '@/providers/accounts/restore';
import { IdentityProfileStore } from '@/identity/identity-profile';
import { SessionStore } from '@/identity/session-store';
import { DataStoragePreferenceStore } from '@/storage/data-storage-preference';
import { CREDENTIAL_RECONNECT_NOTICE } from '@/storage/data-classification';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const USER = 'usr_123';
const OTHER_USER = 'usr_456';
const NOW = 1_700_000_000_000;

interface Device {
  readonly disk: MemoryStorageArea;
  readonly accounts: AccountStore;
  readonly profile: IdentityProfileStore;
  readonly session: SessionStore;
  readonly credentials: CredentialStore;
  readonly port: CredentialPort;
  readonly preference: DataStoragePreferenceStore;
}

function device(disk: MemoryStorageArea, memory: MemoryStorageArea): Device {
  const local: StorageArea = new SerializedStorageArea(disk);
  const credentials = new CredentialStore(local);
  return {
    disk,
    accounts: new AccountStore(new NamespacedStorageArea(local, 'accounts')),
    profile: new IdentityProfileStore(new NamespacedStorageArea(local, 'identity-profile')),
    session: new SessionStore(
      new NamespacedStorageArea(local, 'identity-session'),
      new NamespacedStorageArea(memory, 'identity-session'),
    ),
    credentials,
    port: {
      read: (connectionId) => credentials.getConnectionKey(connectionId),
      write: (connectionId, apiKey) => credentials.setConnectionKey(connectionId, apiKey),
      clear: (connectionId) => credentials.clearConnectionKey(connectionId),
    },
    preference: new DataStoragePreferenceStore(new NamespacedStorageArea(local, 'settings')),
  };
}

const fresh = (): Device => device(new MemoryStorageArea(), new MemoryStorageArea());

/**
 * A reinstall: local storage is gone.
 *
 * The same fixture stands in for an extension reinstall, a Chrome profile
 * recreation and a Chrome reinstall, because all three present this code with
 * an empty area and a user who can sign in again.
 */
const afterReinstall = (): Device => fresh();

function account(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    connectionId: 'conn-personal',
    abaUserId: USER,
    providerId: 'openai-compatible',
    protocol: 'openai-compatible',
    displayName: 'OpenAI — Personal',
    accountLabel: 'api.openai.com (key …1234)',
    authKind: 'api_key',
    baseUrl: 'https://api.openai.com',
    modelId: 'gpt-4o',
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

const metadata = (overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata => ({
  connectionId: 'conn-personal',
  providerId: 'openai-compatible',
  protocol: 'openai-compatible',
  authKind: 'api_key',
  displayName: 'OpenAI — Personal',
  accountLabel: 'api.openai.com (key …1234)',
  baseUrl: 'https://api.openai.com',
  modelId: 'gpt-4o',
  createdAt: NOW,
  ...overrides,
});

describe('TEST-SECURITY-037 — reinstall recovery', () => {
  it('01 — a reinstall really does start empty, which is what recovery is for', async () => {
    const before = fresh();
    await before.accounts.put(account());
    await before.credentials.setConnectionKey(credentialKeyFor('conn-personal'), 'sk-1234');

    const after = afterReinstall();

    expect(await after.accounts.list()).toEqual([]);
    expect(await after.profile.get()).toBeNull();
    expect(
      await after.credentials.getConnectionKey(credentialKeyFor('conn-personal')),
    ).toBeUndefined();
  });

  it('02 — restoring binds to the existing user and never invents one', async () => {
    const reinstalled = afterReinstall();
    await reinstalled.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'google',
      now: NOW,
    });

    const outcome = await restoreConnections(
      reinstalled.accounts,
      reinstalled.port,
      USER,
      [metadata(), metadata({ connectionId: 'conn-work', displayName: 'OpenAI — Work' })],
      NOW,
    );

    expect(outcome.restored).toEqual(['conn-personal', 'conn-work']);
    expect((await reinstalled.accounts.list()).map((a) => a.abaUserId)).toEqual([USER, USER]);
    // The same id the user had before. A restore that minted a new one is the
    // "Welcome! Start from zero" failure this whole suite exists to prevent.
    expect(await reinstalled.profile.abaUserId()).toBe(USER);
  });

  it('03 — a restored connection says it needs its key back rather than pretending', async () => {
    const reinstalled = afterReinstall();

    await restoreConnections(reinstalled.accounts, reinstalled.port, USER, [metadata()], NOW);
    const restored = await reinstalled.accounts.get('conn-personal');

    expect(restored?.status).toBe('disconnected');
    expect(restored?.statusReason).toBe(CREDENTIAL_RECONNECT_NOTICE);
    expect(needsReconnect(restored!)).toBe(true);
    // No credential was invented, and none arrived with the metadata.
    expect(
      await reinstalled.credentials.getConnectionKey(credentialKeyFor('conn-personal')),
    ).toBeUndefined();
  });

  it('04 — a restored connection carries no capability claim from another device', async () => {
    const reinstalled = afterReinstall();

    await restoreConnections(reinstalled.accounts, reinstalled.port, USER, [metadata()], NOW);
    const restored = await reinstalled.accounts.get('conn-personal');

    // Measured elsewhere, on a key this device does not hold. Carrying it
    // forward would turn evidence about one installation into a claim about
    // another, which is the P-033 finding in a new disguise.
    expect(restored?.capabilities).toBeNull();
    expect(restored?.capabilityScope).toBeNull();
    expect(restored?.lastValidated).toBeNull();
  });

  it('05 — restoring never downgrades a working local connection', async () => {
    const inUse = fresh();
    await inUse.accounts.put(account());
    await inUse.credentials.setConnectionKey(credentialKeyFor('conn-personal'), 'sk-still-works');

    const outcome = await restoreConnections(
      inUse.accounts,
      inUse.port,
      USER,
      [metadata({ displayName: 'stale remote name' })],
      NOW,
    );

    expect(outcome.keptLocal).toEqual(['conn-personal']);
    const kept = await inUse.accounts.get('conn-personal');
    expect(kept?.status).toBe('connected');
    expect(kept?.displayName).toBe('OpenAI — Personal');
    expect(await inUse.credentials.getConnectionKey(credentialKeyFor('conn-personal'))).toBe(
      'sk-still-works',
    );
  });

  it('06 — a local record with no key is replaced by the restored one', async () => {
    const half = fresh();
    await half.accounts.put(account({ status: 'failed' }));

    const outcome = await restoreConnections(half.accounts, half.port, USER, [metadata()], NOW);

    expect(outcome.restored).toEqual(['conn-personal']);
    expect((await half.accounts.get('conn-personal'))?.status).toBe('disconnected');
  });

  it('07 — malformed records are rejected, not written as half an account', async () => {
    const reinstalled = afterReinstall();

    const outcome = await restoreConnections(
      reinstalled.accounts,
      reinstalled.port,
      USER,
      [
        metadata(),
        { ...metadata({ connectionId: '' }) },
        { ...metadata({ connectionId: 'conn-bad' }), providerId: 42 as unknown as string },
      ],
      NOW,
    );

    expect(outcome.restored).toEqual(['conn-personal']);
    expect(outcome.rejected.length).toBe(2);
    expect((await reinstalled.accounts.list()).length).toBe(1);
  });

  it('08 — restored data belongs to the restoring user and not to another', async () => {
    const reinstalled = afterReinstall();
    await restoreConnections(reinstalled.accounts, reinstalled.port, USER, [metadata()], NOW);

    // A second user on the same device sees none of it and cannot drive it.
    await expect(
      reinstalled.accounts.setBrain(OTHER_USER, 'conn-personal', 'gpt-4o'),
    ).rejects.toThrow(/different AI Browser Agent user/);
    expect(await reinstalled.accounts.getBrain(OTHER_USER)).toBeNull();
  });

  it('09 — local mode has nothing to restore, and the code does not pretend', async () => {
    const reinstalled = afterReinstall();

    // A local-mode user's data was never uploaded, so recovery is genuinely
    // empty. The honest outcome is an empty installation plus the warning the
    // panel shows, not a fabricated one.
    expect(await reinstalled.preference.mode()).toBe('local');
    const outcome = await restoreConnections(reinstalled.accounts, reinstalled.port, USER, [], NOW);
    expect(outcome).toEqual({ restored: [], keptLocal: [], rejected: [] });
    expect(await reinstalled.accounts.list()).toEqual([]);
  });

  it('10 — a fresh install is local, has chosen nothing, and uploads nothing', async () => {
    const installed = fresh();

    // Local-first is the product default, not an unanswered question. The
    // extension is usable immediately, with no account and no backend.
    expect(await installed.preference.mode()).toBe('local');
    expect(await installed.preference.hasChosen()).toBe(false);

    // Choosing local turns the default into a decision and changes nothing
    // else — the mode was already local.
    await installed.preference.choose('local', NOW);
    expect(await installed.preference.mode()).toBe('local');
    expect(await installed.preference.hasChosen()).toBe(true);
  });

  it('11 — the device id is minted once and is stable thereafter', async () => {
    const installed = fresh();
    // `dev_` plus a UUID: the shape K1 §16 specifies and the backend's
    // `isDeviceId` enforces. A value of any other shape is not a device id.
    const A = 'dev_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const B = 'dev_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const C = 'dev_cccccccc-cccc-cccc-cccc-cccccccccccc';

    const first = await installed.preference.deviceId(() => A);
    const second = await installed.preference.deviceId(() => B);

    expect(first).toBe(A);
    expect(second).toBe(A);

    // A reinstall is a new device, which is what makes per-device sync keys
    // meaningful rather than a second name for the user.
    expect(await afterReinstall().preference.deviceId(() => C)).toBe(C);
  });

  it('11b — a device id from a build that minted the wrong shape is replaced', async () => {
    const installed = fresh();
    const good = 'dev_dddddddd-dddd-dddd-dddd-dddddddddddd';

    // What an earlier build wrote: a bare UUID, which the backend would
    // refuse. Re-minting costs nothing — nothing consumes a device id yet —
    // and sending one the server rejects would cost the association.
    await installed.preference.deviceId(() => '7c9e6679-7425-40de-944b-e07fc1f90ae7');
    const replaced = await installed.preference.deviceId(() => good);

    expect(replaced).toBe(good);
    // Stable from then on.
    expect(
      await installed.preference.deviceId(() => 'dev_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
    ).toBe(good);
  });

  it('12 — unowned legacy data survives a reinstall-and-decline without being touched', async () => {
    const installed = fresh();
    await installed.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );
    await installed.credentials.setConnectionKey(credentialKeyFor('conn-legacy'), 'sk-legacy');

    await installed.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'email',
      now: NOW,
    });
    await installed.accounts.declineAssociation(USER);

    const legacy = await installed.accounts.get('conn-legacy');
    expect(legacy?.abaUserId).toBe(UNASSIGNED_ABA_USER);
    expect(await installed.credentials.getConnectionKey(credentialKeyFor('conn-legacy'))).toBe(
      'sk-legacy',
    );
  });
});
