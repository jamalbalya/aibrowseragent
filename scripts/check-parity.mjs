#!/usr/bin/env node
/**
 * Verifies PARITY_MATRIX.md is internally consistent.
 *
 * A capability matrix whose summary contradicts its own table is worse than no
 * matrix: it reports a status nobody verified. An earlier revision claimed 17
 * PASS while the table said 23. This check makes that class of drift a build
 * failure rather than something a reader has to notice.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(resolve(root, 'PARITY_MATRIX.md'), 'utf8');

const VALID = new Set(['PASS', 'PARTIAL', 'FOUNDATION', 'NOT_STARTED']);
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
    .map((c) => c.trim());
  if (cells.length !== 8) {
    errors.push(`${match[1]}: expected 8 columns, found ${cells.length}.`);
    continue;
  }
  const status = cells[7];
  if (!VALID.has(status)) errors.push(`${match[1]}: unknown status "${status}".`);
  rows.push({ id: match[1], status });
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
}

// --- summary counts --------------------------------------------------------
const actual = { PASS: 0, PARTIAL: 0, FOUNDATION: 0, NOT_STARTED: 0 };
for (const row of rows) {
  if (row.status in actual) actual[row.status] += 1;
}

const claimed = {};
for (const status of Object.keys(actual)) {
  const pattern = new RegExp(`^\\|\\s*${status}\\s*\\|\\s*(\\d+)\\s*\\|`, 'm');
  const match = pattern.exec(text);
  if (!match) {
    errors.push(`The summary has no row for ${status}.`);
    continue;
  }
  claimed[status] = Number(match[1]);
}

for (const [status, count] of Object.entries(actual)) {
  if (claimed[status] === undefined) continue;
  if (claimed[status] !== count) {
    errors.push(`Summary claims ${claimed[status]} ${status}, but the table contains ${count}.`);
  }
}

// --- every PARTIAL must say why -------------------------------------------
for (const row of rows.filter((r) => r.status === 'PARTIAL')) {
  if (!text.includes(`**${row.id} `)) {
    errors.push(`${row.id} is PARTIAL but has no explanation of what is missing.`);
  }
}

if (errors.length > 0) {
  console.error('✗ PARITY_MATRIX.md is inconsistent:\n');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('\nUpdate the table and the summary together.');
  process.exit(1);
}

console.log(
  `✓ Parity matrix consistent: ${actual.PASS} PASS, ${actual.PARTIAL} PARTIAL, ` +
    `${actual.FOUNDATION} FOUNDATION, ${actual.NOT_STARTED} NOT_STARTED across ${rows.length} capabilities.`,
);
