/**
 * Renders the schema descriptor to migration DDL.
 *
 * Deterministic: the same descriptor always produces the same bytes, in the
 * same order, so each checked-in migration can be compared against its render
 * and a drift is a build failure rather than a discovery. That comparison is
 * the point of this module — it is not a runtime migration tool, and nothing
 * here executes SQL.
 *
 * **Migrations are append-only.** A migration that has been committed is a
 * migration that may already have been applied somewhere, so it is never
 * edited; a change to the schema becomes the *next* migration. Each one
 * declares the tables it creates and the columns it adds, and a test asserts
 * that every table and every column in `SCHEMA` is created by **exactly one**
 * migration — which is what makes "the descriptor and the database agree" a
 * checked property rather than a hope.
 *
 * The dialect is PostgreSQL, which is what `CLOUD_SYNC_PROTOCOL.md` §14
 * describes (`timestamptz`, partial unique indexes). No driver is installed:
 * choosing and wiring one is deployment work.
 */
import { SCHEMA, type ColumnSpec, type TableSpec, type UniqueSpec } from './schema';

const TYPES: Record<ColumnSpec['type'], string> = {
  text: 'text',
  integer: 'integer',
  boolean: 'boolean',
  timestamptz: 'timestamptz',
};

/**
 * Renders a partial-index predicate from the columns a constraint requires.
 *
 * A boolean column renders as itself — `email_verified` — and anything else as
 * a null check, which is the distinction that keeps unverified addresses out
 * of the uniqueness key without a separate hand-written clause.
 */
function renderPartialPredicate(spec: TableSpec, unique: UniqueSpec): string {
  const column = (name: string): ColumnSpec => {
    const found = spec.columns.find((entry) => entry.name === name);
    if (!found) throw new Error(`${spec.name}: partial index requires unknown column ${name}`);
    return found;
  };
  const terms = [
    ...(unique.requires ?? []).map((name) =>
      column(name).type === 'boolean' ? name : `${name} IS NOT NULL`,
    ),
    ...(unique.requiresNull ?? []).map((name) => `${column(name).name} IS NULL`),
  ];
  return terms.length === 0 ? '' : ` WHERE ${terms.join(' AND ')}`;
}

function renderColumn(column: ColumnSpec): string {
  return `  ${column.name} ${TYPES[column.type]}${column.nullable ? '' : ' NOT NULL'}`;
}

function renderUnique(spec: TableSpec, unique: UniqueSpec): string[] {
  const where = renderPartialPredicate(spec, unique);
  return [
    '',
    `-- ${unique.why}`,
    `CREATE UNIQUE INDEX ${unique.name} ON ${spec.name} (${unique.columns.join(', ')})${where};`,
  ];
}

/**
 * Renders `CREATE TABLE`, **omitting columns a later migration adds**.
 *
 * Without this, adding a column to an existing table would silently rewrite
 * the migration that created it — and an already-applied migration that
 * changes is a migration whose checksum no longer matches what any deployed
 * database ran. The column belongs to exactly one migration, and this is the
 * half of that rule the create side has to honour.
 */
function renderTable(spec: TableSpec, addedLater: ReadonlySet<string>): string {
  const lines: string[] = [];
  lines.push(`-- ${spec.why}`);
  lines.push(`CREATE TABLE ${spec.name} (`);

  const body: string[] = spec.columns
    .filter((column) => !addedLater.has(`${spec.name}.${column.name}`))
    .map(renderColumn);
  body.push(`  PRIMARY KEY (${spec.primaryKey.join(', ')})`);
  for (const fk of spec.foreignKeys) {
    body.push(
      `  FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.references.table} ` +
        `(${fk.references.columns.join(', ')}) ON DELETE ${fk.onDelete.toUpperCase()}`,
    );
  }
  for (const check of spec.checks) {
    body.push(`  CONSTRAINT ${check.name} CHECK (${check.expression})`);
  }
  lines.push(body.join(',\n'));
  lines.push(');');

  for (const unique of spec.unique) lines.push(...renderUnique(spec, unique));
  for (const index of spec.indexes) {
    lines.push('');
    lines.push(`-- ${index.why}`);
    lines.push(`CREATE INDEX ${index.name} ON ${spec.name} (${index.columns.join(', ')});`);
  }
  return lines.join('\n');
}

function table(name: string): TableSpec {
  const found = SCHEMA.find((entry) => entry.name === name);
  if (!found) throw new Error(`No such table in the schema: ${name}`);
  return found;
}

