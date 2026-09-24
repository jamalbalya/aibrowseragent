/**
 * The composition root.
 *
 * Wires the services over a `Store` and a `Clock`. It is the only place that
 * knows how the pieces fit, which is what keeps every module below it
 * testable in isolation.
 *
 * **The HTTP transport lives in `http/router.ts`, not here.** The approved
 * architecture keeps controller boundaries separate from domain logic: this
 * file wires services, and the router turns requests into calls on them. No
 * Google verification logic exists in either — it is all in
 * `app/google-auth-service.ts` and `domain/oidc.ts`.
 */
import { MemoryStore } from './db/memory-store';
import { systemClock, type Clock } from './domain/clock';
import { sha256Digest, type TokenDigest } from './app/token';
import { silentLogger, type ServerLogger } from './logging';
import { AccountService } from './app/account-service';
import { IdentityService } from './app/identity-service';
import { SessionService } from './app/session-service';
import { DeviceService } from './app/device-service';
import {
  GoogleAuthService,
  type GoogleAuthConfig,
  type GoogleTokenEndpoint,
} from './app/google-auth-service';
import {
  EmailAuthService,
  OTP_CHALLENGE_CAPACITY,
  MAX_OTP_ATTEMPTS,
} from './app/email-auth-service';
import { MemoryOtpChallengeStore, type OtpChallengeStore } from './app/otp-challenge-store';
import { MemoryRateLimiter } from './app/rate-limiter';
import { unconfiguredDelivery, type EmailDelivery } from './app/email-delivery';
import type { JwksProvider } from './domain/oidc';
import type { Store } from './db/store';

export interface ServerOptions {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly digest?: TokenDigest;
  readonly log?: ServerLogger;
  readonly accessTtlMs?: number;
  readonly refreshTtlMs?: number;
  /**
   * Google sign-in, wired only when a deployment supplies its credentials.
   *
   * Optional because the rest of the backend is complete without it: a build
   * with no Google configuration is a working identity backend that cannot
   * sign anybody in through Google, which is a better failure than one that
   * starts with a placeholder client id.
   */
  readonly google?: {
    readonly config: GoogleAuthConfig;
    readonly jwks: JwksProvider;
    readonly tokens: GoogleTokenEndpoint;
    readonly challengeTtlMs?: number;
    readonly exchangeTtlMs?: number;
  };
  /**
   * Email OTP sign-in, wired only when a deployment supplies a mail transport.
   *
   * Optional for the same reason `google` is, and absent by default: with no
   * way to send a code there is no sign-in to offer, and a deployment that
   * accepted the request and then failed would be worse than one whose routes
   * are simply not there. `unconfiguredDelivery` reports `configured: false`,
   * which is what makes the wiring below skip the service entirely.
   *
   * **No credential lives here or anywhere in this repository.** The adapter
   * is supplied by the deployment.
   */
  readonly email?: {
    readonly delivery: EmailDelivery;
    readonly ttlMs?: number;
    /** Overridden only by tests that assert the cap. */
    readonly challengeCapacity?: number;
    readonly rateLimitCapacity?: number;
    /**
     * The transient challenge store.
     *
     * Injected only so a test can observe it. There is deliberately no
     * durable implementation to inject: see `otp-challenge-store.ts`.
     */
    readonly challenges?: OtpChallengeStore;
  };
}

export interface IdentityBackend {
  readonly store: Store;
  readonly clock: Clock;
  readonly accounts: AccountService;
  readonly identities: IdentityService;
  readonly sessions: SessionService;
  readonly devices: DeviceService;
  /** Present only when Google credentials were supplied. */
  readonly google: GoogleAuthService | null;
  /** Present only when a mail transport was supplied and reports itself configured. */
  readonly email: EmailAuthService | null;
}

