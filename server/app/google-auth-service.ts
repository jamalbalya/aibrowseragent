/**
 * Google sign-in: start, callback, exchange.
 *
 * The three steps of the approved flow (§7.1), and the reason there are three
 * rather than two is the one property the whole design rests on: **no bearer
 * token ever travels through a URL.** The redirect lands on the backend and
 * carries a one-time exchange code; the extension trades that code for tokens
 * over a request it made itself.
 *
 * Everything secret lives on the `login_challenge` row, server-side. The
 * client is given a challenge id and an authorization URL, and neither is
 * usable without the row.
 *
 * **What this module refuses to trust.** Nothing the client sends about the
 * user's identity is read: not an email, not a subject, not a display name,
 * not an `abaUserId`. The identity comes from an ID token this server
 * verified against Google's published keys (`domain/oidc.ts`), and from
 * nowhere else. There is no parameter in which a caller could offer one.
 *
 * **Out of scope, deliberately.** No provider is contacted, no provider
 * connection is created, no credential is touched, and no K1 material is
 * generated, derived or read. Authentication establishes an ABA identity and
 * a session; it establishes nothing else.
 */
import { fail, ok, type Result } from '../domain/errors';
import { verifyGoogleIdToken, type JwksProvider } from '../domain/oidc';
import { newChallengeId, newExchangeCode, newNonce, newState } from '../domain/ids';
import { createCodeChallenge, newCodeVerifier } from './pkce';
import type { TokenDigest } from './token';
import type { Clock } from '../domain/clock';
import type { LoginChallengeRow, Store } from '../db/store';
import type { AccountService } from './account-service';
import type { IdentityService } from './identity-service';
import type { IssuedSession, SessionService } from './session-service';
import type { ServerLogger } from '../logging';

/** How long a sign-in may sit half-finished. Short: it is an open door. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** How long the exchange code is good for once the callback mints it. */
export const EXCHANGE_TTL_MS = 2 * 60 * 1000;

/** Exchange attempts before the challenge dies. */
export const MAX_EXCHANGE_ATTEMPTS = 3;

/**
 * Redeems an authorization code with Google.
 *
 * A port, because it is the one part of this flow that makes a network call,
 * and because the client secret it uses belongs to a deployment rather than
 * to this module. A test supplies a stub; production supplies an adapter that
 * posts to Google's token endpoint over TLS.
 */
export interface GoogleTokenEndpoint {
  redeem(request: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<{ readonly idToken: string } | null>;
}

export interface GoogleAuthConfig {
  /** This application's Google client id. Compared against the token's `aud`. */
  readonly clientId: string;
  /** Registered with Google, on the backend's own https origin (§7.3). */
  readonly redirectUri: string;
  readonly authorizationEndpoint: string;
}

export interface GoogleAuthServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly digest: TokenDigest;
  readonly log: ServerLogger;
  readonly config: GoogleAuthConfig;
  readonly jwks: JwksProvider;
  readonly tokens: GoogleTokenEndpoint;
  readonly accounts: AccountService;
  readonly identities: IdentityService;
  readonly sessions: SessionService;
  readonly challengeTtlMs?: number;
  readonly exchangeTtlMs?: number;
}

/** What the extension receives from `start`. Carries no secret. */
export interface GoogleAuthStart {
  readonly challengeId: string;
  readonly authorizationUrl: string;
}

/** What the callback produces. The code goes in a URL; nothing else does. */
export interface GoogleCallbackOutcome {
  readonly challengeId: string;
  readonly exchangeCode: string;
}

/** What the exchange produces. Tokens, over a request the client made. */
export interface GoogleExchangeOutcome {
  readonly session: IssuedSession;
  /** True when this sign-in created the account rather than returning to one. */
  readonly created: boolean;
}

export class GoogleAuthService {
  private readonly challengeTtl: number;
  private readonly exchangeTtl: number;

  constructor(private readonly options: GoogleAuthServiceOptions) {
    this.challengeTtl = options.challengeTtlMs ?? CHALLENGE_TTL_MS;
    this.exchangeTtl = options.exchangeTtlMs ?? EXCHANGE_TTL_MS;
  }

