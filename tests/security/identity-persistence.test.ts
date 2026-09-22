/**
 * TEST-SECURITY-035 — authentication lifecycle must never reset user data.
 *
 * The product requirement is blunt: expiry, revocation, logout, refresh
 * failure, a backend outage or re-authentication must not delete, reset,
 * recreate or orphan anything the user configured. A person whose session
 * lapsed and who signs back in must find the same `abaUserId`, the same
 * connected accounts, the same API keys, the same AI brain, and the same
 * workflows, tasks and audit history.
 *
 * Most of these cases assert something slightly unusual: that a whole
 * *keyspace* is byte-identical before and after an operation. That is
 * deliberate. Naming the four stores that must survive would pass while
 * silently failing to protect the fifth one somebody adds next year. Diffing
 * every key under the backing area protects the stores that do not exist yet,
 * and it is the only form of this test that cannot rot.
 *
 * The mutation cases at the end target the binding rule in production code —
 * `bindAccountToUser` — rather than a copy of its logic. An earlier suite in
 * this repository tested a re-implementation and let two real mutations
 * through; the import below is the fix for that class of mistake.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
  type StorageArea,
} from '@/storage/storage-area';
import { CredentialStore } from '@/config/settings';
import { TaskStore } from '@/tasks/task-store';
import { createTask, generateTaintSalt } from '@/tasks/task-model';
import { AccountStore, type CredentialPort } from '@/providers/accounts/account-store';
import {
  bindAccountToUser,
  credentialKeyFor,
  UNASSIGNED_ABA_USER,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';
import { IdentityProfileStore } from '@/identity/identity-profile';
import { SessionStore, evaluateSession, OFFLINE_GRACE_MS } from '@/identity/session-store';

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome ??= {
    runtime: { id: 'testextensionidtestextensionid00', sendMessage: () => Promise.resolve() },
  };
});

const USER = 'usr_123';
const OTHER_USER = 'usr_456';
const DAY = 24 * 60 * 60 * 1000;

/**
 * One browser profile's storage, and every store that reads it.
 *
 * `disk` and `memory` are the two backing areas a real worker builds:
 * `chrome.storage.local` and `chrome.storage.session`. Rebuilding the store
 * objects over the *same* areas is exactly what a service-worker restart
 * does, which is what `afterWorkerRestart` models.
 */
interface Harness {
  readonly disk: MemoryStorageArea;
  readonly memory: MemoryStorageArea;
  readonly accounts: AccountStore;
  readonly profile: IdentityProfileStore;
  readonly session: SessionStore;
  readonly credentials: CredentialStore;
  readonly credentialPort: CredentialPort;
  readonly tasks: TaskStore;
}

function stores(disk: MemoryStorageArea, memory: MemoryStorageArea): Harness {
  const local: StorageArea = new SerializedStorageArea(disk);
  const credentials = new CredentialStore(local);
  return {
    disk,
    memory,
    accounts: new AccountStore(new NamespacedStorageArea(local, 'accounts'), {
      newId: (() => {
        let n = 0;
        return () => `conn-${(n += 1)}`;
      })(),
    }),
    profile: new IdentityProfileStore(new NamespacedStorageArea(local, 'identity-profile')),
    session: new SessionStore(
      new NamespacedStorageArea(local, 'identity-session'),
      new NamespacedStorageArea(memory, 'identity-session'),
    ),
    credentials,
    credentialPort: {
      read: (connectionId) => credentials.getConnectionKey(connectionId),
      write: (connectionId, apiKey) => credentials.setConnectionKey(connectionId, apiKey),
      clear: (connectionId) => credentials.clearConnectionKey(connectionId),
    },
    tasks: new TaskStore(new NamespacedStorageArea(local, 'tasks')),
  };
}

function freshHarness(): Harness {
  return stores(new MemoryStorageArea(), new MemoryStorageArea());
}

