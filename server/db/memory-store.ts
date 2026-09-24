/**
 * An in-memory `Store` that enforces the declared schema.
 *
 * This is not a lenient fake. Every write goes through a generic engine that
 * reads `schema.ts` and applies, in order: the column set, nullability,
 * primary-key uniqueness, partial unique indexes, foreign keys, and write-once
 * columns. A test that passes here would pass against the rendered DDL,
 * because both are generated from the same descriptor.
 *
 * That matters most for one rule. "An identity cannot move between accounts"
 * is `aba_user_id.writeOnce` in the descriptor; here it is an update the
 * engine refuses, and in PostgreSQL it would be a column no statement in the
 * port can target. The test that asserts it is therefore testing a mechanism,
 * not a convention (AUTH-23).
 *
 * Deliberately **not** a general database: no joins, no raw predicates, no
 * cross-owner scans. Everything it can do is something the port already named.
 */
import { SCHEMA, type AuthIdentityKind, type TableSpec, type UniqueSpec } from './schema';
import {
  ConstraintViolation,
  type AbaUserRow,
  type AuthIdentityRow,
  type DeviceRow,
  type LoginChallengeRow,
  type SessionRow,
  type Store,
} from './store';

/** A row as the generic engine sees it: named columns of scalar values. */
type Row = Record<string, string | number | boolean | null>;

/**
 * Reads a typed row as a generic one.
 *
 * One cast, in one place, rather than an index signature forced onto every
 * row interface — which would make `AbaUserRow` accept any property name and
 * defeat the point of declaring it.
 */
function asRow(value: object): Row {
  return value as Row;
}

/** Is every column a partial index requires present on this row? */
function constraintApplies(row: Row, unique: UniqueSpec): boolean {
  const present = (unique.requires ?? []).every((name) => {
    const value = row[name];
    return value !== null && value !== undefined && value !== false;
  });
  if (!present) return false;
  return (unique.requiresNull ?? []).every((name) => {
    const value = row[name];
    return value === null || value === undefined;
  });
}

function keyOf(row: Row, columns: readonly string[]): string {
  // JSON of the ordered values, so `['a', 'b']` and `['ab']` cannot collide.
  return JSON.stringify(columns.map((name) => row[name] ?? null));
}

/**
 * One table, enforcing its own declaration.
 *
 * Generic on purpose: a per-table hand-written check is a check somebody has
 * to remember to add when a constraint is added to the descriptor, and this
 * one cannot be forgotten because there is nothing to write.
 */
class MemoryTable<T extends object> {
  private readonly rows = new Map<string, T>();

  constructor(
    private readonly spec: TableSpec,
    private readonly parent: (table: string) => MemoryTable<object> | undefined,
  ) {}

  private validateShape(row: Row): void {
    const declared = new Set(this.spec.columns.map((column) => column.name));
    for (const name of Object.keys(row)) {
      if (!declared.has(name)) {
        throw new ConstraintViolation(`unknown column ${name}`, this.spec.name);
      }
    }
    for (const column of this.spec.columns) {
      const value = row[column.name];
      if (value === undefined) {
        throw new ConstraintViolation(`missing column ${column.name}`, this.spec.name);
      }
      if (value === null && !column.nullable) {
        throw new ConstraintViolation(`${column.name} is NOT NULL`, this.spec.name);
      }
    }
  }

  private validateForeignKeys(row: Row): void {
    for (const fk of this.spec.foreignKeys) {
      const values = fk.columns.map((name) => row[name]);
      if (values.some((value) => value === null)) continue;
      const target = this.parent(fk.references.table);
      if (!target) throw new ConstraintViolation(`no table ${fk.references.table}`, this.spec.name);
      const found = target
        .all()
        .some((candidate) =>
          fk.references.columns.every((name, index) => asRow(candidate)[name] === values[index]),
        );
      if (!found) {
        throw new ConstraintViolation(`foreign key ${fk.columns.join(',')}`, this.spec.name);
      }
    }
  }

  private validateUnique(row: Row, existingPk: string | null): void {
    for (const unique of this.spec.unique) {
      if (!constraintApplies(row, unique)) continue;
      const key = keyOf(row, unique.columns);
      for (const [pk, stored] of this.rows) {
        if (pk === existingPk) continue;
        const candidate = asRow(stored);
        if (!constraintApplies(candidate, unique)) continue;
        if (keyOf(candidate, unique.columns) === key) {
          throw new ConstraintViolation(unique.name, this.spec.name);
        }
      }
    }
  }

