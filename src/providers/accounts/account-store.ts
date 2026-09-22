/**
 * Where connected accounts and the active AI brain live.
 *
 * This store holds **persistent user data**: the accounts a person connected,
 * which one is their brain, and which model on it. None of it is session
 * state, and the separation is deliberate and load-bearing — an authentication
 * session expiring, being revoked, failing to refresh, or losing its backend
 * must leave everything here exactly as it was.
 *
 * That is enforced structurally rather than by convention. This module has no
 * reference to any session store, exposes no operation that clears accounts in
 * bulk, and offers no way to un-own one. Code that ends a session physically
 * cannot reach the data here, so there is no ordering mistake or forgotten
 * branch that could make it.
 *
 * The list is written through a transaction so two concurrent connects cannot
 * interleave into a lost update. Where the backing area cannot do that, the
 * store still works — it just cannot promise atomicity, and it says so rather
 * than pretending.
 */
import { getLogger } from '@/logging/logger';
import { isTransactional, type StorageArea } from '@/storage/storage-area';
import {
  bindAccountToUser,
  credentialKeyFor,
  isConnectedAccount,
  isUnassigned,
  UNASSIGNED_ABA_USER,
  type ConnectedAccount,
} from '@/providers/accounts/account-model';

const log = getLogger('provider');

const ACCOUNTS_KEY = 'accounts';
const BRAINS_KEY = 'active-brains';
const MIGRATION_KEY = 'legacy-migration';
const ASSOCIATION_KEY = 'association-decisions';

interface AccountIndex {
  readonly accounts: readonly ConnectedAccount[];
}

/** Which connection and model one user drives. */
export interface ActiveBrain {
  readonly connectionId: string;
  readonly modelId: string | null;
}

/**
 * Every user's brain, keyed by `abaUserId`.
 *
 * Per-user rather than per-device for one reason: a second person signing in
 * on a shared browser must not inherit the first person's selection, and the
 * first person must get theirs back unchanged when they return. Keying by
 * user makes "your brain survived your session expiring" a property of the
 * storage layout rather than something a sign-in path has to remember.
 */
interface BrainIndex {
  readonly brains: Readonly<Record<string, ActiveBrain>>;
}

/** What the migration did, recorded so it cannot run twice. */
export interface MigrationRecord {
  readonly completedAt: number;
  readonly migratedConnectionId: string | null;
  readonly note: string;
}

/**
 * Reads and writes credentials, keyed by **connection**.
 *
 * Narrow on purpose: the account store needs exactly these three operations
 * during disconnection, and handing it the whole credential store would let
 * it read keys it has no business reading.
 *
 * The argument is a `connectionId`, never a provider id and never a composed
 * storage key. That is what makes two accounts on one provider incapable of
 * colliding — there is no call here that could be given a provider.
 */
export interface CredentialPort {
  read(connectionId: string): Promise<string | undefined>;
  write(connectionId: string, apiKey: string): Promise<void>;
  clear(connectionId: string): Promise<void>;
}

export interface AccountStoreOptions {
  /** Supplied so a test can produce stable ids; real use takes a UUID. */
  readonly newId?: () => string;
}

/** What `associateUnassigned` did, so a caller can report it honestly. */
export interface AssociationOutcome {
  readonly associated: number;
  readonly refused: number;
  readonly brainTransferred: boolean;
}

/**
 * Unowned accounts a signed-in user could take ownership of.
 *
 * Returned so the panel can *ask*. Nothing is moved by looking.
 */
export interface AssociationOffer {
  readonly accounts: readonly ConnectedAccount[];
  /** This user already said no. Do not ask again. */
  readonly declined: boolean;
}

interface AssociationDecisions {
  readonly declinedBy: readonly string[];
}

export class AccountStore {
  private readonly newId: () => string;