/** A service-worker restart: same storage, new objects, memory intact. */
function afterWorkerRestart(harness: Harness): Harness {
  return stores(harness.disk, harness.memory);
}

/** A browser restart: disk survives, `chrome.storage.session` does not. */
function afterBrowserRestart(harness: Harness): Harness {
  return stores(harness.disk, new MemoryStorageArea());
}

function account(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    connectionId: 'conn-a',
    abaUserId: USER,
    providerId: 'openai-compatible',
    protocol: 'openai-compatible',
    displayName: 'OpenAI',
    accountLabel: 'api.openai.com (key …1234)',
    authKind: 'api_key',
    baseUrl: 'https://api.openai.com',
    modelId: 'gpt-4o',
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Every key and value on disk, so two moments can be compared exactly. */
async function snapshot(area: StorageArea): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of (await area.keys()).sort()) out[key] = await area.get(key);
  return out;
}

/**
 * A populated installation: two accounts at the same endpoint, their keys, a
 * chosen brain, a task, and a signed-in profile.
 *
 * Two OpenAI accounts rather than two different providers, because that is
 * the case that used to be impossible and is the one consent isolation turns
 * on.
 */
async function populated(): Promise<Harness> {
  const harness = freshHarness();
  const personal = account({ connectionId: 'conn-personal', displayName: 'OpenAI Personal' });
  const work = account({
    connectionId: 'conn-work',
    displayName: 'OpenAI Work',
    accountLabel: 'api.openai.com (key …5678)',
    modelId: 'gpt-4o-mini',
  });
  await harness.accounts.put(personal);
  await harness.accounts.put(work);
  await harness.credentials.setConnectionKey(credentialKeyFor('conn-personal'), 'sk-personal-1234');
  await harness.credentials.setConnectionKey(credentialKeyFor('conn-work'), 'sk-work-5678');
  await harness.accounts.setBrain(USER, 'conn-work', 'gpt-4o-mini');
  await harness.tasks.saveTask(
    createTask({
      id: 'task-1',
      sessionId: 'session-1',
      objective: 'book a table',
      providerId: 'openai-compatible',
      modelId: 'gpt-4o-mini',
      permissionMode: 'manual',
      now: 1_700_000_000_000,
      taintSalt: generateTaintSalt(),
    }),
  );
  await harness.profile.recordSignIn({
    abaUserId: USER,
    email: 'someone@example.test',
    emailVerified: true,
    method: 'email',
    now: 1_700_000_000_000,
  });
  await harness.session.write({
    abaUserId: USER,
    refreshToken: 'refresh-token-value',
    refreshExpiresAt: 1_700_000_000_000 + 30 * DAY,
    lastContactAt: 1_700_000_000_000,
  });
  await harness.session.writeAccess({
    token: 'access-token-value',
    expiresAt: 1_700_000_000_000 + 15 * 60 * 1000,
  });
  return harness;
}

/** Keys outside the session's own namespace must be untouched. */
function assertOnlySessionKeysChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  expect(changed.every((key) => key.startsWith('identity-session:'))).toBe(true);
}

/** Everything a user configured, in one comparable shape. */
async function userData(harness: Harness): Promise<unknown> {
  return {
    abaUserId: await harness.profile.abaUserId(),
    accounts: await harness.accounts.list(),
    brain: await harness.accounts.getBrain(USER),
    personalKey: await harness.credentials.getConnectionKey(credentialKeyFor('conn-personal')),
    workKey: await harness.credentials.getConnectionKey(credentialKeyFor('conn-work')),
    tasks: (await harness.tasks.listTasks()).map((task) => task.id),
  };
}

