/**
 * TEST-META-001 — Test identifiers are unique.
 *
 * Every suite carries a `TEST-<AREA>-<NNN>` id in its header, and those ids
 * are how the specification's traceability matrix points at a suite. Two
 * suites sharing one silently makes a requirement look covered by whichever
 * file the reader happens to open first. It has happened twice, both times
 * when a new suite copied a neighbour's header, so the check is automated
 * rather than left to review.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS_ROOT = resolve(import.meta.dirname, '..');
const SUITE_DIRS = ['unit', 'integration', 'security', 'e2e'];
// The area can contain digits — TEST-E2E-006 — so it is not [A-Z] only.
const ID = /TEST-[A-Z0-9]+-\d+/;

/** Every suite file paired with the identifier in its header, if it has one. */
function suiteIdentifiers(): { file: string; id: string }[] {
  const found: { file: string; id: string }[] = [];

  for (const dir of SUITE_DIRS) {
    const full = join(TESTS_ROOT, dir);
    for (const entry of readdirSync(full)) {
      if (!/\.(test|spec)\.ts$/.test(entry)) continue;
      const header = readFileSync(join(full, entry), 'utf8').slice(0, 600);
      const match = ID.exec(header);
      if (match) found.push({ file: `${dir}/${entry}`, id: match[0] });
    }
  }
  return found;
}

describe('suite identifiers', () => {
  it('finds an identifier in every suite', () => {
    const withIds = new Set(suiteIdentifiers().map((entry) => entry.file));
    const all = SUITE_DIRS.flatMap((dir) =>
      readdirSync(join(TESTS_ROOT, dir))
        .filter((entry) => /\.(test|spec)\.ts$/.test(entry))
        .map((entry) => `${dir}/${entry}`),
    );

    expect([...all].filter((file) => !withIds.has(file))).toEqual([]);
  });

  it('never uses one identifier for two suites', () => {
    const byId = new Map<string, string[]>();
    for (const { file, id } of suiteIdentifiers()) {
      byId.set(id, [...(byId.get(id) ?? []), file]);
    }

    const collisions = [...byId.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([id, files]) => `${id} is used by ${files.join(' and ')}`);

    expect(collisions).toEqual([]);
  });
});
