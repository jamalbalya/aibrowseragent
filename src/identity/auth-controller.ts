/**
 * What the side panel's three authentication routes actually do.
 *
 * A thin coordinator over pieces that already exist: `GoogleSignIn` drives
 * the browser, `SessionStore` holds the tokens, `IdentityProfileStore` holds
 * the durable identity. It exists so the service worker's route handlers stay
 * three lines each, and so the ordering below is in one place rather than
 * spread across them.
 *
 * **The ordering is the design.** On a successful sign-in the profile is
 * written *before* the session, because `recordSignIn` is the step that can
 * refuse: signing in as a different user on an installation that already
 * holds one is `DIFFERENT_USER`, and refusing after a session was stored
 * would leave a session for a user this installation does not recognise.
 *
 * **What this never does.** It does not create a provider connection, touch a
 * provider credential, generate or derive any K1 material, or upload
 * anything. Authentication establishes an ABA identity and a session; the
 * rest of the extension is untouched by it, which is why sign-out below
 * clears two keys and nothing else.
 */
import { getLogger } from '@/logging/logger';
import { evaluateSession, type SessionStore } from './session-store';
import type { IdentityProfileStore } from './identity-profile';
import type { GoogleSignIn } from './google-sign-in';
import type { RefreshResult, SessionClient } from './session-client';

const log = getLogger('security');

export interface AuthStatus {
  readonly configured: boolean;
  readonly state: 'signed_out' | 'signed_in';
  readonly abaUserId: string | null;
  readonly email: string | null;
}

export interface AuthControllerOptions {
  readonly sessions: SessionStore;
  readonly profile: IdentityProfileStore;
  /** Null when no backend origin is configured — sign-in is then unavailable. */
  readonly google: GoogleSignIn | null;
  /**
   * Refresh and logout against the backend. Null for the same reason
   * `google` is: with no configured origin there is nothing to talk to, and
   * sign-out is then the local clear it has always been.
   */
  readonly session: SessionClient | null;
  readonly now?: () => number;
}

export class AuthController {
  private readonly now: () => number;

  constructor(private readonly options: AuthControllerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * What the panel renders.
   *
   * Carries no token, and cannot: the only fields are an id and an address,
   * both of which the panel already needs in order to say who is signed in.
   */
  async status(): Promise<AuthStatus> {
    const profile = await this.options.profile.get();
    const stored = await this.options.sessions.read();
    const access = await this.options.sessions.readAccess();
    // `reachable: true` because this is a local question about stored state,
    // not a probe. A backend outage is a separate concern with its own grace.
    const state = evaluateSession(stored, access, this.now(), true);

    return {
      configured: this.options.google !== null,
      state: state.kind === 'none' || state.kind === 'expired' ? 'signed_out' : 'signed_in',
      abaUserId: profile?.abaUserId ?? null,
      email: profile?.email ?? null,
    };
  }

  /**
   * Runs a Google sign-in and stores what comes back.
   *
   * Returns a safe failure code. None of them says whether an account exists,
   * because a sign-in that reported "no such account" would be an enumeration
   * oracle for anybody who could press the button.
   */
  async signInWithGoogle(signal: AbortSignal): Promise<{
    ok: boolean;
    abaUserId: string | null;
    email: string | null;
    failure: string | null;
  }> {
    if (this.options.google === null) {
      return { ok: false, abaUserId: null, email: null, failure: 'NOT_CONFIGURED' };
    }

    const result = await this.options.google.signIn(signal);
    if (!result.ok) return { ok: false, abaUserId: null, email: null, failure: result.failure };

    // The profile first: this is the step that can refuse.
    const recorded = await this.options.profile.recordSignIn({
      abaUserId: result.abaUserId,
      email: result.email,
      emailVerified: result.email !== null,
      method: 'google',
      now: this.now(),
    });
    if (!recorded.ok) {
      log.warn('A sign-in was refused by the local identity profile.', {
        reason: recorded.refusal,
      });
      return { ok: false, abaUserId: null, email: null, failure: recorded.refusal };
    }

    await this.options.sessions.write({
      abaUserId: result.abaUserId,
      refreshToken: result.refreshToken,
      refreshExpiresAt: result.refreshExpiresAt,
      lastContactAt: this.now(),
    });
    await this.options.sessions.writeAccess({
      token: result.accessToken,
      expiresAt: result.accessExpiresAt,
    });

    return {
      ok: true,
      abaUserId: recorded.profile.abaUserId,
      email: recorded.profile.email,
      failure: null,
    };
  }

  /**
   * Renews the access token, or reports that the session is gone.
   *
   * Single-flight lives in `SessionClient`, not here: collapsing concurrent
   * callers is a property of the token being single-use, and belongs beside
   * the request rather than beside the routes.
   */
  async refresh(): Promise<RefreshResult> {
    if (this.options.session === null) return { ok: false, failure: 'UNREACHABLE' };
    return this.options.session.refresh();
  }

  /**
   * Ends the session, on the server as well as here.
   *
   * Clears the two session keys and nothing else. The identity profile stays,
   * so the sign-in screen can offer "sign back in as …" rather than showing a
   * returning user a blank form, and every connected account, credential,
   * task, workflow and workspace is untouched (AUTH-9).
   *
   * With no backend configured this is the local clear it has always been,
   * which is the whole of sign-out for a build that never had a session on a
   * server to begin with.
   */
  async signOut(): Promise<{ ok: boolean }> {
    if (this.options.session === null) {
      await this.options.sessions.clear();
      return { ok: true };
    }
    // `logout` clears locally whichever way the server answers, so a user who
    // pressed sign out is signed out even when the backend is unreachable.
    await this.options.session.logout();
    return { ok: true };
  }
}
