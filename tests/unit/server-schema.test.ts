/**
 * TEST-SERVER-001 — the schema descriptor, the DDL it renders, and the
 * columns it may never contain.
 *
 * Three things are asserted here that no other suite would notice.
 *
 * The first is drift. `schema.ts` is the source of truth and
 * `0001_identity_foundation.sql` is generated from it; a schema change that
 * does not reach the migration is a deployed database that disagrees with the
 * code, and it is invisible until a constraint fails in production.
 *
 * The second is the forbidden-column rule. Every entry in
 * `FORBIDDEN_COLUMN_FRAGMENTS` is a category the architecture states the
 * backend must never receive. Nobody adds `provider_api_key` by accident —
 * they add it on purpose, and this is what makes that a conversation rather
 * than a commit.
 *
 * The third is that the constraints carrying the linking policy actually
 * exist. "An identity belongs to at most one account" is a unique index, and
 * a unique index is one line somebody could delete while every behavioural
 * test still passed against an in-memory store that had also lost it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_COLUMN_FRAGMENTS,
  MIGRATION_COVERAGE,
  MIGRATIONS,
  SCHEMA,
  renderMigration,
  table,
} from '@server/index';

const migrationPath = resolve(import.meta.dirname, '../../server/migrations');

describe('schema descriptor', () => {
  it('declares exactly the identity tables, and no Cloud Sync tables', () => {
    expect(SCHEMA.map((entry) => entry.name)).toEqual([
      'aba_user',
      'auth_identity',
      'session',
      'device',
      'login_challenge',
    ]);
  });

  it('gives every column a stated reason', () => {
    for (const spec of SCHEMA) {
      for (const column of spec.columns) {
        expect(column.why.length, `${spec.name}.${column.name}`).toBeGreaterThan(10);
      }
    }
  });

  it('gives every index an access pattern', () => {
    for (const spec of SCHEMA) {
      for (const index of spec.indexes) {
        expect(index.why.length, `${spec.name}.${index.name}`).toBeGreaterThan(10);
      }
    }
  });

  it('names a primary key on every table', () => {
    for (const spec of SCHEMA) {
      expect(spec.primaryKey.length, spec.name).toBeGreaterThan(0);
      for (const column of spec.primaryKey) {
        expect(spec.columns.some((entry) => entry.name === column)).toBe(true);
      }
    }
  });

  it('points every foreign key at a table and column that exist', () => {
    const names = new Set(SCHEMA.map((entry) => entry.name));
    for (const spec of SCHEMA) {
      for (const fk of spec.foreignKeys) {
        expect(names.has(fk.references.table)).toBe(true);
        const target = table(fk.references.table);
        for (const column of fk.references.columns) {
          expect(target.columns.some((entry) => entry.name === column)).toBe(true);
        }
      }
    }
  });
});

describe('forbidden columns', () => {
  it('contains no column whose name matches a forbidden fragment', () => {
    const offenders: string[] = [];
    for (const spec of SCHEMA) {
      for (const column of spec.columns) {
        const name = column.name.toLowerCase();
        for (const fragment of FORBIDDEN_COLUMN_FRAGMENTS) {
          if (name.includes(fragment)) offenders.push(`${spec.name}.${column.name} ~ ${fragment}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('would catch a provider credential column if one were added', () => {
    // The guard is only worth having if it fires. This proves the predicate
    // rather than trusting that the current schema happens to be clean.
    const wouldBeCaught = (name: string): boolean =>
      FORBIDDEN_COLUMN_FRAGMENTS.some((fragment) => name.toLowerCase().includes(fragment));

    expect(wouldBeCaught('provider_api_key')).toBe(true);
    expect(wouldBeCaught('apiKey')).toBe(true);
    expect(wouldBeCaught('recovery_key')).toBe(true);
    expect(wouldBeCaught('kek_wrapped')).toBe(true);
    expect(wouldBeCaught('record_ciphertext')).toBe(true);
    expect(wouldBeCaught('chrome_tab_id')).toBe(true);
    expect(wouldBeCaught('window_id')).toBe(true);
    expect(wouldBeCaught('refresh_token')).toBe(true);
    // And does not fire on the columns that legitimately exist.
    expect(wouldBeCaught('refresh_digest')).toBe(false);
    expect(wouldBeCaught('aba_user_id')).toBe(false);
    expect(wouldBeCaught('device_id')).toBe(false);
  });
});

describe('linking constraints', () => {
  it('makes an external subject unique across all accounts', () => {
    const unique = table('auth_identity').unique.find(
      (entry) => entry.name === 'auth_identity_subject_key',
    );
    expect(unique?.columns).toEqual(['kind', 'subject']);
    expect(unique?.requires).toEqual(['subject']);
  });

  it('makes a verified address unique, and excludes unverified rows', () => {
    const unique = table('auth_identity').unique.find(
      (entry) => entry.name === 'auth_identity_email_key',
    );
    expect(unique?.columns).toEqual(['kind', 'email']);
    // `email_verified` in the predicate is what keeps an unverified claim out
    // of the uniqueness key (AUTH-18).
    expect(unique?.requires).toEqual(['email', 'email_verified']);
  });

  it('marks an identity owner write-once, so reassignment is unexpressible', () => {
    const owner = table('auth_identity').columns.find((entry) => entry.name === 'aba_user_id');
    expect(owner?.writeOnce).toBe(true);
  });

  it('marks a device owner write-once', () => {
    const owner = table('device').columns.find((entry) => entry.name === 'aba_user_id');
    expect(owner?.writeOnce).toBe(true);
  });

  it('marks the abaUserId itself write-once', () => {
    expect(table('aba_user').columns.find((entry) => entry.name === 'id')?.writeOnce).toBe(true);
  });
});

describe('migrations', () => {
  it('renders byte-for-byte to the checked-in migration', () => {
    const onDisk = readFileSync(resolve(migrationPath, '0001_identity_foundation.sql'), 'utf8');
    expect(renderMigration(1)).toBe(onDisk);
  });

  it('numbers migrations contiguously from one', () => {
    expect(MIGRATIONS.map((entry) => entry.id)).toEqual(
      MIGRATIONS.map((_entry, index) => index + 1),
    );
  });

  it('names each migration file by its own number', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.file.startsWith(String(migration.id).padStart(4, '0'))).toBe(true);
    }
  });

  it('emits the unique indexes that carry the linking policy', () => {
    const sql = renderMigration(1);
    expect(sql).toContain(
      'CREATE UNIQUE INDEX auth_identity_subject_key ON auth_identity (kind, subject) WHERE subject IS NOT NULL;',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX auth_identity_email_key ON auth_identity (kind, email) WHERE email IS NOT NULL AND email_verified;',
    );
  });

  it('emits no Cloud Sync table', () => {
    const sql = MIGRATIONS.map((entry) => renderMigration(entry.id)).join('\n');
    for (const name of ['sync_record', 'push_idempotency', 'synced_through_seq']) {
      expect(sql).not.toContain(name);
    }
  });

  it('renders every migration byte-for-byte to its checked-in file', () => {
    for (const migration of MIGRATIONS) {
      const onDisk = readFileSync(resolve(migrationPath, migration.file), 'utf8');
      expect(renderMigration(migration.id), migration.file).toBe(onDisk);
    }
  });

  it('creates every table and column exactly once across the whole set', () => {
    // The append-only property, checked rather than trusted. A column created
    // by two migrations fails the second time it is applied; a column created
    // by none is a descriptor the database does not have.
    const created = new Map<string, number[]>();
    for (const migration of MIGRATION_COVERAGE) {
      for (const name of migration.createTables) {
        const spec = table(name);
        const addedLater = new Set(
          MIGRATION_COVERAGE.flatMap((entry) =>
            entry.addColumns.filter((add) => add.table === name).map((add) => add.column),
          ),
        );
        for (const column of spec.columns) {
          if (addedLater.has(column.name)) continue;
          const key = `${name}.${column.name}`;
          created.set(key, [...(created.get(key) ?? []), migration.id]);
        }
      }
      for (const add of migration.addColumns) {
        const key = `${add.table}.${add.column}`;
        created.set(key, [...(created.get(key) ?? []), migration.id]);
      }
    }

    const everyColumn = SCHEMA.flatMap((spec) =>
      spec.columns.map((column) => `${spec.name}.${column.name}`),
    );
    expect([...created.keys()].sort()).toEqual([...everyColumn].sort());
    expect([...created.entries()].filter(([, ids]) => ids.length !== 1)).toEqual([]);
  });

  it('never rewrites a migration that has already been applied', () => {
    // A column added after a table existed must arrive by ALTER, never by
    // reappearing inside the CREATE that made the table.
    const first = renderMigration(1);
    expect(first).toContain('CREATE TABLE session (');
    expect(first).not.toContain('digest_version');

    const second = renderMigration(2);
    expect(second).toContain('ALTER TABLE session ADD COLUMN digest_version integer NOT NULL');
    // The default is dropped again, so a future insert that forgets the column
    // fails loudly rather than silently claiming version 1.
    expect(second).toContain('ALTER TABLE session ALTER COLUMN digest_version DROP DEFAULT;');
    expect(second).not.toContain('CREATE TABLE session');
  });

  it('keeps the challenge table\u2019s secrets server-side and single-use', () => {
    const spec = table('login_challenge');
    const names = spec.columns.map((column) => column.name);
    for (const required of ['state', 'nonce', 'pkce_verifier', 'exchange_digest', 'consumed_at']) {
      expect(names, required).toContain(required);
    }
    // The state and the exchange material must each resolve to one row.
    expect(spec.unique.map((entry) => entry.name).sort()).toEqual([
      'login_challenge_exchange_key',
      'login_challenge_state_key',
    ]);
  });

  it('stores no Google token of any kind', () => {
    const sql = MIGRATIONS.map((entry) => renderMigration(entry.id)).join('\n');
    for (const name of ['id_token', 'access_token', 'google_token', 'authorization_code']) {
      expect(sql, name).not.toContain(name);
    }
  });
});
