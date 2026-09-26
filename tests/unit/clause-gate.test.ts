/**
 * TEST-META-002 — the clause gate (scripts/lib/clause-gate.mjs).
 *
 * The first tests this repository has for its own parity tooling, and they exist
 * because the tooling is now load-bearing. Twice a capability read PASS while
 * its specification section was not satisfied; the gate is what is supposed to
 * stop a third time, and a gate nobody can write a failing test for is a gate
 * nobody knows works.
 *
 * Every case below is a fixture rather than the real repository, so the gate is
 * exercised against data chosen to break it. The filesystem arrives as two
 * functions, which is why that is possible at all.
 */
import { describe, expect, it } from 'vitest';
// A .mjs tool module with no type declarations, imported deliberately: the gate
// has to be tested as `check-parity.mjs` actually runs it, not through a
// re-implementation that could drift from it.
// @ts-expect-error -- untyped tool module
import { checkClauses, CLAUSE_STATUSES } from '../../scripts/lib/clause-gate.mjs';

interface Clause {
  id: string;
  specRef: string;
  requirement: string;
  mandatory: boolean;
  status: string;
  evidence?: string[];
  note?: string;
  acceptance?: string;
  blocker?: string;
}

interface Result {
  errors: string[];
  notes: string[];
  inventoried: string[];
}

/** One file, one test title, so a citation can resolve or fail to. */
const FILES: Record<string, string> = {
  'tests/unit/real.test.ts': `it('a real test title', () => {});`,
};

const run = (
  capabilities: Record<string, Record<string, unknown>>,
  statusById: Record<string, string>,
): Result =>
  (
    checkClauses as (input: {
      capabilities: unknown;
      statusById: unknown;
      fileExists: (path: string) => boolean;
      readFile: (path: string) => string;
    }) => Result
  )({
    capabilities,
    statusById,
    fileExists: (path) => path in FILES,
    readFile: (path) => FILES[path] ?? '',
  });

const clause = (over: Partial<Clause> = {}): Clause => ({
  id: 'C1',
  specRef: '§53',
  requirement: 'Notify when a task completes.',
  mandatory: true,
  status: 'VERIFIED',
  evidence: ['tests/unit/real.test.ts :: a real test title'],
  ...over,
});

