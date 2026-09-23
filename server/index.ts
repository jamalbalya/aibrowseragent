/**
 * The composition root.
 *
 * Wires the services over a `Store` and a `Clock`. It is the only place that
 * knows how the pieces fit, which is what keeps every module below it
 * testable in isolation.
 *
 * **There is no HTTP transport here, deliberately.** The approved
 * architecture keeps controller boundaries separate from domain logic, and
 * this phase implements the domain. Adding a web framework now would ship a
 * routing layer with no endpoint behind it and no test that could exercise
 * one end to end.
 */
import { MemoryStore } from './db/memory-store';
import { systemClock, type Clock } from './domain/clock';
import { sha256Digest, type TokenDigest } from './app/token';
import { silentLogger, type ServerLogger } from './logging';
import { AccountService } from './app/account-service';
import { IdentityService } from './app/identity-service';
import { SessionService } from './app/session-service';
import { DeviceService } from './app/device-service';
import type { Store } from './db/store';

export interface ServerOptions {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly digest?: TokenDigest;
  readonly log?: ServerLogger;
  readonly accessTtlMs?: number;
  readonly refreshTtlMs?: number;
}

export interface IdentityBackend {
  readonly store: Store;
  readonly clock: Clock;
  readonly accounts: AccountService;
  readonly identities: IdentityService;
  readonly sessions: SessionService;
  readonly devices: DeviceService;
}

export function createIdentityBackend(options: ServerOptions = {}): IdentityBackend {
  const store = options.store ?? new MemoryStore();
  const clock = options.clock ?? systemClock;
  const digest = options.digest ?? sha256Digest;
  const log = options.log ?? silentLogger;

  return {
    store,
    clock,
    accounts: new AccountService({ store, clock, log }),
    identities: new IdentityService({ store, clock, log }),
    sessions: new SessionService({
      store,
      clock,
      digest,
      log,
      ...(options.accessTtlMs === undefined ? {} : { accessTtlMs: options.accessTtlMs }),
      ...(options.refreshTtlMs === undefined ? {} : { refreshTtlMs: options.refreshTtlMs }),
    }),
    devices: new DeviceService({ store, clock, log }),
  };
}

export { MemoryStore } from './db/memory-store';
export { FixedClock, systemClock, type Clock } from './domain/clock';
export { ConstraintViolation } from './db/store';
export type { AbaUserRow, AuthIdentityRow, DeviceRow, SessionRow, Store } from './db/store';
export { SCHEMA, FORBIDDEN_COLUMN_FRAGMENTS, table } from './db/schema';
export type { AccountState, AuthIdentityKind, TableSpec } from './db/schema';
export { renderMigration, MIGRATIONS } from './db/sql';
export { normaliseEmail, type VerifiedIdentity } from './app/identity-service';
export { ACCESS_TTL_MS, REFRESH_TTL_MS, type IssuedSession } from './app/session-service';
export { newRefreshToken, sha256Digest, timingSafeEqual, type TokenDigest } from './app/token';
export { isDeviceId, isServerId, newAbaUserId } from './domain/ids';
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
  type ServerConfig,
} from './config';
