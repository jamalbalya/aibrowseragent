#!/usr/bin/env node
/**
 * Verifies PARITY_MATRIX.md against evidence, not against itself.
 *
 * Two classes of error have actually occurred in this repository and both are
 * checked here:
 *
 *  1. The summary counts contradicted the table beneath them — it claimed 17
 *     PASS while the table said 23.
 *  2. Three capabilities claimed integration coverage that did not exist. The
 *     arithmetic was consistent, so a self-consistency check could never have
 *     caught it.
 *
 * The fix for (2) is that a "yes" is no longer an assertion. Every one must be
 * backed by a file listed in parity-evidence.json, that file must exist, and
 * it must live in the category it is cited under. A capability with no cited
 * evidence for a column must show "—".
 *
 * A third class has since occurred, and the checks above cannot see it: a
 * capability whose cited tests all exist and pass while the *specification
 * clause* they were taken to cover is not the clause they test. P-019 read PASS
 * implementing two of §53's six notifications; P-017 and P-032 read PASS while
 * pausing a task destroyed it. `lib/clause-gate.mjs` handles that, and the
 * comment at the top of it explains why clause evidence has to name a test
 * rather than a file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkClauses } from './lib/clause-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(resolve(root, 'PARITY_MATRIX.md'), 'utf8');
const evidence = JSON.parse(
  readFileSync(resolve(root, 'parity-evidence.json'), 'utf8'),
).capabilities;

const VALID_STATUS = new Set([
  'PASS',
  'PARTIAL',
  'INTERFACES-ONLY',
  'NOT-STARTED',
  'BLOCKED',
  'DEFERRED',
]);
/** Column index in the table → evidence key → directory the file must sit in. */
const COLUMNS = [
  { index: 3, key: 'unit', dir: 'tests/unit/' },
  { index: 4, key: 'integration', dir: 'tests/integration/' },
  { index: 5, key: 'security', dir: 'tests/security/' },
  { index: 6, key: 'e2e', dir: 'tests/e2e/' },
];

const errors = [];

// --- capability rows -------------------------------------------------------
const rows = [];
for (const line of text.split('\n')) {
  const match = /^\|\s*(P-\d{3})\s*\|/.exec(line);
  if (!match) continue;
  const cells = line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
  if (cells.length !== 8) {
    errors.push(`${match[1]}: expected 8 columns, found ${cells.length}.`);
    continue;
  }
  if (!VALID_STATUS.has(cells[7])) {
    errors.push(
      `${match[1]}: unknown status "${cells[7]}". Use one of ${[...VALID_STATUS].join(', ')}.`,
    );
  }
  rows.push({ id: match[1], cells });
}

if (rows.length !== 40) {
  errors.push(`Expected 40 capability rows (P-001…P-040), found ${rows.length}.`);
}

const seen = new Set();
for (const row of rows) {
  if (seen.has(row.id)) errors.push(`${row.id} appears more than once.`);
  seen.add(row.id);
}
for (let i = 1; i <= 40; i += 1) {
  const id = `P-${String(i).padStart(3, '0')}`;
  if (!seen.has(id)) errors.push(`${id} is missing from the table.`);
  if (!(id in evidence)) errors.push(`${id} is missing from parity-evidence.json.`);
}

// --- every claim is backed by a file that exists ---------------------------
for (const row of rows) {
  const cited = evidence[row.id];
  if (!cited) continue;

  for (const column of COLUMNS) {
    const claim = row.cells[column.index];
    const files = cited[column.key] ?? [];

    for (const file of files) {
      if (!file.startsWith(column.dir)) {
        errors.push(
          `${row.id}: "${file}" is cited as ${column.key} but is not under ${column.dir}.`,
        );
      } else if (!existsSync(resolve(root, file))) {
        errors.push(`${row.id}: cited ${column.key} file "${file}" does not exist.`);
      }
    }

    if (claim === 'yes' && files.length === 0) {
      errors.push(
        `${row.id}: claims ${column.key} coverage, but parity-evidence.json cites no ${column.key} test. ` +
          'Either cite the test or change the claim to "—".',
      );
    }
    if (claim === '—' && files.length > 0) {
      errors.push(
        `${row.id}: shows no ${column.key} coverage, but ${files.length} ${column.key} test(s) are cited. ` +
          'The matrix is under-reporting what exists.',
      );
    }
    if (claim !== 'yes' && claim !== '—' && claim !== 'no') {
      errors.push(`${row.id}: ${column.key} column is "${claim}"; expected "yes", "no" or "—".`);
    }
  }
}