export function createIdentityBackend(options: ServerOptions = {}): IdentityBackend {
  const store = options.store ?? new MemoryStore();
  const clock = options.clock ?? systemClock;
  const digest = options.digest ?? sha256Digest;
  const log = options.log ?? silentLogger;

  const accounts = new AccountService({ store, clock, log });
  const identities = new IdentityService({ store, clock, log });
  const sessions = new SessionService({
    store,
    clock,
    digest,
    log,
    ...(options.accessTtlMs === undefined ? {} : { accessTtlMs: options.accessTtlMs }),
    ...(options.refreshTtlMs === undefined ? {} : { refreshTtlMs: options.refreshTtlMs }),
  });
  const devices = new DeviceService({ store, clock, log });

  const google =
    options.google === undefined
      ? null
      : new GoogleAuthService({
          store,
          clock,
          digest,
          log,
          config: options.google.config,
          jwks: options.google.jwks,
          tokens: options.google.tokens,
          accounts,
          identities,
          sessions,
          devices,
          ...(options.google.challengeTtlMs === undefined
            ? {}
            : { challengeTtlMs: options.google.challengeTtlMs }),
          ...(options.google.exchangeTtlMs === undefined
            ? {}
            : { exchangeTtlMs: options.google.exchangeTtlMs }),
        });

  // `configured: false` is the default and is treated as "no email sign-in",
  // so a deployment that wires the option without a real transport gets the
  // same absent routes as one that wires nothing.
  const delivery = options.email?.delivery ?? unconfiguredDelivery;
  const email = !delivery.configured
    ? null
    : new EmailAuthService({
        store,
        clock,
        log,
        delivery,
        challenges:
          options.email?.challenges ??
          new MemoryOtpChallengeStore({
            maxAttempts: MAX_OTP_ATTEMPTS,
            capacity: options.email?.challengeCapacity ?? OTP_CHALLENGE_CAPACITY,
          }),
        limiter: new MemoryRateLimiter({
          clock,
          capacity: options.email?.rateLimitCapacity ?? 50_000,
        }),
        accounts,
        identities,
        sessions,
        devices,
        ...(options.email?.ttlMs === undefined ? {} : { ttlMs: options.email.ttlMs }),
      });

  return { store, clock, accounts, identities, sessions, devices, google, email };
}

export {
  createAuthRouter,
  DEFAULT_PATHS,
  MAX_BODY_BYTES,
  type AuthRouter,
  type AuthRouterOptions,
  type AuthRouterPaths,
} from './http/router';
export {
  createAccessTokenIssuer,
  type AccessTokenClaims,
  type AccessTokenIssuer,
} from './app/access-token';
export { MemoryStore } from './db/memory-store';
export { FixedClock, systemClock, type Clock } from './domain/clock';
export { ConstraintViolation } from './db/store';
export type { AbaUserRow, AuthIdentityRow, DeviceRow, SessionRow, Store } from './db/store';
export { SCHEMA, FORBIDDEN_COLUMN_FRAGMENTS, CURRENT_DIGEST_VERSION, table } from './db/schema';
export type { AccountState, AuthIdentityKind, TableSpec } from './db/schema';
export { renderMigration, MIGRATIONS, MIGRATION_COVERAGE } from './db/sql';
export { normaliseEmail, type VerifiedIdentity } from './app/identity-service';
export { ACCESS_TTL_MS, REFRESH_TTL_MS, type IssuedSession } from './app/session-service';
export { newRefreshToken, sha256Digest, timingSafeEqual, type TokenDigest } from './app/token';
export { isDeviceId, isServerId, newAbaUserId } from './domain/ids';
export {
  GoogleAuthService,
  CHALLENGE_TTL_MS,
  EXCHANGE_TTL_MS,
  MAX_EXCHANGE_ATTEMPTS,
  type GoogleAuthConfig,
  type GoogleAuthStart,
  type GoogleCallbackOutcome,
  type GoogleExchangeOutcome,
  type GoogleTokenEndpoint,
} from './app/google-auth-service';
export {
  verifyGoogleIdToken,
  GOOGLE_ISSUERS,
  CLOCK_SKEW_MS,
  type GoogleIdentityClaims,
  type JsonWebKey1,
  type JwksProvider,
} from './domain/oidc';
export { createCodeChallenge, newCodeVerifier } from './app/pkce';
export {
  EmailAuthService,
  isDeliverableEmail,
  MAX_OTP_ATTEMPTS,
  OTP_CHALLENGE_CAPACITY,
  OTP_LIMITS,
  OTP_TTL_MS,
  type EmailStartOutcome,
  type EmailStartRefusal,
  type EmailVerifyOutcome,
  type EmailVerifyRefusal,
} from './app/email-auth-service';
export {
  MemoryOtpChallengeStore,
  type OtpAttemptOutcome,
  type OtpChallenge,
  type OtpChallengeStore,
  type OtpChallengeView,
  type OtpIssueOutcome,
} from './app/otp-challenge-store';
export { MemoryRateLimiter, type RateLimitOutcome, type RateLimitRule } from './app/rate-limiter';
export {
  otpMessage,
  unconfiguredDelivery,
  type EmailDelivery,
  type EmailMessage,
} from './app/email-delivery';
export { isOtpShape, newOtpCode, otpMatches, OTP_DIGITS, OTP_SPACE } from './app/otp';
export { owns, requireOwned, principalFromSession, type Principal } from './domain/authorization';
export {
  DOMAIN_ERROR_CODES,
  type DomainError,
  type DomainErrorCode,
  type Result,
} from './domain/errors';
export {
  createLogger,
  filterFields,
  silentLogger,
  LOGGABLE_FIELDS,
  RecordingLogSink,
  type LogRecord,
  type ServerLogger,
} from './logging';
export {
  loadConfig,
  describeConfig,
  ConfigError,
  REQUIRED_VARIABLES,
  SECRET_VARIABLES,
  GOOGLE_VARIABLES,
  type ServerConfig,
  type GoogleOAuthConfig,
} from './config';