/**
 * A column added to a table that an earlier migration already created.
 *
 * `backfill` is required for a NOT NULL column, because adding one to a table
 * with rows in it needs a value for those rows, and leaving that to the
 * reader is how a migration works in development and fails in production.
 */
interface AddColumn {
  readonly table: string;
  readonly column: string;
  readonly backfill?: string;
}

interface MigrationSpec {
  readonly id: number;
  readonly file: string;
  readonly title: string;
  readonly note: readonly string[];
  readonly createTables: readonly string[];
  readonly addColumns: readonly AddColumn[];
}

const SPECS: readonly MigrationSpec[] = [
  {
    id: 1,
    file: '0001_identity_foundation.sql',
    title: '0001_identity_foundation',
    note: [
      'Identity and authentication only. Cloud Sync tables belong to',
      'CLOUD_SYNC_PROTOCOL.md and to the sync phase.',
    ],
    createTables: ['aba_user', 'auth_identity', 'session', 'device'],
    addColumns: [],
  },
  {
    id: 2,
    file: '0002_google_auth.sql',
    title: '0002_google_auth',
    note: [
      'The Google sign-in phase. Adds the in-flight challenge row, and the',
      'refresh-digest version column the refresh-token review asked for.',
      '',
      'Every secret on login_challenge is server-side only: the client holds',
      'the id and nothing else.',
    ],
    createTables: ['login_challenge'],
    addColumns: [{ table: 'session', column: 'digest_version', backfill: '1' }],
  },
];

function header(spec: MigrationSpec): string {
  return [
    `-- ${spec.title}`,
    '--',
    '-- GENERATED from server/db/schema.ts. Do not edit by hand: a test renders',
    '-- the descriptor and compares it against this file, so an edit here that',
    '-- the descriptor does not produce fails the build.',
    '--',
    ...spec.note.map((line) => (line === '' ? '--' : `-- ${line}`)),
    '',
  ].join('\n');
}

function renderAddColumn(add: AddColumn): string {
  const spec = table(add.table);
  const column = spec.columns.find((entry) => entry.name === add.column);
  if (!column) throw new Error(`${add.table}: no such column ${add.column}`);

  const lines = [`-- ${column.why}`];
  if (column.nullable || add.backfill === undefined) {
    lines.push(
      `ALTER TABLE ${spec.name} ADD COLUMN ${column.name} ${TYPES[column.type]}` +
        `${column.nullable ? '' : ' NOT NULL'};`,
    );
    return lines.join('\n');
  }
  // Three statements rather than one: a NOT NULL column added to a populated
  // table needs a value for the existing rows, and a DEFAULT left in place
  // afterwards would silently supply one for every future insert that forgot.
  lines.push(
    `ALTER TABLE ${spec.name} ADD COLUMN ${column.name} ${TYPES[column.type]} ` +
      `NOT NULL DEFAULT ${add.backfill};`,
  );
  lines.push(`ALTER TABLE ${spec.name} ALTER COLUMN ${column.name} DROP DEFAULT;`);
  return lines.join('\n');
}

/** One migration's DDL. */
export function renderMigration(id: number): string {
  const spec = SPECS.find((entry) => entry.id === id);
  if (!spec) throw new Error(`No such migration: ${id}`);

  // Every column any migration adds by ALTER, so the CREATE that made its
  // table leaves it out. A column is created once, by one migration.
  const addedByAlter = new Set(
    SPECS.flatMap((entry) => entry.addColumns.map((add) => `${add.table}.${add.column}`)),
  );

  const parts = [
    ...spec.createTables.map((name) => renderTable(table(name), addedByAlter)),
    ...spec.addColumns.map(renderAddColumn),
  ];
  return `${header(spec)}\n${parts.join('\n\n')}\n`;
}

/**
 * Migrations in application order.
 *
 * Ordering is by the numeric prefix and is required to be contiguous from 1,
 * so a migration added out of band — or two authors both claiming `0002` —
 * fails rather than applying in whichever order the filesystem returns.
 */
export const MIGRATIONS: readonly { readonly id: number; readonly file: string }[] = SPECS.map(
  (spec) => ({ id: spec.id, file: spec.file }),
);

/**
 * What each migration is responsible for, so a test can assert that the set
 * of migrations covers the descriptor exactly once.
 */
export const MIGRATION_COVERAGE: readonly {
  readonly id: number;
  readonly createTables: readonly string[];
  readonly addColumns: readonly { readonly table: string; readonly column: string }[];
}[] = SPECS.map((spec) => ({
  id: spec.id,
  createTables: spec.createTables,
  addColumns: spec.addColumns.map((add) => ({ table: add.table, column: add.column })),
}));