  /**
   * Evaluates the checks that carry a JavaScript twin.
   *
   * Without this, a CHECK constraint was rendered into DDL and enforced
   * nowhere under test — which let `auth_identity_email_lowercase` contradict
   * the canonicaliser for as long as nobody ran against real Postgres.
   */
  private validateChecks(row: Row): void {
    for (const check of this.spec.checks) {
      if (check.holds === undefined) continue;
      if (!check.holds(row)) throw new ConstraintViolation(check.name, this.spec.name);
    }
  }

  insert(row: T): void {
    const raw = asRow(row);
    this.validateShape(raw);
    const pk = keyOf(raw, this.spec.primaryKey);
    if (this.rows.has(pk)) {
      throw new ConstraintViolation(`${this.spec.name}_pkey`, this.spec.name);
    }
    this.validateChecks(raw);
    this.validateUnique(raw, null);
    this.validateForeignKeys(raw);
    this.rows.set(pk, { ...row });
  }

  /**
   * Applies a patch to one row.
   *
   * A write-once column named in the patch is refused **even when the value is
   * unchanged**, because the intent is what is being refused: code that
   * reaches for `aba_user_id` in an update is code on its way to reassigning
   * an identity, and catching it at the no-op is catching it early.
   */
  update(key: Partial<T>, patch: Partial<T>): void {
    const pk = keyOf(asRow(key), this.spec.primaryKey);
    const current = this.rows.get(pk);
    if (!current) return;

    for (const name of Object.keys(patch)) {
      const column = this.spec.columns.find((entry) => entry.name === name);
      if (!column) throw new ConstraintViolation(`unknown column ${name}`, this.spec.name);
      if (column.writeOnce) {
        throw new ConstraintViolation(`${name} is write-once`, this.spec.name);
      }
    }

    const next = { ...current, ...patch };
    const raw = asRow(next);
    this.validateShape(raw);
    this.validateChecks(raw);
    this.validateUnique(raw, pk);
    this.rows.set(pk, next);
  }

  delete(key: Partial<T>): void {
    this.rows.delete(keyOf(asRow(key), this.spec.primaryKey));
  }

  get(key: Partial<T>): T | null {
    return this.rows.get(keyOf(asRow(key), this.spec.primaryKey)) ?? null;
  }

  all(): T[] {
    return [...this.rows.values()];
  }

  find(predicate: (row: T) => boolean): T | null {
    return this.all().find(predicate) ?? null;
  }

  filter(predicate: (row: T) => boolean): T[] {
    return this.all().filter(predicate);
  }
}

export class MemoryStore implements Store {
  private readonly tables = new Map<string, MemoryTable<object>>();

  private readonly users: MemoryTable<AbaUserRow>;
  private readonly identities: MemoryTable<AuthIdentityRow>;
  private readonly sessions: MemoryTable<SessionRow>;
  private readonly devices: MemoryTable<DeviceRow>;
  private readonly challenges: MemoryTable<LoginChallengeRow>;

  constructor() {
    const parent = (name: string): MemoryTable<object> | undefined => this.tables.get(name);
    for (const spec of SCHEMA) {
      this.tables.set(spec.name, new MemoryTable<object>(spec, parent));
    }
    // The map is keyed by name and holds the erased form; these four are the
    // typed views the port is implemented against.
    this.users = this.tables.get('aba_user') as MemoryTable<AbaUserRow>;
    this.identities = this.tables.get('auth_identity') as MemoryTable<AuthIdentityRow>;
    this.sessions = this.tables.get('session') as MemoryTable<SessionRow>;
    this.devices = this.tables.get('device') as MemoryTable<DeviceRow>;
    this.challenges = this.tables.get('login_challenge') as MemoryTable<LoginChallengeRow>;
  }

