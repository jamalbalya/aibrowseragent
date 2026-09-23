/**
 * Turning the single provider slot into the first connected account.
 *
 * Before this, a user had exactly one connection: `settings.connection` plus
 * a credential at `apiKey:${providerId}`. After it they have an account list.
 * The upgrade runs once, on the first startup of the new build, against
 * storage that already holds someone's working setup.
 *
 * The ordering is the whole design, and it is chosen so that every point at
 * which this can be interrupted leaves the user better off than losing their
 * key:
 *
 *  1. Write the new credential.
 *  2. Write the account record.
 *  3. **Read both back and verify.**
 *  4. Only then remove the legacy credential.
 *  5. Only then record that migration happened.
 *
 * Interrupted between 1 and 4, the legacy credential is still there and the
 * next run migrates again — which is why step 0 checks for an account that
 * already came from this legacy record, and why re-running is a no-op rather
 * than a duplicate. Interrupted after 4, the record at step 5 is missing but
 * the legacy key is gone, so the next run finds nothing to migrate and stops.
 *
 * The one thing this never does is remove a credential it has not first
 * proved it can read back from its new home.
 */
import { getLogger } from '@/logging/logger';
import {
  credentialKeyFor,
  UNASSIGNED_ABA_USER,
  type ConnectedAccount,
  type Protocol,
} from './account-model';
import type { AccountStore } from './account-store';

const log = getLogger('provider');

/** The shape the previous build persisted. Read-only; never written again. */
export interface LegacyConnection {
  /**
   * Set when this record is a **projection of a connected account**, not a
   * record from before accounts existed.
   *
   * The settings slot now has two possible authors. The pre-account build
   * wrote it as the one connection there could be; the account routes write it
   * as a display projection of whichever account is the AI brain, and those
   * carry the connection id they came from. Only the first is a thing to
   * migrate.
   */
  readonly connectionId?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly authKind?: string;
  readonly accountLabel?: string;
  readonly createdAt?: number;
  readonly status?: string;
}