// --- a PASS has to be backed by something ---------------------------------
//
// Nothing above stops a row reading PASS with an empty implementation column
// and no test cited anywhere, which is the exact shape of an unearned claim.
for (const row of rows) {
  if (row.cells[7] !== 'PASS') continue;

  if (row.cells[2] !== 'yes') {
    errors.push(`${row.id} is PASS but its implementation column reads "${row.cells[2]}".`);
  }

  const cited = COLUMNS.filter((column) => (evidence[row.id]?.[column.key] ?? []).length > 0);
  if (cited.length === 0) {
    errors.push(`${row.id} is PASS but parity-evidence.json cites no test in any category.`);
  }
}

// --- summary counts match the table ---------------------------------------
const actual = Object.fromEntries([...VALID_STATUS].map((status) => [status, 0]));
for (const row of rows) {
  if (row.cells[7] in actual) actual[row.cells[7]] += 1;
}

for (const [status, count] of Object.entries(actual)) {
  // Every occurrence is checked, not just the first. An edit once left a
  // second, stale summary table further down the file; reading only the first
  // match made the document contradict itself while this check stayed green.
  const pattern = new RegExp(`^\\|\\s*${status.replace('-', '\\-')}\\s*\\|\\s*(\\d+)\\s*\\|`, 'gm');
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    // A status with no rows needs no summary line.
    if (count > 0)
      errors.push(`The summary has no row for ${status}, but ${count} capabilities use it.`);
    continue;
  }
  if (matches.length > 1) {
    errors.push(
      `${status} is counted ${matches.length} times. There must be exactly one summary table.`,
    );
  }
  for (const match of matches) {
    if (Number(match[1]) !== count) {
      errors.push(`Summary claims ${match[1]} ${status}, but the table contains ${count}.`);
    }
  }
}

// --- every non-PASS row explains itself ------------------------------------
for (const row of rows.filter((r) => r.cells[7] === 'PARTIAL')) {
  if (!text.includes(`**${row.id} `)) {
    errors.push(`${row.id} is PARTIAL but has no explanation of what is missing.`);
  }
}

// --- clause-level evidence, where an inventory exists ----------------------
const statusById = Object.fromEntries(rows.map((row) => [row.id, row.cells[7]]));
const clauseCheck = checkClauses({
  capabilities: evidence,
  statusById,
  fileExists: (file) => existsSync(resolve(root, file)),
  readFile: (file) => readFileSync(resolve(root, file), 'utf8'),
});
errors.push(...clauseCheck.errors);

if (errors.length > 0) {
  console.error('✗ PARITY_MATRIX.md does not match its evidence:\n');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('\nUpdate the table, the summary and parity-evidence.json together.');
  process.exit(1);
}

const summary = Object.entries(actual)
  .filter(([, count]) => count > 0)
  .map(([status, count]) => `${count} ${status}`)
  .join(', ');
console.log(
  `✓ Parity matrix verified against evidence: ${summary} across ${rows.length} capabilities.`,
);

// The count is printed whether or not it is flattering. A gate that covers a
// third of the matrix and says nothing about the rest reads as a gate that
// covers the matrix.
const clauseTotal = clauseCheck.inventoried.reduce(
  (total, id) => total + evidence[id].clauses.length,
  0,
);
console.log(
  `  clause inventory: ${clauseCheck.inventoried.length} of ${rows.length} capabilities, ` +
    `${clauseTotal} clauses. The remainder are not yet clause-checked.`,
);
for (const note of clauseCheck.notes) {
  console.log(`  · ${note}`);
}