describe('a well-formed inventory', () => {
  it('passes, and reports which capabilities it covered', () => {
    const result = run({ 'P-001': { clauses: [clause()] } }, { 'P-001': 'PASS' });

    expect(result.errors).toEqual([]);
    expect(result.inventoried).toEqual(['P-001']);
  });

  it('leaves a capability with no inventory entirely alone', () => {
    // The gate grows one wave at a time. A capability nobody has enumerated yet
    // must not be failed for it, or the gate could never be introduced.
    const result = run({ 'P-002': { unit: ['tests/unit/real.test.ts'] } }, { 'P-002': 'PASS' });

    expect(result.errors).toEqual([]);
    expect(result.inventoried).toEqual([]);
  });

  it('accepts several different kinds of evidence for different clauses', () => {
    // §10 of the wave brief: nothing here demands a particular test type. A
    // unit test satisfying one clause and an E2E another is the normal case.
    FILES['tests/e2e/real.spec.ts'] = `test('an end to end title', async () => {});`;
    const result = run(
      {
        'P-001': {
          clauses: [
            clause({ id: 'C1' }),
            clause({ id: 'C2', evidence: ['tests/e2e/real.spec.ts :: an end to end title'] }),
          ],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors).toEqual([]);
  });
});

describe('what the gate refuses', () => {
  it('1. a PASS capability whose mandatory clause has no inventory entry at all', () => {
    // The inventory is a list; a clause that was never written down cannot be
    // detected by its absence. What is detectable is a *malformed* inventory,
    // which is the same failure one level up.
    const result = run({ 'P-001': { clauses: [] } }, { 'P-001': 'PASS' });

    expect(result.errors.join(' ')).toContain('not a non-empty array');
  });

  it('2. an invalid specification reference', () => {
    const result = run(
      { 'P-001': { clauses: [clause({ specRef: 'section 53' })] } },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('is not a specification reference');
  });

  it('3. a VERIFIED clause that cites nothing', () => {
    const result = run({ 'P-001': { clauses: [clause({ evidence: [] })] } }, { 'P-001': 'PASS' });

    expect(result.errors.join(' ')).toContain('is VERIFIED and cites nothing');
  });

  it('4. a citation whose file does not exist', () => {
    const result = run(
      { 'P-001': { clauses: [clause({ evidence: ['tests/unit/ghost.test.ts :: anything'] })] } },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('which does not exist');
  });

  it('4b. a citation to a real file naming a test that is not in it', () => {
    const result = run(
      {
        'P-001': {
          clauses: [clause({ evidence: ['tests/unit/real.test.ts :: a title nobody wrote'] })],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('contains no test titled');
  });

  it('5. EVIDENCE_MISSING on a mandatory clause of a PASS capability', () => {
    const result = run(
      {
        'P-001': {
          clauses: [
            clause({ status: 'EVIDENCE_MISSING', evidence: [], note: 'nothing covers it' }),
          ],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('is EVIDENCE_MISSING');
  });

  it('6. PARTIAL on a mandatory clause of a PASS capability', () => {
    const result = run(
      {
        'P-001': {
          clauses: [clause({ status: 'PARTIAL', evidence: [], note: 'half of it' })],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('is PARTIAL');
  });

  it('7. MANUAL_REQUIRED that names no acceptance procedure', () => {
    const result = run(
      {
        'P-001': {
          clauses: [clause({ status: 'MANUAL_REQUIRED', evidence: [], note: 'needs a person' })],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('names no acceptance procedure');
  });

  it('8. EXTERNAL_REQUIRED that names no external blocker', () => {
    const result = run(
      {
        'P-001': {
          clauses: [clause({ status: 'EXTERNAL_REQUIRED', evidence: [], note: 'needs a key' })],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('names no external blocker');
  });

  it('9. a citation that names a whole file rather than a test', () => {
    // This is the exact move that produced both defects the gate exists for: a
    // file that is about the capability, standing in for a clause it does not
    // test. The citation format is what makes it detectable.
    const result = run(
      { 'P-001': { clauses: [clause({ evidence: ['tests/unit/real.test.ts'] })] } },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('A whole file cannot establish one clause');
  });

  it('10. a PASS capability with more than one incomplete mandatory clause reports each', () => {
    const result = run(
      {
        'P-001': {
          clauses: [
            clause({ id: 'C1', status: 'EVIDENCE_MISSING', evidence: [], note: 'a' }),
            clause({ id: 'C2', status: 'PARTIAL', evidence: [], note: 'b' }),
          ],
        },
      },
      { 'P-001': 'PASS' },
    );

    const blocking = result.errors.filter((error) => error.includes('is PASS but its mandatory'));
    expect(blocking).toHaveLength(2);
  });

  it('an unknown status, and a duplicate clause id', () => {
    const result = run(
      {
        'P-001': {
          clauses: [clause({ status: 'PROBABLY_FINE' }), clause(), clause()],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors.join(' ')).toContain('is not one of');
    expect(result.errors.join(' ')).toContain('appears more than once');
  });

  it('a non-VERIFIED clause with no note saying why', () => {
    const result = run(
      { 'P-001': { clauses: [clause({ status: 'EVIDENCE_MISSING', evidence: [] })] } },
      { 'P-001': 'PARTIAL' },
    );

    expect(result.errors.join(' ')).toContain('carries no note saying why');
  });
});

describe('what the gate deliberately allows through', () => {
  it('reports an incomplete mandatory clause on a PARTIAL row without failing it', () => {
    // A PARTIAL row is already saying it is incomplete. Failing the build for
    // agreeing with itself would make the honest state unrepresentable.
    const result = run(
      {
        'P-001': {
          clauses: [clause({ status: 'EVIDENCE_MISSING', evidence: [], note: 'no producer' })],
        },
      },
      { 'P-001': 'PARTIAL' },
    );

    expect(result.errors).toEqual([]);
  });

  it('does not let MANUAL_REQUIRED become an automated-evidence failure', () => {
    // §84 condition 3 is a separate, repository-wide gate. Folding it in here
    // would make the two indistinguishable, which is the whole reason the
    // matrix keeps them apart.
    const result = run(
      {
        'P-001': {
          clauses: [
            clause({
              status: 'MANUAL_REQUIRED',
              evidence: [],
              note: 'a person has to see the dialog',
              acceptance: '91-downloads.md D-3-1',
            }),
          ],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors).toEqual([]);
    expect(result.notes.join(' ')).toContain('MANUAL_REQUIRED');
  });

  it('does not let EXTERNAL_REQUIRED become an automated-evidence failure', () => {
    const result = run(
      {
        'P-001': {
          clauses: [
            clause({
              status: 'EXTERNAL_REQUIRED',
              evidence: [],
              note: 'needs a vendor key',
              blocker: 'no project-owned provider credential',
            }),
          ],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors).toEqual([]);
    expect(result.notes.join(' ')).toContain('EXTERNAL_REQUIRED');
  });

  it('does not penalise an implementation for a specification that cannot be read', () => {
    // Resolving an ambiguity against the implementation is as much a guess as
    // resolving it in the implementation's favour. It is reported, not scored.
    const result = run(
      {
        'P-001': {
          clauses: [clause({ status: 'AMBIGUOUS', evidence: [], note: '§59 does not define it' })],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors).toEqual([]);
    expect(result.notes.join(' ')).toContain('AMBIGUOUS');
  });

  it('ignores a non-mandatory clause that is incomplete', () => {
    const result = run(
      {
        'P-001': {
          clauses: [
            clause(),
            clause({
              id: 'C2',
              mandatory: false,
              status: 'PARTIAL',
              evidence: [],
              note: 'example only',
            }),
          ],
        },
      },
      { 'P-001': 'PASS' },
    );

    expect(result.errors).toEqual([]);
  });
});

describe('the status vocabulary', () => {
  it('is exactly the six states the gate reasons about', () => {
    expect(CLAUSE_STATUSES).toEqual([
      'VERIFIED',
      'PARTIAL',
      'EVIDENCE_MISSING',
      'MANUAL_REQUIRED',
      'EXTERNAL_REQUIRED',
      'AMBIGUOUS',
    ]);
  });
});