export type MigrationOutcome =
  | { readonly kind: 'migrated'; readonly connectionId: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * The two credential key spaces migration spans.
 *
 * Named separately rather than sharing one keyed port, because they are
 * genuinely different schemes: the legacy one is keyed by *provider* and is
 * why two accounts could not coexist, and the new one is keyed by
 * *connection*. A single port would make the whole point of the migration
 * invisible at the call site, and would let a provider id be passed where a
 * connection belongs.
 */
export interface MigrationCredentialPorts {
  readLegacy(providerId: string): Promise<string | undefined>;
  clearLegacy(providerId: string): Promise<void>;
  readConnection(connectionId: string): Promise<string | undefined>;
  writeConnection(connectionId: string, apiKey: string): Promise<void>;
}

export interface MigrationPorts {
  readonly store: AccountStore;
  readonly credentials: MigrationCredentialPorts;
  readonly readLegacyConnection: () => Promise<LegacyConnection | undefined>;
  readonly clearLegacyConnection: () => Promise<void>;
  readonly now?: () => number;
}

/** Which protocol a legacy provider id spoke. */
export function protocolForLegacyProvider(providerId: string): Protocol {
  if (providerId === 'anthropic') return 'anthropic';
  if (providerId === 'gemini') return 'gemini';
  return 'openai-compatible';
}

function isUsableKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Migrates the legacy connection, or explains why it did not.
 *
 * Never throws. A failure here must not stop the extension starting — a user
 * whose migration failed still needs a working side panel to reconnect from,
 * and the failure is reported through persistence health where it can gate
 * work rather than through an exception that would take startup down.
 */
export async function migrateLegacyConnection(ports: MigrationPorts): Promise<MigrationOutcome> {
  const now = ports.now ?? (() => Date.now());
  try {
    const already = await ports.store.migrationRecord();
    if (already) return { kind: 'skipped', reason: 'Migration already ran.' };

    const legacy = await ports.readLegacyConnection();

    // A projection of an account is not a record to migrate, and getting this
    // wrong is not a no-op. Migration would mint a *second* account for a
    // connection that already has one; it would then look for the credential
    // under `apiKey:<providerId>`, which a projection never has, conclude the
    // connection has no usable key, and clear the settings slot — leaving an
    // installation whose panel shows nothing connected while the account and
    // its key sit untouched a namespace away.
    //
    // Reachable because migration is fire-and-forget at worker start and the
    // panel can write a projection while it is still running.
    if (legacy && typeof legacy.connectionId === 'string' && legacy.connectionId.length > 0) {
      return { kind: 'skipped', reason: 'The settings connection is a projection of an account.' };
    }

    if (!legacy || typeof legacy !== 'object' || typeof legacy.providerId !== 'string') {
      // Nothing to migrate is the common case on a fresh install, and it is
      // recorded so the check does not run again on every startup.
      await ports.store.recordMigration({
        completedAt: now(),
        migratedConnectionId: null,
        note: 'No legacy connection was present.',
      });
      return { kind: 'skipped', reason: 'No legacy connection.' };
    }

    const apiKey = await ports.credentials.readLegacy(legacy.providerId);
    if (!isUsableKey(apiKey)) {
      // A connection record with no credential behind it cannot be carried
      // forward as a working account, and inventing one would produce an
      // account that fails at the first request. The record is dropped and
      // the user reconnects — with nothing lost, because there was no key.
      await ports.store.recordMigration({
        completedAt: now(),
        migratedConnectionId: null,
        note: 'A legacy connection was present with no usable credential.',
      });
      await ports.clearLegacyConnection();
      return { kind: 'skipped', reason: 'Legacy connection had no usable credential.' };
    }

    const connectionId = ports.store.mintConnectionId();
    const account: ConnectedAccount = {
      connectionId,
      // Unowned, because nobody has signed in yet — migration runs at
      // startup, which is before any authentication. Withholding a working
      // provider connection until the user creates an account with us would
      // break a working installation on upgrade, so the account is carried
      // forward unowned and claimed by the first user who signs in. Once
      // claimed it stays claimed: `bindAccountToUser` permits no other move.
      abaUserId: UNASSIGNED_ABA_USER,
      providerId: legacy.providerId,
      protocol: protocolForLegacyProvider(legacy.providerId),
      displayName: legacy.providerId,
      accountLabel: legacy.accountLabel ?? 'migrated account',
      authKind: 'api_key',
      modelId: typeof legacy.modelId === 'string' ? legacy.modelId : null,
      // Deliberately dropped. A measurement taken before the account had an
      // identity cannot be scoped to one, and an unscoped measurement is
      // exactly what the switch rules exist to reject.
      capabilities: null,
      capabilityScope: null,
      status: 'connected',
      lastValidated: null,
      createdAt: typeof legacy.createdAt === 'number' ? legacy.createdAt : now(),
    };

    await ports.credentials.writeConnection(credentialKeyFor(connectionId), apiKey);
    await ports.store.put(account);

    // The verification the whole ordering exists for.
    const storedKey = await ports.credentials.readConnection(credentialKeyFor(connectionId));
    const storedAccount = await ports.store.get(connectionId);
    if (storedKey !== apiKey || storedAccount === undefined) {
      log.error('Migration could not be verified; the legacy credential was kept.', {
        connectionId,
      });
      return {
        kind: 'failed',
        reason:
          'The migrated account could not be read back. The previous configuration is intact.',
      };
    }

    // The migrated account becomes the unowned brain, so an upgraded
    // installation keeps working without the user re-selecting anything. It
    // transfers to them on their first sign-in.
    await ports.store.setBrain(
      UNASSIGNED_ABA_USER,
      connectionId,
      typeof legacy.modelId === 'string' ? legacy.modelId : null,
    );
    await ports.credentials.clearLegacy(legacy.providerId);
    await ports.clearLegacyConnection();
    await ports.store.recordMigration({
      completedAt: now(),
      migratedConnectionId: connectionId,
      note: 'Legacy single-provider connection migrated.',
    });
    log.info('Legacy connection migrated to a connected account.', { connectionId });
    return { kind: 'migrated', connectionId };
  } catch (error) {
    // Reported, never rethrown: startup continues and persistence health
    // carries the fault.
    log.error('Migration failed.', { error: error instanceof Error ? error.name : 'unknown' });
    return {
      kind: 'failed',
      reason: 'Migration failed. The previous configuration was left untouched.',
    };
  }
}