  /**
   * Begins a sign-in.
   *
   * Mints `state`, `nonce` and the PKCE verifier, and keeps **all three** on
   * the row. The client receives the challenge id and a URL; the verifier
   * never leaves this server, which is what makes a stolen authorization code
   * useless to whoever stole it.
   */
  async start(): Promise<Result<GoogleAuthStart>> {
    const now = this.options.clock.now();
    const verifier = newCodeVerifier();
    const state = newState();
    const nonce = newNonce();

    const row: LoginChallengeRow = {
      id: newChallengeId(),
      method: 'google',
      purpose: 'sign_in',
      aba_user_id: null,
      state,
      nonce,
      pkce_verifier: verifier,
      redirect_uri: this.options.config.redirectUri,
      exchange_digest: null,
      resolved_aba_user_id: null,
      resolved_auth_identity_id: null,
      attempts: 0,
      created_at: now,
      expires_at: now + this.challengeTtl,
      consumed_at: null,
    };
    await this.options.store.insertChallenge(row);

    const url = new URL(this.options.config.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.options.config.clientId);
    url.searchParams.set('redirect_uri', this.options.config.redirectUri);
    url.searchParams.set('scope', 'openid email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', await createCodeChallenge(verifier));
    url.searchParams.set('code_challenge_method', 'S256');

    this.options.log.info('auth.google.start', { challengeId: row.id });
    return ok({ challengeId: row.id, authorizationUrl: url.toString() });
  }

  /**
   * Handles Google's redirect.
   *
   * The ordering is the security, and it is the ordering §7.4 specifies:
   * the challenge is **consumed before any further work**, so a replayed
   * callback finds a spent row and stops — before a code is redeemed, before
   * a token is verified, and before an account is touched.
   */
  async handleCallback(params: {
    readonly state: string | null;
    readonly code: string | null;
    readonly error: string | null;
  }): Promise<Result<GoogleCallbackOutcome>> {
    const now = this.options.clock.now();

    // Every one of these produces the same failure, because distinguishing
    // them tells an attacker which half of the callback to forge next.
    if (params.error !== null) return this.refuse('callback_error');
    if (params.state === null || params.code === null) return this.refuse('callback_incomplete');

    const challenge = await this.options.store.findChallengeByState(params.state);
    if (challenge === null) return this.refuse('state_unknown');
    if (challenge.method !== 'google') return this.refuse('state_wrong_method');
    if (challenge.expires_at <= now) return this.refuse('challenge_expired');

    // The consume is the race winner, not a check followed by a write. Two
    // callbacks for one state: exactly one proceeds.
    const claimed = await this.options.store.consumeChallenge(challenge.id, now);
    if (!claimed) return this.refuse('state_replayed');

    if (
      challenge.pkce_verifier === null ||
      challenge.nonce === null ||
      challenge.redirect_uri === null
    ) {
      return this.refuse('challenge_incomplete');
    }

    const redeemed = await this.options.tokens.redeem({
      code: params.code,
      codeVerifier: challenge.pkce_verifier,
      // The value this flow started with, not one taken from the request.
      redirectUri: challenge.redirect_uri,
    });
    if (redeemed === null) return this.refuse('code_rejected');

    const verified = await verifyGoogleIdToken({
      idToken: redeemed.idToken,
      audience: this.options.config.clientId,
      expectedNonce: challenge.nonce,
      now,
      jwks: this.options.jwks,
    });
    if (!verified.ok) return this.refuse('id_token_invalid');

    const resolution = await this.resolveAccount(verified.value.subject, {
      email: verified.value.email,
      emailVerified: verified.value.emailVerified,
    });
    if (!resolution.ok) {
      // An identity owned by another account reaches here. The refusal says
      // so without saying whose, and the challenge is already spent.
      this.options.log.warn('auth.google.callback.refused', {
        challengeId: challenge.id,
        reason: 'identity_unavailable',
      });
      return fail(resolution.error.code);
    }

    const exchangeCode = newExchangeCode();
    await this.options.store.attachChallengeOutcome(challenge.id, {
      exchangeDigest: await this.options.digest.compute(exchangeCode),
      abaUserId: resolution.value.abaUserId,
      authIdentityId: resolution.value.authIdentityId,
    });

    this.options.log.info('auth.google.callback', {
      challengeId: challenge.id,
      abaUserId: resolution.value.abaUserId,
    });
    return ok({ challengeId: challenge.id, exchangeCode });
  }