describe('TEST-SECURITY-035 — authentication lifecycle never resets user data', () => {
  it('01 — session expiry leaves every configured value in place', async () => {
    const harness = await populated();
    const before = await userData(harness);
    const disk = await snapshot(harness.disk);

    // The session lapses entirely: refresh token past its expiry.
    const state = evaluateSession(
      await harness.session.read(),
      null,
      1_700_000_000_000 + 40 * DAY,
      true,
    );
    expect(state.kind).toBe('expired');
    await harness.session.clear();

    expect(await userData(harness)).toEqual(before);
    assertOnlySessionKeysChanged(disk, await snapshot(harness.disk));
  });

  it('02 — access-token expiry is a refresh, not a reset', async () => {
    const harness = await populated();
    const before = await userData(harness);

    await harness.session.clearAccess();
    const state = await harness.session.state(1_700_000_000_000 + 20 * 60 * 1000, true);

    expect(state.kind).toBe('refresh_due');
    expect(await userData(harness)).toEqual(before);
  });

  it('03 — refresh failure leaves every configured value in place', async () => {
    const harness = await populated();
    const before = await userData(harness);
    const disk = await snapshot(harness.disk);

    // A rejected refresh is handled by ending the session, which is the most
    // destructive thing that path is permitted to do.
    await harness.session.clear();

    expect(await harness.session.read()).toBeNull();
    expect(await userData(harness)).toEqual(before);
    assertOnlySessionKeysChanged(disk, await snapshot(harness.disk));
  });

  it('04 — an unreachable backend keeps the user signed in and the data intact', async () => {
    const harness = await populated();
    const before = await userData(harness);

    await harness.session.clearAccess();
    const state = await harness.session.state(1_700_000_000_000 + 2 * DAY, false);

    expect(state.kind).toBe('offline_grace');
    expect(await userData(harness)).toEqual(before);
  });

  it('05 — a lapsed grace period requires re-authentication and deletes nothing', async () => {
    const harness = await populated();
    const before = await userData(harness);
    const disk = await snapshot(harness.disk);

    await harness.session.clearAccess();
    const justInside = await harness.session.state(1_700_000_000_000 + OFFLINE_GRACE_MS - 1, false);
    const justOutside = await harness.session.state(1_700_000_000_000 + OFFLINE_GRACE_MS, false);

    expect(justInside.kind).toBe('offline_grace');
    expect(justOutside).toEqual({ kind: 'expired', abaUserId: USER, reason: 'grace_lapsed' });

    // Re-authentication is demanded. Nothing is removed to demand it.
    await harness.session.clear();
    expect(await userData(harness)).toEqual(before);
    assertOnlySessionKeysChanged(disk, await snapshot(harness.disk));
  });

  it('06 — signing out keeps accounts, keys, brain, tasks and the user id', async () => {
    const harness = await populated();
    const before = await userData(harness);
    const disk = await snapshot(harness.disk);

    await harness.session.clear();

    expect(await harness.session.read()).toBeNull();
    expect(await harness.session.readAccess()).toBeNull();
    expect(await harness.profile.abaUserId()).toBe(USER);
    expect(await userData(harness)).toEqual(before);
    assertOnlySessionKeysChanged(disk, await snapshot(harness.disk));
  });

  it('07 — a service-worker restart keeps both the session and the data', async () => {
    const harness = await populated();
    const before = await userData(harness);

    const restarted = afterWorkerRestart(harness);

    // chrome.storage.session survives worker eviction, so the access token is
    // still there and the session never even needs a refresh.
    expect((await restarted.session.state(1_700_000_000_000 + 60_000, true)).kind).toBe('active');
    expect(await userData(restarted)).toEqual(before);
  });

  it('08 — a browser restart refreshes the session and keeps the data', async () => {
    const harness = await populated();
    const before = await userData(harness);

    const restarted = afterBrowserRestart(harness);

    expect(await restarted.session.readAccess()).toBeNull();
    expect((await restarted.session.state(1_700_000_000_000 + 60_000, true)).kind).toBe(
      'refresh_due',
    );
    expect(await userData(restarted)).toEqual(before);
  });

  it('09 — signing in again with Google resolves the same abaUserId', async () => {
    const harness = await populated();
    await harness.session.clear();

    const result = await harness.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'google',
      now: 1_700_000_100_000,
    });

    expect(result.ok).toBe(true);
    expect(await harness.profile.abaUserId()).toBe(USER);
    expect((await harness.accounts.list()).map((a) => a.abaUserId)).toEqual([USER, USER]);
  });

  it('10 — signing in again by email resolves the same abaUserId', async () => {
    const harness = await populated();
    await harness.session.clear();

    await harness.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'email',
      now: 1_700_000_100_000,
    });

    expect(await harness.profile.abaUserId()).toBe(USER);
  });

  it('11 — Google and email linked to one user keep one abaUserId and one profile', async () => {
    const harness = await populated();

    await harness.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'google',
      now: 1_700_000_100_000,
    });

    const profile = await harness.profile.get();
    expect(profile?.abaUserId).toBe(USER);
    expect([...(profile?.authMethods ?? [])].sort()).toEqual(['email', 'google']);
    // The first sign-in is not restamped by the second.
    expect(profile?.firstSignedInAt).toBe(1_700_000_000_000);

    // A *different* user is refused rather than overwriting, which is what
    // would otherwise strand every account bound to the first id.
    const other = await harness.profile.recordSignIn({
      abaUserId: OTHER_USER,
      email: 'someone.else@example.test',
      emailVerified: true,
      method: 'google',
      now: 1_700_000_200_000,
    });
    expect(other).toEqual({
      ok: false,
      refusal: 'DIFFERENT_USER',
      reason: expect.stringContaining('another AI Browser Agent user'),
    });
    expect(await harness.profile.abaUserId()).toBe(USER);
  });

  it('12 — provider connections are unchanged by a full sign-out and sign-in', async () => {
    const harness = await populated();
    const before = await harness.accounts.list();

    await harness.session.clear();
    await harness.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'google',
      now: 1_700_000_100_000,
    });
    await harness.accounts.associateUnassigned(USER);

    expect(await harness.accounts.list()).toEqual(before);
  });

  it('13 — API keys are unchanged by a full sign-out and sign-in', async () => {
    const harness = await populated();

    await harness.session.clear();
    await harness.accounts.associateUnassigned(USER);

    expect(await harness.credentials.getConnectionKey(credentialKeyFor('conn-personal'))).toBe(
      'sk-personal-1234',
    );
    expect(await harness.credentials.getConnectionKey(credentialKeyFor('conn-work'))).toBe(
      'sk-work-5678',
    );
  });

  it('14 — the active AI brain is unchanged by a full sign-out and sign-in', async () => {
    const harness = await populated();

    await harness.session.clear();
    const restarted = afterBrowserRestart(harness);
    await restarted.accounts.associateUnassigned(USER);

    expect(await restarted.accounts.getBrain(USER)).toEqual({
      connectionId: 'conn-work',
      modelId: 'gpt-4o-mini',
    });
  });

  it('15 — tasks and every other namespace survive a sign-out', async () => {
    const harness = await populated();
    // Stand-ins for the stores that own these namespaces, seeded directly so
    // the keyspace diff below covers them whatever their internal shape.
    const local = new SerializedStorageArea(harness.disk);
    await new NamespacedStorageArea(local, 'workflows').set('wf-1', { steps: 3 });
    await new NamespacedStorageArea(local, 'audit').set('entry-1', { seq: 1 });
    await new NamespacedStorageArea(local, 'evidence').set('ev-1', { digest: 'abc' });
    const disk = await snapshot(harness.disk);

    await harness.session.clear();

    assertOnlySessionKeysChanged(disk, await snapshot(harness.disk));
    expect((await harness.tasks.listTasks()).map((t) => t.id)).toEqual(['task-1']);
  });

  it('16 — only an explicit removal deletes an account and its credential', async () => {
    const harness = await populated();

    // Every session-ending operation, one after another.
    await harness.session.clearAccess();
    await harness.session.clear();
    expect((await harness.accounts.list()).length).toBe(2);

    // The one deliberate path.
    await harness.accounts.remove('conn-personal', harness.credentialPort);

    expect((await harness.accounts.list()).map((a) => a.connectionId)).toEqual(['conn-work']);
    expect(
      await harness.credentials.getConnectionKey(credentialKeyFor('conn-personal')),
    ).toBeUndefined();
    // The other account is untouched, credential included.
    expect(await harness.credentials.getConnectionKey(credentialKeyFor('conn-work'))).toBe(
      'sk-work-5678',
    );
  });

  it('17 — forgetting the profile is its own explicit act, separate from sign-out', async () => {
    const harness = await populated();

    await harness.session.clear();
    expect(await harness.profile.abaUserId()).toBe(USER);

    await harness.profile.forget();

    expect(await harness.profile.get()).toBeNull();
    // Erasing the identity does not erase the credentials. They are separate
    // deletions with separate consequences, and the UI must say so rather
    // than implying one covers the other.
    expect(await harness.credentials.getConnectionKey(credentialKeyFor('conn-work'))).toBe(
      'sk-work-5678',
    );
    expect((await harness.accounts.list()).length).toBe(2);
  });

  it('removing an account clears any brain that pointed at it, with no fallback', async () => {
    const harness = await populated();

    await harness.accounts.remove('conn-work', harness.credentialPort);

    // Not silently re-pointed at the surviving account: section 60 forbids a
    // provider fallback nobody chose.
    expect(await harness.accounts.getBrain(USER)).toBeNull();
  });

  it('a second user sees their own empty brain and none of the first user’s accounts', async () => {
    const harness = await populated();

    expect(await harness.accounts.getBrain(OTHER_USER)).toBeNull();
    await expect(harness.accounts.setBrain(OTHER_USER, 'conn-work', 'gpt-4o-mini')).rejects.toThrow(
      /different AI Browser Agent user/,
    );
    // The first user's selection is untouched by the attempt.
    expect(await harness.accounts.getBrain(USER)).toEqual({
      connectionId: 'conn-work',
      modelId: 'gpt-4o-mini',
    });
  });
});

