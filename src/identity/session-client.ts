/**
 * Refresh and logout, over the backend the extension already talks to.
 *
 * Deliberately separate from `GoogleSignIn`: neither of these is a Google
 * operation. They act on an AI Browser Agent session that exists, whatever
 * produced it, and putting them beside the Google flow would tie a session's
 * life to the one method that happened to start it — which is the coupling
 * email sign-in would immediately have to undo.
 *
 * ## Single flight, and why it is not optional
 *
 * A refresh token is single-use, and the server now enforces that atomically:
 * two concurrent presentations produce at most one successor, and the loser
 * is treated as reuse, which revokes the whole family. That is correct, and
 * it means a client that fires two refreshes at once **signs the user out**.
 *
 * An MV3 extension is exactly the place that happens. The side panel, a
 * running task and a scheduled check can all notice a stale access token in
 * the same millisecond, and each would reach for the same stored token. So
 * the concurrency has to be collapsed here, before the request: one in-flight
 * refresh, and every other caller awaits its result.
 *
 * The mutex is per worker instance, which is the right scope because the
 * stored token is per profile and the worker is the only thing that touches
 * it. It is not a distributed lock and does not pretend to be — the server's
 * atomic claim is what makes the design safe, and this only stops the client
 * from attacking itself.
 */
import { getLogger } from '@/logging/logger';
import { IDENTITY_PATHS } from './identity-config';
import type { IdentityTransport } from './identity-transport';
import type { SessionStore, StoredSession } from './session-store';

const log = getLogger('security');

/**
 * Why a refresh did not produce a session.
 *
 * `REVOKED` is the one that matters: it means the server refused the token —
 * expired, already rotated, revoked, or an account that no longer exists —
 * and the local session is therefore dead. Every other failure is an outage,
 * and an outage must not sign anybody out.
 */
export type RefreshFailure = 'NO_SESSION' | 'REVOKED' | 'UNREACHABLE';

export type RefreshResult =
  | { readonly ok: true; readonly abaUserId: string; readonly accessExpiresAt: number }
  | { readonly ok: false; readonly failure: RefreshFailure };

export interface SessionClientOptions {
  readonly transport: IdentityTransport;
  readonly sessions: SessionStore;
  readonly now?: () => number;
}

function readString(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(body: unknown, field: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class SessionClient {
  private readonly now: () => number;
  /** The one refresh in flight, if any. Collapsed concurrency, not a queue. */
  private inFlight: Promise<RefreshResult> | null = null;

  constructor(private readonly options: SessionClientOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Rotates the stored refresh token, at most once at a time.
   *
   * Every concurrent caller receives the same result, because they await the
   * same promise. The promise is cleared when it settles, so a later refresh
   * starts a new one rather than returning a stale answer.
   */
  refresh(): Promise<RefreshResult> {
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRefresh(): Promise<RefreshResult> {
    const stored = await this.options.sessions.read();
    if (stored === null) return { ok: false, failure: 'NO_SESSION' };

    let response: { status: number; body: unknown };
    try {
      response = await this.options.transport.send({
        path: IDENTITY_PATHS.refresh,
        // The refresh token is the credential. Nothing else is sent — no
        // account id, no device id, no email — because nothing else could be
        // authority and offering it would invite the server to read it.
        body: { refreshToken: stored.refreshToken },
      });
    } catch {
      // The backend could not be reached. The session is not dead; it is
      // unreachable, and the offline grace exists for exactly this.
      return { ok: false, failure: 'UNREACHABLE' };
    }

    if (response.status !== 200) {
      // A 401 is the server saying this token will never work again. Anything
      // else is an outage, and an outage must not clear a valid session.
      if (response.status === 401) {
        log.warn('The account service refused the stored session; signing out locally.');
        await this.clearSession();
        return { ok: false, failure: 'REVOKED' };
      }
      return { ok: false, failure: 'UNREACHABLE' };
    }

    const abaUserId = readString(response.body, 'abaUserId');
    const accessToken = readString(response.body, 'accessToken');
    const refreshToken = readString(response.body, 'refreshToken');
    const accessExpiresAt = readNumber(response.body, 'accessExpiresAt');
    const refreshExpiresAt = readNumber(response.body, 'refreshExpiresAt');
    if (
      abaUserId === null ||
      accessToken === null ||
      refreshToken === null ||
      accessExpiresAt === null ||
      refreshExpiresAt === null
    ) {
      return { ok: false, failure: 'UNREACHABLE' };
    }

    // The account must not change under a refresh. A response naming someone
    // else is not a session this installation asked for, and adopting it
    // would silently move the user to another account.
    if (abaUserId !== stored.abaUserId) {
      log.error('A session refresh named a different account and was discarded.');
      return { ok: false, failure: 'REVOKED' };
    }

    // Re-read before writing, and only write if the session we started from
    // is still the one stored.
    //
    // A logout can land while this request is in flight. Writing the
    // successor then would resurrect a session the server has just revoked:
    // the extension would look signed in holding a dead token, and the next
    // refresh would present it and trip reuse detection. So this is a
    // compare-and-set on the client, mirroring the server's claim — if the
    // predecessor is gone, so is the reason to store its successor.
    //
    // The successor is then orphaned on the server, which is safe: nobody
    // holds it, it revokes nothing, and it lapses on its own. The user asked
    // to be signed out and is.
    const current = await this.options.sessions.read();
    if (current === null || current.refreshToken !== stored.refreshToken) {
      log.info('A refresh completed after the session changed; its result was discarded.');
      return { ok: false, failure: 'NO_SESSION' };
    }

    // The successor replaces the predecessor before the access token is
    // written, so an interruption between the two leaves the *new* refresh
    // token stored — the old one is spent and would refresh into a reuse
    // signal, which is the one outcome worth avoiding.
    const next: StoredSession = {
      abaUserId,
      refreshToken,
      refreshExpiresAt,
      lastContactAt: this.now(),
    };
    await this.options.sessions.write(next);
    await this.options.sessions.writeAccess({ token: accessToken, expiresAt: accessExpiresAt });

    return { ok: true, abaUserId, accessExpiresAt };
  }

  /**
   * Ends the session on the server as well as here.
   *
   * The access token is the credential, because logout is an operation on the
   * session that token was minted for and the server reads the session id out
   * of it — the client cannot name a session, its own or anybody else's.
   *
   * **The local clear happens whichever way the server answers.** A user who
   * pressed sign out is signed out: a backend that is unreachable, or that
   * refuses a token already expired, must not leave them looking signed in.
   * The server session then lapses on its own, and the refresh token that
   * could have extended it has been discarded here.
   */
  async logout(): Promise<{ readonly serverRevoked: boolean }> {
    const access = await this.options.sessions.readAccess();

    let serverRevoked = false;
    if (access !== null) {
      try {
        const response = await this.options.transport.send({
          path: IDENTITY_PATHS.logout,
          body: {},
          bearer: access.token,
        });
        serverRevoked = response.status === 200;
      } catch {
        // Unreachable. The local clear below still happens.
        serverRevoked = false;
      }
    }

    await this.clearSession();
    return { serverRevoked };
  }

  /**
   * Clears the session, and only the session.
   *
   * Two keys. The identity profile stays, so the sign-in screen can say who
   * you were; every task, workflow, shortcut, workspace, provider connection,
   * provider credential and storage preference is untouched (AUTH-9). Logout
   * is not deletion of anything.
   */
  private async clearSession(): Promise<void> {
    await this.options.sessions.clear();
  }
}
