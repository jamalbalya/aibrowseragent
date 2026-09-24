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
import type {
  EmailSignIn,
  EmailStartFailure,
  EmailStartResult,
  EmailVerifyFailure,
} from './email-sign-in';
import type { RefreshResult, SessionClient } from './session-client';

const log = getLogger('security');

export interface AuthStatus {
  readonly configured: boolean;
  readonly state: 'signed_out' | 'signed_in';
  readonly abaUserId: string | null;
  readonly email: string | null;
}

/** What the panel gets back from asking for a code. Carries no code. */
export interface EmailStartStatus {
  readonly ok: boolean;
  /** Opaque, and useless without the code that was mailed. */
  readonly challengeId: string | null;
  readonly expiresAt: number | null;
  readonly resendAvailableAt: number | null;
  readonly failure: EmailStartFailure | null;
  readonly retryAfterMs: number | null;
}

/** What the panel gets back from presenting one. */
export interface EmailVerifyStatus {
  readonly ok: boolean;
  readonly abaUserId: string | null;
  readonly email: string | null;
  readonly failure: EmailVerifyFailure | 'DIFFERENT_USER' | null;
  readonly remainingAttempts: number | null;
  readonly retryAfterMs: number | null;
}

export interface AuthControllerOptions {
  readonly sessions: SessionStore;
  readonly profile: IdentityProfileStore;
  /** Null when no backend origin is configured — sign-in is then unavailable. */
  readonly google: GoogleSignIn | null;
  /**
   * Email sign-in. Null for the same reason `google` is.
   *
   * Whether the *deployment* offers it is a separate question the client
   * cannot answer locally: a configured origin whose backend has no mail
   * transport answers 404, which surfaces as `NOT_CONFIGURED` from the first
   * request rather than as a guess made here.
   */
  readonly email: EmailSignIn | null;
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
   * Asks the backend to mail a one-time code.
   *
   * Passes the address straight through. **No code is returned, and there is
   * no field on `EmailStartStatus` that one could travel in** — the panel
   * receives a challenge id and two timestamps, which is exactly what it
   * needs to render a countdown and a resend button.
   */
  async startEmailSignIn(email: string): Promise<EmailStartStatus> {
    if (this.options.email === null) {
      return {
        ok: false,
        challengeId: null,
        expiresAt: null,
        resendAvailableAt: null,
        failure: 'NOT_CONFIGURED',
        retryAfterMs: null,
      };
    }
    return describeStart(await this.options.email.start(email));
  }

  /**
   * Presents a code, and on success stores the session.
   *
   * The same ordering as `signInWithGoogle`, and for the same reason: the
   * profile is written first because it is the step that can refuse, and
   * storing a session for a user this installation does not recognise would
   * be the one state nothing can recover from.
   *
   * **The code is not stored, anywhere.** It is an argument, it becomes a
   * request body inside `EmailSignIn`, and this method keeps no reference to
   * it after the call returns.
   */
  async verifyEmailSignIn(challengeId: string, code: string): Promise<EmailVerifyStatus> {
    if (this.options.email === null) {
      return {
        ok: false,
        abaUserId: null,
        email: null,
        failure: 'NOT_CONFIGURED',
        remainingAttempts: null,
        retryAfterMs: null,
      };
    }

    const result = await this.options.email.verify(challengeId, code);
    if (!result.ok) {
      return {
        ok: false,
        abaUserId: null,
        email: null,
        failure: result.failure,
        remainingAttempts: result.remainingAttempts,
        retryAfterMs: result.retryAfterMs,
      };
    }

    const recorded = await this.options.profile.recordSignIn({
      abaUserId: result.abaUserId,
      email: result.email,
      // The code proved control of the mailbox, which is what the server
      // attested by issuing a session at all.
      emailVerified: result.email !== null,
      method: 'email',
      now: this.now(),
    });
    if (!recorded.ok) {
      log.warn('A sign-in was refused by the local identity profile.', {
        reason: recorded.refusal,
      });
      return {
        ok: false,
        abaUserId: null,
        email: null,
        failure: recorded.refusal,
        remainingAttempts: null,
        retryAfterMs: null,
      };
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
      remainingAttempts: null,
      retryAfterMs: null,
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

function describeStart(result: EmailStartResult): EmailStartStatus {
  return result.ok
    ? {
        ok: true,
        challengeId: result.challengeId,
        expiresAt: result.expiresAt,
        resendAvailableAt: result.resendAvailableAt,
        failure: null,
        retryAfterMs: null,
      }
    : {
        ok: false,
        challengeId: null,
        expiresAt: null,
        resendAvailableAt: null,
        failure: result.failure,
        retryAfterMs: result.retryAfterMs,
      };
}