  /**
   * Trades the one-time code for a session.
   *
   * Both halves are required: the `challengeId` the client has held since
   * `start`, and the `exchangeCode` that came back through the redirect.
   * Neither alone completes a sign-in, so a stolen redirect URL is not a
   * sign-in and neither is a stolen challenge id.
   */
  async exchange(params: {
    readonly challengeId: string;
    readonly exchangeCode: string;
  }): Promise<Result<GoogleExchangeOutcome>> {
    const now = this.options.clock.now();

    const digest = await this.options.digest.compute(params.exchangeCode);
    const byDigest = await this.options.store.findChallengeByExchangeDigest(digest);
    // The code must name the same challenge the client started. A code that
    // resolves to a different row is a cross-flow attempt.
    if (byDigest === null || byDigest.id !== params.challengeId) {
      await this.countAttempt(params.challengeId);
      return this.refuse('exchange_unknown');
    }
    if (byDigest.expires_at <= now) return this.refuse('exchange_expired');
    if (byDigest.consumed_at !== null && byDigest.consumed_at + this.exchangeTtl <= now) {
      return this.refuse('exchange_expired');
    }

    const attempts = await this.options.store.countChallengeAttempt(byDigest.id);
    if (attempts > MAX_EXCHANGE_ATTEMPTS) {
      await this.options.store.deleteChallenge(byDigest.id);
      return this.refuse('exchange_attempts');
    }

    if (byDigest.resolved_aba_user_id === null || byDigest.resolved_auth_identity_id === null) {
      return this.refuse('exchange_unresolved');
    }

    const issued = await this.options.sessions.createSession({
      abaUserId: byDigest.resolved_aba_user_id,
      authIdentityId: byDigest.resolved_auth_identity_id,
    });
    if (!issued.ok) {
      // A deleted account reaches here, and must reach it as a definitive
      // refusal rather than as anything a client could treat as an outage.
      await this.options.store.deleteChallenge(byDigest.id);
      return fail(issued.error.code);
    }

    // Single use: the row goes, so the same code cannot be presented twice.
    await this.options.store.deleteChallenge(byDigest.id);

    const identity = await this.options.store.getIdentity(byDigest.resolved_auth_identity_id);
    const created = identity !== null && identity.last_used_at === null;
    if (identity !== null) await this.options.store.touchIdentity(identity.id, now);

    this.options.log.info('auth.google.exchange', {
      challengeId: byDigest.id,
      abaUserId: issued.value.abaUserId,
      sessionId: issued.value.sessionId,
    });
    return ok({ session: issued.value, created });
  }

  /** Removes challenges past their life. Credential material does not linger. */
  async sweep(): Promise<number> {
    return this.options.store.purgeExpiredChallenges(this.options.clock.now());
  }

  /**
   * Finds or creates the ABA account for a verified Google subject.
   *
   * Subject first and subject only — the email is carried for display and is
   * never a stronger key than the subject (§4.3). An address already used as
   * an **email** identity on another account does not match here, and must
   * not: merging would take a decision no server may take, so this returns
   * the safe `IDENTITY_IN_USE` outcome, which names no account (§20.4.1).
   */
  private async resolveAccount(
    subject: string,
    profile: { readonly email: string | null; readonly emailVerified: boolean },
  ): Promise<Result<{ readonly abaUserId: string; readonly authIdentityId: string }>> {
    const existing = await this.options.store.findIdentityBySubject('google', subject);
    if (existing !== null) {
      const account = await this.options.store.getUser(existing.aba_user_id);
      if (account === null) return fail('NOT_FOUND');
      // A deleted account cannot authenticate, and this is an answer rather
      // than a silence: it must never be read as an outage (AUTH-14).
      if (account.state === 'deleted') return fail('ACCOUNT_DELETED');
      return ok({ abaUserId: account.id, authIdentityId: existing.id });
    }

    const account = await this.options.accounts.createAccount();
    const session = await this.options.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!session.ok) return fail(session.error.code);
    const principal = await this.options.sessions.verify(session.value.sessionId);
    if (!principal.ok) return fail(principal.error.code);

    const attached = await this.options.identities.attachIdentity(principal.value, {
      kind: 'google',
      subject,
      // Only a verified address is carried. An unverified one would be a
      // claim, and a claim is never written as an identity (AUTH-18).
      email: profile.emailVerified ? profile.email : null,
      emailVerified: profile.emailVerified,
    });

    // The bootstrap session existed only to obtain a principal for the
    // attach. It is revoked whatever happened next, so no session survives
    // that the user did not complete a sign-in for.
    await this.options.store.revokeSession(
      principal.value.sessionId,
      this.options.clock.now(),
      'bootstrap',
    );

    if (!attached.ok) return fail(attached.error.code);
    return ok({ abaUserId: account.id, authIdentityId: attached.value.id });
  }

  private async countAttempt(challengeId: string): Promise<void> {
    const row = await this.options.store.getChallenge(challengeId);
    if (row !== null) await this.options.store.countChallengeAttempt(challengeId);
  }

  /**
   * One refusal shape for every callback and exchange failure.
   *
   * The reason is logged — it is an operational fact — and never returned,
   * because the difference between "unknown state" and "already used" is
   * exactly what an attacker probing the callback wants to learn.
   */
  private refuse<T>(reason: string): Result<T> {
    this.options.log.warn('auth.google.refused', { reason });
    return fail('INVALID_ARGUMENT');
  }
}
