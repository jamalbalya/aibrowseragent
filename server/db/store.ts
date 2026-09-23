/**
 * The persistence port.
 *
 * The domain and the services depend on this interface and on nothing else, so
 * the choice of database is a deployment decision rather than an architectural
 * one. What the port does **not** offer is as deliberate as what it does:
 *
 *  - there is no `update` that takes an arbitrary row, so a write-once column
 *    cannot be changed by handing in a whole object with one field altered;
 *  - there is no query that omits an owner, so a lookup cannot accidentally
 *    span accounts;
 *  - there is no escape hatch that takes raw SQL.
 *
 * The in-memory adapter enforces every constraint the schema declares, so a
 * test written against it exercises the real rules (`memory-store.ts`).
 */
import type { AccountState, AuthIdentityKind } from './schema';

export interface AbaUserRow {
  readonly id: string;
  readonly created_at: number;
  readonly state: AccountState;
  readonly deleted_at: number | null;
}

export interface AuthIdentityRow {
  readonly id: string;
  readonly aba_user_id: string;
  readonly kind: AuthIdentityKind;
  readonly subject: string | null;
  readonly email: string | null;
  readonly email_verified: boolean;
  readonly linked_at: number;
  readonly linked_via: string | null;
  readonly last_used_at: number | null;
}

export interface SessionRow {
  readonly id: string;
  readonly aba_user_id: string;
  readonly auth_identity_id: string | null;
  readonly family_id: string;
  readonly refresh_digest: string;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly rotated_at: number | null;
  readonly revoked_at: number | null;
  readonly revoked_reason: string | null;
  readonly last_seen_at: number;
}

export interface DeviceRow {
  readonly aba_user_id: string;
  readonly device_id: string;
  readonly registered_at: number;
  readonly last_seen_at: number;
  readonly retired_at: number | null;
  readonly reactivated_at: number | null;
}

/** Raised when a write would violate a declared constraint. */
export class ConstraintViolation extends Error {
  constructor(
    readonly constraint: string,
    readonly table: string,
  ) {
    super(`${table}: ${constraint}`);
    this.name = 'ConstraintViolation';
  }
}

export interface Store {
  // ---- aba_user ----
  insertUser(row: AbaUserRow): Promise<void>;
  getUser(id: string): Promise<AbaUserRow | null>;
  markUserDeleted(id: string, at: number): Promise<void>;

  // ---- auth_identity ----
  insertIdentity(row: AuthIdentityRow): Promise<void>;
  getIdentity(id: string): Promise<AuthIdentityRow | null>;
  /** Lookup by external identity. The only way an authentication resolves. */
  findIdentityBySubject(kind: AuthIdentityKind, subject: string): Promise<AuthIdentityRow | null>;
  /** Verified addresses only — an unverified row is never a match (AUTH-18). */
  findIdentityByVerifiedEmail(
    kind: AuthIdentityKind,
    email: string,
  ): Promise<AuthIdentityRow | null>;
  listIdentities(abaUserId: string): Promise<AuthIdentityRow[]>;
  touchIdentity(id: string, at: number): Promise<void>;
  deleteIdentity(id: string): Promise<void>;

  // ---- session ----
  insertSession(row: SessionRow): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  findSessionByDigest(digest: string): Promise<SessionRow | null>;
  markSessionRotated(id: string, at: number): Promise<void>;
  revokeSession(id: string, at: number, reason: string): Promise<void>;
  revokeFamily(familyId: string, at: number, reason: string): Promise<number>;
  revokeAllForUser(abaUserId: string, at: number, reason: string): Promise<number>;
  revokeForIdentity(authIdentityId: string, at: number, reason: string): Promise<number>;
  listSessions(abaUserId: string): Promise<SessionRow[]>;

  // ---- device ----
  insertDevice(row: DeviceRow): Promise<void>;
  getDevice(abaUserId: string, deviceId: string): Promise<DeviceRow | null>;
  listDevices(abaUserId: string): Promise<DeviceRow[]>;
  setDeviceRetired(
    abaUserId: string,
    deviceId: string,
    at: number | null,
    reactivatedAt: number | null,
  ): Promise<void>;
  touchDevice(abaUserId: string, deviceId: string, at: number): Promise<void>;
}