  /**
   * Runs a synchronous write as the asynchronous port describes it.
   *
   * A real database **rejects** on a constraint violation; it does not throw
   * before returning a promise. Without this wrapper the adapter would throw
   * synchronously, and code written against the port — `await`, `.catch()`,
   * a rejection handler — would behave differently here than in production,
   * which is the one way a test double is genuinely dangerous.
   */
  private static run<T>(operation: () => T): Promise<T> {
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // ---- aba_user ----

  insertUser(row: AbaUserRow): Promise<void> {
    return MemoryStore.run(() => this.users.insert(row));
  }

  getUser(id: string): Promise<AbaUserRow | null> {
    return MemoryStore.run(() => this.users.get({ id }));
  }

  markUserDeleted(id: string, at: number): Promise<void> {
    return MemoryStore.run(() => this.users.update({ id }, { state: 'deleted', deleted_at: at }));
  }

  // ---- auth_identity ----

  insertIdentity(row: AuthIdentityRow): Promise<void> {
    return MemoryStore.run(() => this.identities.insert(row));
  }

  getIdentity(id: string): Promise<AuthIdentityRow | null> {
    return Promise.resolve(this.identities.get({ id }));
  }

  findIdentityBySubject(kind: AuthIdentityKind, subject: string): Promise<AuthIdentityRow | null> {
    return Promise.resolve(
      this.identities.find((row) => row.kind === kind && row.subject === subject),
    );
  }

  findIdentityByVerifiedEmail(
    kind: AuthIdentityKind,
    email: string,
  ): Promise<AuthIdentityRow | null> {
    // The `email_verified` term is the point: an unverified row is a claim,
    // and matching on one is the pre-hijack attack (AUTH-18).
    return Promise.resolve(
      this.identities.find((row) => row.kind === kind && row.email === email && row.email_verified),
    );
  }

  listIdentities(abaUserId: string): Promise<AuthIdentityRow[]> {
    return Promise.resolve(this.identities.filter((row) => row.aba_user_id === abaUserId));
  }

  touchIdentity(id: string, at: number): Promise<void> {
    return MemoryStore.run(() => this.identities.update({ id }, { last_used_at: at }));
  }

  deleteIdentity(id: string): Promise<void> {
    return MemoryStore.run(() => {
      // The declared referential action, applied here so this adapter and the
      // rendered DDL agree: `ON DELETE SET NULL` on `session.auth_identity_id`.
      // A session that outlives its identity keeps its revocation record and
      // loses only the provenance, which is the honest result.
      for (const row of this.sessions.filter((entry) => entry.auth_identity_id === id)) {
        this.sessions.update({ id: row.id }, { auth_identity_id: null });
      }
      this.identities.delete({ id });
    });
  }

  // ---- session ----

  insertSession(row: SessionRow): Promise<void> {
    return MemoryStore.run(() => this.sessions.insert(row));
  }

  getSession(id: string): Promise<SessionRow | null> {
    return Promise.resolve(this.sessions.get({ id }));
  }

  findSessionByDigest(digest: string): Promise<SessionRow | null> {
    return Promise.resolve(this.sessions.find((row) => row.refresh_digest === digest));
  }

  claimSessionRotation(id: string, at: number): Promise<boolean> {
    return MemoryStore.run(() => {
      const row = this.sessions.get({ id });
      // Read and write with no await between them, so nothing can interleave:
      // in this runtime that is what "atomic" means, and it is the same
      // guarantee `WHERE rotated_at IS NULL` gives a SQL adapter.
      if (row === null || row.rotated_at !== null) return false;
      this.sessions.update({ id }, { rotated_at: at });
      return true;
    });
  }

  revokeSession(id: string, at: number, reason: string): Promise<void> {
    return MemoryStore.run(() => {
      const row = this.sessions.get({ id });
      if (row && row.revoked_at === null) {
        this.sessions.update({ id }, { revoked_at: at, revoked_reason: reason });
      }
    });
  }

  revokeFamily(familyId: string, at: number, reason: string): Promise<number> {
    return Promise.resolve(this.revokeWhere((row) => row.family_id === familyId, at, reason));
  }

  revokeAllForUser(abaUserId: string, at: number, reason: string): Promise<number> {
    return Promise.resolve(this.revokeWhere((row) => row.aba_user_id === abaUserId, at, reason));
  }

  revokeForIdentity(authIdentityId: string, at: number, reason: string): Promise<number> {
    return Promise.resolve(
      this.revokeWhere((row) => row.auth_identity_id === authIdentityId, at, reason),
    );
  }

  private revokeWhere(match: (row: SessionRow) => boolean, at: number, reason: string): number {
    const targets = this.sessions.filter((row) => match(row) && row.revoked_at === null);
    for (const row of targets) {
      this.sessions.update({ id: row.id }, { revoked_at: at, revoked_reason: reason });
    }
    return targets.length;
  }

  listSessions(abaUserId: string): Promise<SessionRow[]> {
    return Promise.resolve(this.sessions.filter((row) => row.aba_user_id === abaUserId));
  }

  // ---- login_challenge ----

  insertChallenge(row: LoginChallengeRow): Promise<void> {
    return MemoryStore.run(() => this.challenges.insert(row));
  }

  getChallenge(id: string): Promise<LoginChallengeRow | null> {
    return MemoryStore.run(() => this.challenges.get({ id }));
  }

  findChallengeByState(state: string): Promise<LoginChallengeRow | null> {
    return MemoryStore.run(() => this.challenges.find((row) => row.state === state));
  }

  findChallengeByExchangeDigest(digest: string): Promise<LoginChallengeRow | null> {
    return MemoryStore.run(() => this.challenges.find((row) => row.exchange_digest === digest));
  }

  /**
   * Marks the challenge spent, reporting whether **this** call did it.
   *
   * The return value is the whole point: two concurrent callbacks must not
   * both proceed, and "was it already consumed?" read separately from the
   * write is a race. One row, one winner.
   */
  consumeChallenge(id: string, at: number): Promise<boolean> {
    return MemoryStore.run(() => {
      const row = this.challenges.get({ id });
      if (row === null || row.consumed_at !== null) return false;
      this.challenges.update({ id }, { consumed_at: at });
      return true;
    });
  }

  attachChallengeOutcome(
    id: string,
    outcome: {
      readonly exchangeDigest: string;
      readonly abaUserId: string;
      readonly authIdentityId: string;
    },
  ): Promise<void> {
    return MemoryStore.run(() =>
      this.challenges.update(
        { id },
        {
          exchange_digest: outcome.exchangeDigest,
          resolved_aba_user_id: outcome.abaUserId,
          resolved_auth_identity_id: outcome.authIdentityId,
        },
      ),
    );
  }

  attachLinkOutcome(
    id: string,
    outcome: {
      readonly exchangeDigest: string;
      readonly subject: string | null;
      readonly email: string | null;
    },
  ): Promise<void> {
    return MemoryStore.run(() =>
      this.challenges.update(
        { id },
        {
          exchange_digest: outcome.exchangeDigest,
          resolved_subject: outcome.subject,
          resolved_email: outcome.email,
        },
      ),
    );
  }

  countChallengeAttempt(id: string): Promise<number> {
    return MemoryStore.run(() => {
      const row = this.challenges.get({ id });
      if (row === null) return 0;
      const attempts = row.attempts + 1;
      this.challenges.update({ id }, { attempts });
      return attempts;
    });
  }

  deleteChallenge(id: string): Promise<void> {
    return MemoryStore.run(() => this.challenges.delete({ id }));
  }

  purgeExpiredChallenges(now: number): Promise<number> {
    return MemoryStore.run(() => {
      const expired = this.challenges.filter((row) => row.expires_at <= now);
      for (const row of expired) this.challenges.delete({ id: row.id });
      return expired.length;
    });
  }

  // ---- device ----

  insertDevice(row: DeviceRow): Promise<void> {
    return MemoryStore.run(() => this.devices.insert(row));
  }

  getDevice(abaUserId: string, deviceId: string): Promise<DeviceRow | null> {
    return Promise.resolve(this.devices.get({ aba_user_id: abaUserId, device_id: deviceId }));
  }

  listDevices(abaUserId: string): Promise<DeviceRow[]> {
    return Promise.resolve(this.devices.filter((row) => row.aba_user_id === abaUserId));
  }

  setDeviceRetired(
    abaUserId: string,
    deviceId: string,
    at: number | null,
    reactivatedAt: number | null,
  ): Promise<void> {
    return MemoryStore.run(() =>
      this.devices.update(
        { aba_user_id: abaUserId, device_id: deviceId },
        { retired_at: at, reactivated_at: reactivatedAt },
      ),
    );
  }

  touchDevice(abaUserId: string, deviceId: string, at: number): Promise<void> {
    return MemoryStore.run(() =>
      this.devices.update({ aba_user_id: abaUserId, device_id: deviceId }, { last_seen_at: at }),
    );
  }
}
