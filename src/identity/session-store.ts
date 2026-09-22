/**
 * The authentication session, and nothing that outlives it.
 *
 * Everything here is **ephemeral by design**: a short-lived access token, a
 * refresh token that expires, and the timestamp of the last successful
 * contact with the backend. All of it may vanish at any moment — browser
 * restart, token expiry, revocation, sign-out — and that is the expected
 * behaviour rather than a fault.
 *
 * **What this module deliberately cannot do.** It imports no account store,
 * no credential store, no identity profile, no task or workflow store. It has
 * no reference to any of them and therefore no way to clear, reset or orphan
 * a single byte of persistent user data. `clear()` removes two keys inside
 * this module's own namespace and that is the whole of its reach.
 *
 * This is the persistence invariant expressed as a dependency graph: a
 * session ending cannot delete a user's connected accounts because the code
 * that ends sessions has never been given a way to name them.
 *
 * The access token is held in a memory-backed area and the refresh token in a
 * disk-backed one, which is why the constructor takes two. `chrome.storage.session`
 * survives service-worker eviction and is cleared when the browser closes —
 * measured, not assumed — so a worker restart keeps both halves and the
 * session simply continues, while a browser restart keeps only the refresh
 * token and the session silently refreshes. Neither asks the user to sign in
 * again, and neither touches anything a user configured.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';

const log = getLogger('security');

const REFRESH_KEY = 'refresh';
const ACCESS_KEY = 'access';

/**
 * How long a session survives without reaching the backend.
 *
 * Browsing, connected accounts and every security control are local, so a
 * backend outage has no bearing on whether the extension can work. Making an
 * outage a total product outage would turn a minimal authentication service
 * into a single point of failure for functionality it takes no part in.
 *
 * The grace period extends **authentication only**. Nothing is deleted when
 * it lapses; the user is asked to sign in again, and their accounts, keys,
 * brain, workflows, tasks and audit history are exactly where they left them.
 */
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The half of a session that survives a browser restart. */
export interface StoredSession {
  readonly abaUserId: string;
  readonly refreshToken: string;
  readonly refreshExpiresAt: number;
  /** When the backend was last reached. Drives the grace window. */
  readonly lastContactAt: number;
}

/** The half that does not: memory-backed, gone when the browser closes. */
export interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

export type SessionState =
  | { readonly kind: 'none' }
  | { readonly kind: 'active'; readonly abaUserId: string; readonly expiresAt: number }
  | { readonly kind: 'refresh_due'; readonly abaUserId: string }
  | {
      readonly kind: 'offline_grace';
      readonly abaUserId: string;
      readonly graceEndsAt: number;
    }
  | {
      readonly kind: 'expired';
      readonly abaUserId: string;
      readonly reason: 'refresh_expired' | 'grace_lapsed';
    };

export function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<StoredSession>;
  return (
    typeof record.abaUserId === 'string' &&
    record.abaUserId.length > 0 &&
    typeof record.refreshToken === 'string' &&
    record.refreshToken.length > 0 &&
    typeof record.refreshExpiresAt === 'number' &&
    typeof record.lastContactAt === 'number'
  );
}

/**
 * What state a session is in, as a pure function of what is stored.
 *
 * Separated from storage so every branch can be exercised exhaustively
 * without a storage area, and so that the answer never depends on the order
 * in which two reads happened to resolve.
 *
 * `reachable` is what the caller last observed about the backend, not a live
 * probe: this function performs no I/O and makes no network decision.
 */
export function evaluateSession(
  session: StoredSession | null,
  access: AccessToken | null,
  now: number,
  reachable: boolean,
): SessionState {
  if (session === null) return { kind: 'none' };

  if (now >= session.refreshExpiresAt) {
    return { kind: 'expired', abaUserId: session.abaUserId, reason: 'refresh_expired' };
  }

  if (access !== null && now < access.expiresAt) {
    return { kind: 'active', abaUserId: session.abaUserId, expiresAt: access.expiresAt };
  }

  // The access token is gone or stale. Whether that is a one-line refresh or
  // a sign-in prompt depends entirely on whether the backend can be reached.
  if (reachable) return { kind: 'refresh_due', abaUserId: session.abaUserId };

  const graceEndsAt = session.lastContactAt + OFFLINE_GRACE_MS;
  if (now < graceEndsAt) {
    return { kind: 'offline_grace', abaUserId: session.abaUserId, graceEndsAt };
  }
  return { kind: 'expired', abaUserId: session.abaUserId, reason: 'grace_lapsed' };
}

/** Does this state permit acting as the user, without re-authenticating? */
export function isAuthenticated(state: SessionState): boolean {
  return state.kind === 'active' || state.kind === 'offline_grace';
}

export class SessionStore {
  /**
   * @param durable  disk-backed; holds the refresh token across restarts.
   * @param volatile memory-backed; holds the access token, lost on eviction.
   */
  constructor(
    private readonly durable: StorageArea,
    private readonly volatile: StorageArea,
  ) {}

  async read(): Promise<StoredSession | null> {
    const stored = await this.durable.get<StoredSession>(REFRESH_KEY);
    if (stored === undefined) return null;
    if (!isStoredSession(stored)) {
      log.error('The stored session is malformed and was ignored.');
      return null;
    }
    return stored;
  }

  async readAccess(): Promise<AccessToken | null> {
    const stored = await this.volatile.get<AccessToken>(ACCESS_KEY);
    if (
      typeof stored !== 'object' ||
      stored === null ||
      typeof stored.token !== 'string' ||
      typeof stored.expiresAt !== 'number'
    ) {
      return null;
    }
    return stored;
  }

  async write(session: StoredSession): Promise<void> {
    await this.durable.set(REFRESH_KEY, session);
  }

  async writeAccess(access: AccessToken): Promise<void> {
    await this.volatile.set(ACCESS_KEY, access);
  }

  /** Records that the backend answered, which restarts the grace window. */
  async markContact(now: number): Promise<void> {
    const session = await this.read();
    if (session === null) return;
    await this.durable.set(REFRESH_KEY, { ...session, lastContactAt: now });
  }

  async state(now: number, reachable: boolean): Promise<SessionState> {
    return evaluateSession(await this.read(), await this.readAccess(), now, reachable);
  }

  /**
   * Ends the session.
   *
   * What sign-out, revocation and a lapsed grace period all call. It removes
   * this module's two keys. It does not — and structurally cannot — touch
   * connected accounts, provider credentials, the active AI brain, the
   * identity profile, workflows, tasks, evidence or audit history. None of
   * those are reachable from here.
   */
  async clear(): Promise<void> {
    await this.durable.remove(REFRESH_KEY);
    await this.volatile.remove(ACCESS_KEY);
    log.info('The authentication session was cleared. Local user data was not touched.');
  }

  /** Drops only the short-lived half, forcing a refresh on the next call. */
  async clearAccess(): Promise<void> {
    await this.volatile.remove(ACCESS_KEY);
  }
}
