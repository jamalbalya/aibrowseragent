/**
 * Renders the schema descriptor to migration DDL.
 *
 * Deterministic: the same descriptor always produces the same bytes, in the
 * same order, so the checked-in migration can be compared against the render
 * and a drift is a build failure rather than a discovery. That comparison is
 * the point of this module — it is not a runtime migration tool, and nothing
 * here executes SQL.
 *
 * The dialect is PostgreSQL, which is what `CLOUD_SYNC_PROTOCOL.md` §14
 * describes (`timestamptz`, partial unique indexes). No driver is installed:
 * choosing and wiring one is deployment work, and installing one now would add
 * a dependency that nothing in this phase exercises.
 */
import { SCHEMA, type ColumnSpec, type TableSpec } from './schema';

/**
 * Renders a partial-index predicate from the columns a constraint requires.
 *
 * A boolean column renders as itself — `email_verified` — and anything else as
 * a null check, which is the distinction that keeps unverified addresses out
 * of the uniqueness key without a separate hand-written clause.
 */
function renderPartialPredicate(spec: TableSpec, requires: readonly string[] | undefined): string {
  if (requires === undefined || requires.length === 0) return '';
  const terms = requires.map((name) => {
    const column = spec.columns.find((entry) => entry.name === name);
    if (!column) throw new Error(`${spec.name}: partial index requires unknown column ${name}`);
    return column.type === 'boolean' ? name : `${name} IS NOT NULL`;
  });
  return ` WHERE ${terms.join(' AND ')}`;
}

const TYPES: Record<ColumnSpec['type'], string> = {
  text: 'text',
  integer: 'integer',
  boolean: 'boolean',
  timestamptz: 'timestamptz',
};

function renderColumn(column: ColumnSpec): string {
  return `  ${column.name} ${TYPES[column.type]}${column.nullable ? '' : ' NOT NULL'}`;
}

function renderTable(spec: TableSpec): string {
  const lines: string[] = [];
  lines.push(`-- ${spec.why}`);
  lines.push(`CREATE TABLE ${spec.name} (`);

  const body: string[] = spec.columns.map(renderColumn);
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

  for (const unique of spec.unique) {
    const where = renderPartialPredicate(spec, unique.requires);
    lines.push('');
    lines.push(`-- ${unique.why}`);
    lines.push(
      `CREATE UNIQUE INDEX ${unique.name} ON ${spec.name} (${unique.columns.join(', ')})${where};`,
    );
  }
  for (const index of spec.indexes) {
    lines.push('');
    lines.push(`-- ${index.why}`);
    lines.push(`CREATE INDEX ${index.name} ON ${spec.name} (${index.columns.join(', ')});`);
  }
  return lines.join('\n');
}

/** The full DDL for the identity foundation, as one migration body. */
export function renderMigration(): string {
  const header = [
    '-- 0001_identity_foundation',
    '--',
    '-- GENERATED from server/db/schema.ts. Do not edit by hand: a test renders',
    '-- the descriptor and compares it against this file, so an edit here that',
    '-- the descriptor does not produce fails the build.',
    '--',
    '-- Identity and authentication only. Cloud Sync tables belong to',
    '-- CLOUD_SYNC_PROTOCOL.md and to the sync phase.',
    '',
  ].join('\n');

  return `${header}\n${SCHEMA.map(renderTable).join('\n\n')}\n`;
}

/**
 * Migrations in application order.
 *
 * Ordering is by the numeric prefix and is required to be contiguous from 1,
 * so a migration added out of band — or two authors both claiming `0002` —
 * fails rather than applying in whichever order the filesystem returns.
 */
export const MIGRATIONS: readonly { readonly id: number; readonly file: string }[] = [
  { id: 1, file: '0001_identity_foundation.sql' },
];