describe('TEST-SECURITY-035 — the account-to-user binding', () => {
  it('associates unowned accounts once and refuses to re-home owned ones', async () => {
    const harness = freshHarness();
    await harness.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );
    await harness.accounts.put(account({ connectionId: 'conn-mine', abaUserId: USER }));
    await harness.accounts.put(account({ connectionId: 'conn-theirs', abaUserId: OTHER_USER }));

    const first = await harness.accounts.associateUnassigned(USER);
    expect(first).toEqual({ associated: 1, refused: 1, brainTransferred: false });

    // Idempotent: running it again claims nothing new and still refuses the
    // account that belongs to somebody else.
    const second = await harness.accounts.associateUnassigned(USER);
    expect(second).toEqual({ associated: 0, refused: 1, brainTransferred: false });

    const byId = new Map((await harness.accounts.list()).map((a) => [a.connectionId, a]));
    expect(byId.get('conn-legacy')?.abaUserId).toBe(USER);
    expect(byId.get('conn-mine')?.abaUserId).toBe(USER);
    expect(byId.get('conn-theirs')?.abaUserId).toBe(OTHER_USER);
  });

  it('transfers the unowned brain to the user who associates it, once', async () => {
    const harness = freshHarness();
    await harness.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );
    await harness.accounts.setBrain(UNASSIGNED_ABA_USER, 'conn-legacy', 'gpt-4o');

    expect((await harness.accounts.associateUnassigned(USER)).brainTransferred).toBe(true);
    expect(await harness.accounts.getBrain(USER)).toEqual({
      connectionId: 'conn-legacy',
      modelId: 'gpt-4o',
    });
    expect(await harness.accounts.getBrain(UNASSIGNED_ABA_USER)).toBeNull();

    // A user who already chose a brain does not have it replaced by a later
    // association; their own selection wins.
    const other = freshHarness();
    await other.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );
    await other.accounts.put(account({ connectionId: 'conn-chosen', abaUserId: USER }));
    await other.accounts.setBrain(UNASSIGNED_ABA_USER, 'conn-legacy', 'gpt-4o');
    await other.accounts.setBrain(USER, 'conn-chosen', 'gpt-4o-mini');

    expect((await other.accounts.associateUnassigned(USER)).brainTransferred).toBe(false);
    expect(await other.accounts.getBrain(USER)).toEqual({
      connectionId: 'conn-chosen',
      modelId: 'gpt-4o-mini',
    });
  });

  it('permits exactly one transition, and offers no way back', () => {
    const unowned = account({ abaUserId: UNASSIGNED_ABA_USER });
    const owned = account({ abaUserId: USER });

    expect(bindAccountToUser(unowned, USER)).toEqual({
      ok: true,
      account: { ...unowned, abaUserId: USER },
      changed: true,
    });
    expect(bindAccountToUser(owned, USER)).toEqual({ ok: true, account: owned, changed: false });
    expect(bindAccountToUser(owned, OTHER_USER)).toMatchObject({
      ok: false,
      refusal: 'ALREADY_OWNED',
    });
    expect(bindAccountToUser(owned, UNASSIGNED_ABA_USER)).toMatchObject({
      ok: false,
      refusal: 'NOT_A_USER_ID',
    });
    expect(bindAccountToUser(owned, '')).toMatchObject({ ok: false, refusal: 'NOT_A_USER_ID' });
  });
});

