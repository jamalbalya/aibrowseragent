/**
 * The clause gate: does a PASS row satisfy the specification, clause by clause?
 *
 * ## Why this exists
 *
 * The rest of `check-parity.mjs` answers a narrower question than it appears
 * to. It checks that a cited test file exists, that it sits in the category it
 * is cited under, and that the matrix's columns agree with the citations. All
 * useful, and none of it asks whether the capability actually does what its
 * specification section says.
 *
 * Twice that difference has mattered. P-019 read PASS while implementing two of
 * the six things §53 asks it to notify for. P-017 and P-032 read PASS while
 * pausing a task destroyed it — the cited tests were real, they passed, and the
 * clause they were taken to cover was not the clause they tested.
 *
 * So evidence here is **clause-specific**, and that is enforced by the shape of
 * a citation rather than by care: a clause cites `file :: exact test title`, and
 * the title has to appear in that file as a complete string literal. Naming a
 * whole file cannot satisfy a clause, which is precisely the move that produced
 * both defects.
 *
 * ## What this gate is not
 *
 * It is not §84 condition 3. The matrix's PASS column means automated evidence —
 * §84's conditions 1, 2, 4, 5 and 6 — and the manual acceptance test is a
 * separate, repository-wide gate that this file does not touch and must not be
 * read as satisfying. A clause whose evidence can only come from a person, or
 * from a credential nobody here holds, is declared as such and reported; it does
 * not silently become an automated-evidence failure, because collapsing those
 * two into one boolean is how a repository stops being able to tell them apart.
 */

/** Every state a clause may be in. */
export const CLAUSE_STATUSES = [
  /** An automated test names this clause and passes. */
  'VERIFIED',
  /** Some of the clause is covered and some is not. The note says which. */
  'PARTIAL',
  /** Implemented or not, nothing establishes it. The honest default. */
  'EVIDENCE_MISSING',
  /** Only a person at a screen can establish it. §84 condition 3 territory. */
  'MANUAL_REQUIRED',
  /** Needs a credential, an OAuth application or a service nobody here has. */
  'EXTERNAL_REQUIRED',
  /** The specification does not say plainly enough to test against. */
  'AMBIGUOUS',
];

/**
 * States that stop a capability reading PASS.
 *
 * These are the automated-evidence gaps: the thing could be tested here and is
 * not, or is only half tested. That is the exact question the PASS column
 * claims to answer.
 */
const BLOCKS_PASS = new Set(['PARTIAL', 'EVIDENCE_MISSING']);

/**
 * States that must be declared, are reported, and do not stop a PASS.
 *
 * `MANUAL_REQUIRED` and `EXTERNAL_REQUIRED` are the other two gates — a person,
 * and a credential — which the matrix already tracks separately and which this
 * file deliberately does not fold in.
 *
 * `AMBIGUOUS` is here for a different reason. An unreadable requirement is a
 * specification problem to escalate, not an implementation that fell short, and
 * this repository's own rule is not to resolve an ambiguity in favour of the
 * implementation. Penalising the implementation for it would be resolving it the
 * other way, which is just as much a guess.
 */
const DECLARED_NOT_BLOCKING = new Set(['MANUAL_REQUIRED', 'EXTERNAL_REQUIRED', 'AMBIGUOUS']);

/** `§53`, `§5.1` — the specification's own numbering and nothing invented. */
const SPEC_REF = /^§\d+(\.\d+)?$/;

/** `path/to/file.ts :: exact test title` */
const CITATION = /^(\S+)\s*::\s*(.+?)\s*$/;

/**
 * A cited title has to appear as a *complete* string literal, delimiters and
 * all. Requiring the quotes is what makes a rename in either direction break
 * the citation — the same rule `check-acceptance.mjs` arrived at after a
 * mutation slipped past a substring match.
 */
function quotedIn(source, title) {
  return [`'${title}'`, `"${title}"`, `\`${title}\``].some((literal) => source.includes(literal));
}

/**
 * Checks every clause inventory against the matrix statuses.
 *
 * Pure: the filesystem arrives as two functions, so the whole gate is testable
 * without a repository on disk. That is not decoration — a gate nobody can
 * write a failing test for is a gate nobody knows is load-bearing.
 *
 * @param {object} input
 * @param {Record<string, object>} input.capabilities parity-evidence capabilities
 * @param {Record<string, string>} input.statusById matrix status per capability
 * @param {(path: string) => boolean} input.fileExists
 * @param {(path: string) => string} input.readFile
 * @returns {{ errors: string[], notes: string[], inventoried: string[] }}
 */