  constructor(
    private readonly area: StorageArea,
    options: AccountStoreOptions = {},
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  mintConnectionId(): string {
    return this.newId();
  }

  /**
   * Every account, with unreadable records dropped and counted.
   *
   * A record that does not parse is not rebuilt from defaults: a default
   * `status` would invent an account the user never configured, pointing at a
   * credential key that may not resolve. Dropping it loses a row; inventing
   * one loses the ability to tell a real row from a fabricated one.
   */
  async list(): Promise<readonly ConnectedAccount[]> {
    const stored = await this.area.get<AccountIndex>(ACCOUNTS_KEY);
    if (stored === undefined) return [];
    if (typeof stored !== 'object' || stored === null || !Array.isArray(stored.accounts)) {
      log.error('The account index is malformed and was not read.', {
        type: stored === null ? 'null' : typeof stored,
      });
      return [];
    }
    const usable = stored.accounts.filter((record) => isConnectedAccount(record));
    if (usable.length !== stored.accounts.length) {
      log.error('Some account records could not be read.', {
        dropped: stored.accounts.length - usable.length,
      });
    }
    return usable;
  }

  async get(connectionId: string): Promise<ConnectedAccount | undefined> {
    return (await this.list()).find((account) => account.connectionId === connectionId);
  }

  /** Adds or replaces one account, leaving every other untouched. */
  async put(account: ConnectedAccount): Promise<void> {
    await this.mutate((accounts) => [
      ...accounts.filter((existing) => existing.connectionId !== account.connectionId),
      account,
    ]);
  }

  /**
   * The unowned accounts this user could be offered, and whether they said no.
   *
   * A read. It moves nothing, so calling it on every sign-in is safe.
   */
  async associationOffer(abaUserId: string): Promise<AssociationOffer> {
    const decisions = await this.readDecisions();
    return {
      accounts: (await this.list()).filter(isUnassigned),
      declined: decisions.declinedBy.includes(abaUserId),
    };
  }

  /**
   * Takes ownership of every unowned account, on the user's explicit say-so.
   *
   * **Only ever called from a confirmed user action.** Legacy connections and
   * anything set up before signing in are not silently claimed by whoever
   * authenticates first: on a shared or handed-down browser profile that
   * would hand one person another person's provider credentials, and there is
   * no way to undo it afterwards because `bindAccountToUser` permits no
   * second move.
   *
   * Idempotent, because rebinding to the same user is a no-op. Accounts owned
   * by somebody else are counted as refused and left exactly as they are —
   * never reassigned, never deleted.
   *
   * The unowned brain selection moves with them. Without that, someone who
   * had been using the extension signed out would associate their accounts
   * and find no brain selected, which reads as a reset even though nothing
   * was lost.
   */
  async associateUnassigned(abaUserId: string): Promise<AssociationOutcome> {
    let associated = 0;
    let refused = 0;
    await this.mutate((accounts) =>
      accounts.map((account) => {
        const result = bindAccountToUser(account, abaUserId);
        if (!result.ok) {
          refused += 1;
          return account;
        }
        if (result.changed) associated += 1;
        return result.account;
      }),
    );

    let brainTransferred = false;
    await this.mutateBrains((brains) => {
      const orphan = brains[UNASSIGNED_ABA_USER];
      if (orphan === undefined || brains[abaUserId] !== undefined) return brains;
      const { [UNASSIGNED_ABA_USER]: _moved, ...rest } = brains;
      brainTransferred = true;
      return { ...rest, [abaUserId]: orphan };
    });

    if (associated > 0 || refused > 0) {
      log.info('Unowned connections were associated with a signed-in user.', {
        associated,
        refused,
      });
    }
    return { associated, refused, brainTransferred };
  }

  /**
   * Records that this user declined to take ownership.
   *
   * Deletes nothing. The unowned accounts, their credentials and their brain
   * stay exactly where they are and keep working; what is recorded is only
   * that this user should not be asked again. Declining is a decision about
   * ownership, never about retention.
   */
  async declineAssociation(abaUserId: string): Promise<void> {
    const decisions = await this.readDecisions();
    if (decisions.declinedBy.includes(abaUserId)) return;
    await this.area.set<AssociationDecisions>(ASSOCIATION_KEY, {
      declinedBy: [...decisions.declinedBy, abaUserId],
    });
    log.info('A user declined to take ownership of unowned connections; nothing was removed.');
  }

  /**
   * Removes one account and its credential.
   *
   * The credential goes first. A record removed while its key survived would
   * leave an unreferenced secret in storage with nothing left to point at it,
   * which is the shape that outlives the user's intent to disconnect.
   *
   * This is a deliberate, user-initiated deletion. It is the only thing in
   * this module that removes an account, and nothing in the authentication
   * layer calls it.
   */
  async remove(connectionId: string, credentials: CredentialPort): Promise<void> {
    await credentials.clear(credentialKeyFor(connectionId));
    await this.mutate((accounts) =>
      accounts.filter((account) => account.connectionId !== connectionId),
    );
    // Any user whose brain pointed here now has none, rather than a pointer
    // to a connection that no longer exists. No silent fallback to another
    // account: specification section 60 forbids exactly that.
    await this.mutateBrains((brains) =>
      Object.fromEntries(
        Object.entries(brains).filter(([, brain]) => brain.connectionId !== connectionId),
      ),
    );
  }

  /** The brain this user drives, or `null` if they have not chosen one. */
  async getBrain(abaUserId: string): Promise<ActiveBrain | null> {
    return (await this.readBrains())[abaUserId] ?? null;
  }

  /**
   * Selects this user's brain.
   *
   * Refuses a connection that does not exist, or one owned by somebody else.
   * An active pointer to nothing would surface later as "no provider
   * configured" at the moment a task starts, which is a confusing place to
   * learn about a settings mistake — and a pointer into another user's
   * account would be a credential boundary crossed by a settings write.
   */
  async setBrain(abaUserId: string, connectionId: string, modelId: string | null): Promise<void> {
    const account = await this.get(connectionId);
    if (!account) throw new Error(`No connected account has id "${connectionId}".`);
    if (account.abaUserId !== abaUserId && !isUnassigned(account)) {
      throw new Error('That connection belongs to a different AI Browser Agent user.');
    }
    await this.mutateBrains((brains) => ({
      ...brains,
      [abaUserId]: { connectionId, modelId },
    }));
  }

  async clearBrain(abaUserId: string): Promise<void> {
    await this.mutateBrains((brains) => {
      const { [abaUserId]: _removed, ...rest } = brains;
      return rest;
    });
  }

  /** The account this user's brain names, if it is still there. */
  async getBrainAccount(abaUserId: string): Promise<ConnectedAccount | null> {
    const brain = await this.getBrain(abaUserId);
    return brain ? ((await this.get(brain.connectionId)) ?? null) : null;
  }

  async migrationRecord(): Promise<MigrationRecord | undefined> {
    return this.area.get<MigrationRecord>(MIGRATION_KEY);
  }

  async recordMigration(record: MigrationRecord): Promise<void> {
    await this.area.set(MIGRATION_KEY, record);
  }

  private async readDecisions(): Promise<AssociationDecisions> {
    const stored = await this.area.get<AssociationDecisions>(ASSOCIATION_KEY);
    if (typeof stored !== 'object' || stored === null || !Array.isArray(stored.declinedBy)) {
      return { declinedBy: [] };
    }
    return { declinedBy: stored.declinedBy.filter((id) => typeof id === 'string') };
  }

  private async readBrains(): Promise<Readonly<Record<string, ActiveBrain>>> {
    const stored = await this.area.get<BrainIndex>(BRAINS_KEY);
    if (stored === undefined) return {};
    if (typeof stored !== 'object' || stored === null || typeof stored.brains !== 'object') {
      log.error('The active-brain index is malformed and was not read.');
      return {};
    }
    // Read as `unknown`, because what came back off disk is whatever is on
    // disk. The declared type describes what was written, not what is there.
    const raw: Record<string, unknown> = stored.brains ?? {};
    const usable: Record<string, ActiveBrain> = {};
    for (const [userId, brain] of Object.entries(raw)) {
      if (typeof brain !== 'object' || brain === null) continue;
      const { connectionId, modelId } = brain as Partial<ActiveBrain>;
      if (typeof connectionId !== 'string' || connectionId.length === 0) continue;
      usable[userId] = {
        connectionId,
        modelId: typeof modelId === 'string' ? modelId : null,
      };
    }
    return usable;
  }

  private async mutate(
    change: (accounts: readonly ConnectedAccount[]) => readonly ConnectedAccount[],
  ): Promise<void> {
    if (isTransactional(this.area)) {
      await this.area.transaction<AccountIndex>(ACCOUNTS_KEY, { accounts: [] }, (current) => ({
        accounts: change((current.accounts ?? []).filter((r) => isConnectedAccount(r))),
      }));
      return;
    }
    await this.area.set<AccountIndex>(ACCOUNTS_KEY, { accounts: change(await this.list()) });
  }

  private async mutateBrains(
    change: (
      brains: Readonly<Record<string, ActiveBrain>>,
    ) => Readonly<Record<string, ActiveBrain>>,
  ): Promise<void> {
    if (isTransactional(this.area)) {
      await this.area.transaction<BrainIndex>(BRAINS_KEY, { brains: {} }, (current) => ({
        brains: change(current.brains ?? {}),
      }));
      return;
    }
    await this.area.set<BrainIndex>(BRAINS_KEY, { brains: change(await this.readBrains()) });
  }
}