describe('TEST-SECURITY-035 — unowned data is never claimed without consent', () => {
  it('offers unowned accounts without moving them, and honours a decline', async () => {
    const harness = freshHarness();
    await harness.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );
    await harness.accounts.setBrain(UNASSIGNED_ABA_USER, 'conn-legacy', 'gpt-4o');

    // Looking changes nothing. A sign-in may call this every time.
    const offer = await harness.accounts.associationOffer(USER);
    expect(offer.accounts.map((a) => a.connectionId)).toEqual(['conn-legacy']);
    expect(offer.declined).toBe(false);
    expect((await harness.accounts.list())[0]?.abaUserId).toBe(UNASSIGNED_ABA_USER);

    // Saying no keeps the data working and stops the prompt coming back.
    await harness.accounts.declineAssociation(USER);
    const after = await harness.accounts.associationOffer(USER);

    expect(after.declined).toBe(true);
    expect(after.accounts.map((a) => a.connectionId)).toEqual(['conn-legacy']);
    expect((await harness.accounts.list())[0]?.abaUserId).toBe(UNASSIGNED_ABA_USER);
    // The unowned brain is untouched: declining ownership is not abandonment.
    expect(await harness.accounts.getBrain(UNASSIGNED_ABA_USER)).toEqual({
      connectionId: 'conn-legacy',
      modelId: 'gpt-4o',
    });
  });

  it('declining for one user does not hide the offer from another', async () => {
    const harness = freshHarness();
    await harness.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );

    await harness.accounts.declineAssociation(USER);

    expect((await harness.accounts.associationOffer(USER)).declined).toBe(true);
    expect((await harness.accounts.associationOffer(OTHER_USER)).declined).toBe(false);
  });

  it('a second sign-in never associates on its own — only the explicit call does', async () => {
    const harness = freshHarness();
    await harness.accounts.put(
      account({ connectionId: 'conn-legacy', abaUserId: UNASSIGNED_ABA_USER }),
    );
    await harness.profile.recordSignIn({
      abaUserId: USER,
      email: 'someone@example.test',
      emailVerified: true,
      method: 'google',
      now: 1_700_000_000_000,
    });

    // Signing in is not consent. The account is still unowned afterwards.
    expect((await harness.accounts.list())[0]?.abaUserId).toBe(UNASSIGNED_ABA_USER);

    await harness.accounts.associateUnassigned(USER);
    expect((await harness.accounts.list())[0]?.abaUserId).toBe(USER);
  });
});