export function checkClauses({ capabilities, statusById, fileExists, readFile }) {
  const errors = [];
  const notes = [];
  const inventoried = [];

  for (const [id, entry] of Object.entries(capabilities)) {
    const clauses = entry.clauses;
    if (clauses === undefined) continue;

    if (!Array.isArray(clauses) || clauses.length === 0) {
      errors.push(`${id}: "clauses" is present but is not a non-empty array.`);
      continue;
    }
    inventoried.push(id);

    const seen = new Set();
    for (const clause of clauses) {
      const where = `${id} clause ${clause?.id ?? '(unnamed)'}`;

      if (typeof clause?.id !== 'string' || clause.id.length === 0) {
        errors.push(`${id}: a clause has no id.`);
        continue;
      }
      if (seen.has(clause.id)) errors.push(`${where}: appears more than once.`);
      seen.add(clause.id);

      if (typeof clause.specRef !== 'string' || !SPEC_REF.test(clause.specRef)) {
        errors.push(
          `${where}: specRef "${clause.specRef}" is not a specification reference such as §53 or §5.1.`,
        );
      }
      if (typeof clause.requirement !== 'string' || clause.requirement.trim().length === 0) {
        errors.push(`${where} (${clause.specRef}): has no requirement text.`);
      }
      if (typeof clause.mandatory !== 'boolean') {
        errors.push(`${where} (${clause.specRef}): "mandatory" must be true or false.`);
      }
      if (!CLAUSE_STATUSES.includes(clause.status)) {
        errors.push(
          `${where} (${clause.specRef}): status "${clause.status}" is not one of ` +
            `${CLAUSE_STATUSES.join(', ')}.`,
        );
        continue;
      }

      const evidence = clause.evidence ?? [];
      if (!Array.isArray(evidence)) {
        errors.push(`${where} (${clause.specRef}): "evidence" must be an array.`);
        continue;
      }

      if (clause.status === 'VERIFIED' && evidence.length === 0) {
        errors.push(
          `${where} (${clause.specRef}): is VERIFIED and cites nothing. ` +
            `Cite "file :: test title", or say EVIDENCE_MISSING.`,
        );
      }
      if (clause.status !== 'VERIFIED' && typeof clause.note !== 'string') {
        errors.push(
          `${where} (${clause.specRef}): is ${clause.status} and carries no note saying why.`,
        );
      }
      if (clause.status === 'MANUAL_REQUIRED' && typeof clause.acceptance !== 'string') {
        errors.push(
          `${where} (${clause.specRef}): is MANUAL_REQUIRED and names no acceptance procedure.`,
        );
      }
      if (clause.status === 'EXTERNAL_REQUIRED' && typeof clause.blocker !== 'string') {
        errors.push(
          `${where} (${clause.specRef}): is EXTERNAL_REQUIRED and names no external blocker.`,
        );
      }

      // Every citation must resolve, whatever the status claims. A stale
      // citation on a clause nobody is relying on still misleads the next
      // reader about where to look.
      for (const citation of evidence) {
        const parsed = CITATION.exec(String(citation));
        if (!parsed) {
          errors.push(
            `${where} (${clause.specRef}): evidence "${citation}" is not "file :: test title". ` +
              `A whole file cannot establish one clause.`,
          );
          continue;
        }
        const [, file, title] = parsed;
        if (!fileExists(file)) {
          errors.push(`${where} (${clause.specRef}): cites "${file}", which does not exist.`);
          continue;
        }
        if (!quotedIn(readFile(file), title)) {
          errors.push(
            `${where} (${clause.specRef}): "${file}" contains no test titled “${title}”.`,
          );
        }
      }
    }

    // --- and now: may this capability read PASS? ---------------------------
    if (statusById[id] !== 'PASS') continue;

    for (const clause of clauses) {
      if (clause?.mandatory !== true) continue;
      if (BLOCKS_PASS.has(clause.status)) {
        errors.push(
          `${id} is PASS but its mandatory clause ${clause.id} (${clause.specRef}) is ` +
            `${clause.status}: ${clause.requirement} — ${clause.note ?? 'no note'}`,
        );
      } else if (DECLARED_NOT_BLOCKING.has(clause.status)) {
        notes.push(
          `${id} ${clause.id} (${clause.specRef}) is ${clause.status}: ${clause.requirement}`,
        );
      }
    }
  }

  return { errors, notes, inventoried };
}
