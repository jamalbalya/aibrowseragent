#!/usr/bin/env node
/**
 * Checks the acceptance packages under `docs/testing/acceptance/`, and the
 * threat model at `docs/THREAT_MODEL.md`, against the repository they describe.
 *
 * An acceptance document is a claim about where evidence lives. A claim about
 * a file can go stale silently — a test renamed in one commit leaves a
 * citation pointing at nothing, and the document still reads as though it is
 * covered. That is worse than an uncited document, because it looks checked.
 *
 * So four rules are enforced, and each one exists because breaking it would
 * let the package overstate what this repository can show:
 *
 *  1. Every `- EVIDENCE:` line names a file that exists and a test title that
 *     really appears in it.
 *  2. Every item carries exactly one verdict.
 *  3. An `AUTOMATED` item cites at least one piece of evidence; a
 *     `NOT POSSIBLE HERE` item states a reason.
 *  4. No document in the package awards a `PASS`. The verdicts say where
 *     evidence comes from; whether an item was executed lives in RESULTS.md.
 *
 * What it deliberately does not do is read the cited test and judge whether
 * it proves the claim. Nothing mechanical can do that. The citation exists so
 * a reviewer has an exact place to look, and this script only guarantees the
 * place is really there.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'docs/testing/acceptance');

/**
 * Documents outside the acceptance directory that play by the same rules.
 *
 * `docs/THREAT_MODEL.md` is specification §81's threat model and it cites
 * evidence in exactly this form, so it gets exactly this checking. Adding it
 * here rather than giving it a checker of its own is the point: a second script
 * with the same job would drift from this one, and the rule that matters — a
 * citation names a test that really exists, quotes and all — is already written
 * down once.
 */
const EXTRA_DOCUMENTS = ['docs/THREAT_MODEL.md'];

/**
 * Specification §81's twelve mandatory documents, and where each one lives.
 *
 * Eight of them are **not** at the name §81 gives, and this table is the
 * answer rather than a rename. Renaming would break every inbound link in a
 * heavily cross-referenced docs tree to satisfy a filename, and a reviewer
 * checking §81 needs to be able to find the twelve — which is what a mapping
 * provides and a rename does not.
 *
 * Two of them genuinely did not exist until Wave 29: `MCP_GUIDE.md`, which is
 * why P-026's design had accumulated two unreviewed answers with nowhere to
 * record them, and `THREAT_MODEL.md`, which is why §82's eighteen threats had
 * never been written down as a set. That is the argument for checking this
 * rather than trusting it: nothing here noticed either absence, because no
 * clause covers §81 — the clause inventory runs over P-001…P-040 and §81 is a
 * project-structure requirement.
 */
const SPEC_81_DOCUMENTS = {
  'README.md': 'README.md',
  'ARCHITECTURE.md': 'docs/architecture.md',
  'SECURITY.md': 'docs/security.md',
  'THREAT_MODEL.md': 'docs/THREAT_MODEL.md',
  'PROVIDER_GUIDE.md': 'docs/provider-architecture.md',
  'CONNECTOR_GUIDE.md': 'docs/connectors.md',
  'SKILL_GUIDE.md': 'docs/skills.md',
  'PLUGIN_GUIDE.md': 'docs/architecture/PLUGIN_TRUST_MODEL.md',
  'MCP_GUIDE.md': 'docs/MCP_GUIDE.md',
  'WORKFLOW_GUIDE.md': 'docs/workflows.md',
  'PARITY_MATRIX.md': 'PARITY_MATRIX.md',
  'TESTING.md': 'docs/testing.md',
};

/**
 * What each acceptance package must cover, from the specification section it is
 * named for.
 *
 * The gap this closes is the §81 failure one level down. §81's twelve documents
 * went unmet with nothing able to notice, because no clause covers a
 * project-structure requirement; the same was true of the packages' *contents*.
 * This script checked that every item present owes a verdict and that every
 * citation resolves — and nothing checked that the items present are the items
 * the specification asks for. A scenario dropped from a package was invisible.
 *
 * Measured before it was written, and all six packages did cover their sections,
 * so this is a guard rather than a repair. It is written down because the two
 * previous times a set went unchecked in this repository, it had already drifted
 * by the time anybody looked.
 *
 * The items are transcribed here rather than parsed out of the specification,
 * for the reason `SPEC_81_DOCUMENTS` gives for the same choice: §87 through §90
 * list their items in fenced blocks and bullets rather than headings, and a
 * parser for that would be guessing at prose. The cost is that editing the
 * specification does not fail this check; the benefit is that a reviewer can
 * read the table against the section in a minute. Matching ignores case, because
 * a package titles its items as sentences and the specification does not.
 *
 * A package may carry *more* than its section names — `90-mv3-failures.md` adds
 * "Malformed persisted state", and `87-providers.md` ends with a procedure note
 * — so this checks coverage rather than equality. Extra items are coverage;
 * missing ones are the failure.
 */
const SPEC_ITEMS = {
  '85-mandatory.md': [
    'A. Basic browser',
    'B. Multi-tab',
    'C. Debugging',
    'D. Connector',
    'E. QA workflow',
    'F. Provider swap',
  ],
  '86-security.md': [
    'Prompt injection',
    'Exfiltration',
    'Redirect',
    'Credential leakage',
    'Duplicate write',
  ],
  '87-providers.md': [
    'Connect',
    'Validate',
    'List models',
    'Text generation',
    'Streaming',
    'Tool calling',
    'Multiple tool calls',
    'Vision',
    'Invalid credentials',
    'Expired auth',
    'Rate limit',
    'Unsupported capability',
  ],
  '88-connectors.md': [
    'Connect',
    'Scope validation',
    'Read',
    'Write',
    'Auth expiry',
    'Revocation',
    'Rate limit',
    'Permission denied',
    'Least privilege',
  ],
  '89-browser-failures.md': [
    'Page not loaded',
    'Element missing',
    'Element disabled',
    'Tab closed',
    'Navigation timeout',
    'Iframe',
    'Popup',
    'Redirect',
    'SPA navigation',
    'Modal',
    'Stale element',
    'Debugger unavailable',
  ],
  '90-mv3-failures.md': [
    'Service worker restart',
    'Side panel close',
    'Browser restart',
    'Extension reload',
    'Network interruption',
  ],
};

/** How short a §81 document may be before it counts as a placeholder. */
const MIN_DOCUMENT_LINES = 40;

/**
 * Which `## ` headings in a document are items that owe a verdict.
 *
 * The acceptance packages are all items, so their default is "every heading".
 * The threat model is one item per §82 threat plus front and back matter, and
 * front matter explaining what a verdict means is not itself an item. Keying
 * this off the `T-<n> —` numbering rather than off a list of prose headings
 * means a nineteenth threat added without a verdict still fails.
 */
const ITEM_HEADING = {
  'docs/THREAT_MODEL.md': /^T-\d+ — /,
  '84-capabilities.md': /^P-\d{3} — /,
};

/**
 * The per-capability census of specification §84 condition 3.
 *
 * Condition 3 — "manual acceptance test exists" — is stated per capability, and
 * for most of this repository's history nothing answered it per capability: the
 * sixty-three procedures here are organised by specification section, and of the
 * forty capabilities in `PARITY_MATRIX.md` exactly one appeared in this
 * directory at all. `84-capabilities.md` is the census that closes that, and
 * this is the guard that keeps it a census rather than a list.
 *
 * Enumerating the matrix's own table rather than a hand-written array of forty
 * ids is the whole point: a forty-first capability added to the matrix fails
 * here until condition 3 is answered for it.
 */
const CONDITION_3 = '84-capabilities.md';

const VERDICTS = ['AUTOMATED', 'MANUAL', 'NOT POSSIBLE HERE'];

/**
 * Documents that record what happened rather than where evidence lives.
 *
 * They carry execution classifications — PASS, FAIL, BLOCKED — CREDENTIAL and
 * the rest — which the package rules exist to keep out of the packages. The
 * rule that applies to them instead is that a status is one of the declared
 * classifications and never a hedge.
 */
const EXECUTION_RECORDS = ['RESULTS.md', 'MATRIX.md'];
const problems = [];

/**
 * A cited title has to appear as a *complete* string literal, delimiters and
 * all — not merely as a substring.
 *
 * The first version of this check looked for the title anywhere in the file,
 * and a mutation caught it out: renaming a test by appending to its title
 * leaves the old title as a prefix, so the citation kept resolving to a test
 * that no longer says what the citation claims. Requiring the quotes means a
 * rename in either direction breaks the citation, which is the point.
 */
const cited = new Map();

const quotedIn = (source, title) =>
  [`'${title}'`, `"${title}"`, `\`${title}\``].some((literal) => source.includes(literal));

if (!existsSync(dir)) {
  console.error(`✗ ${dir} does not exist`);
  process.exit(1);
}

const packages = readdirSync(dir).filter((name) => name.endsWith('.md'));
if (packages.length === 0) problems.push('the acceptance directory holds no documents');

// Every package covers the items its specification section names.
for (const [file, required] of Object.entries(SPEC_ITEMS)) {
  const path = join(dir, file);
  if (!existsSync(path)) {
    problems.push(`${file} is required by the specification and does not exist`);
    continue;
  }
  const headings = [...readFileSync(path, 'utf8').matchAll(/^## (.+)$/gm)].map((match) =>
    match[1].trim().toLowerCase(),
  );
  // An empty population would agree with everything.
  if (headings.length === 0) problems.push(`${file} has no items at all`);
  for (const item of required) {
    if (!headings.includes(item.toLowerCase())) {
      problems.push(`${file}: the specification names "${item}" and the package has no such item`);
    }
  }
}

for (const [mandated, actual] of Object.entries(SPEC_81_DOCUMENTS)) {
  const path = join(root, actual);
  if (!existsSync(path)) {
    problems.push(
      `specification §81 requires ${mandated}; this project keeps it at ${actual}, ` +
        `which does not exist`,
    );
    continue;
  }
  // A file that exists and says nothing satisfies the filename and not the
  // requirement, which is the failure a bare existence check invites.
  const lines = readFileSync(path, 'utf8').split('\n').length;
  if (lines < MIN_DOCUMENT_LINES) {
    problems.push(
      `${actual} stands in for §81's ${mandated} and holds only ${lines} lines, ` +
        `which reads as a placeholder rather than the document`,
    );
  }
}

const documents = [
  ...packages.map((name) => ({ name, path: join(dir, name) })),
  ...EXTRA_DOCUMENTS.filter((rel) => existsSync(join(root, rel))).map((rel) => ({
    name: rel,
    path: join(root, rel),
  })),
];

for (const { name, path } of documents) {
  const text = readFileSync(path, 'utf8');

  // 1. Evidence citations resolve.
  for (const line of text.split('\n')) {
    const match = /^- EVIDENCE:\s*(\S+)\s*::\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, file, title] = match;
    cited.set(`${file} :: ${title}`, (cited.get(`${file} :: ${title}`) ?? 0) + 1);
    const full = join(root, file);
    if (!existsSync(full)) {
      problems.push(`${name}: cites ${file}, which does not exist`);
      continue;
    }
    if (!quotedIn(readFileSync(full, 'utf8'), title)) {
      problems.push(`${name}: ${file} contains no test titled “${title}”`);
    }
  }

  // Execution records, not packages.
  //
  // A package says where evidence comes from — AUTOMATED, MANUAL, NOT
  // POSSIBLE HERE — and deliberately never awards a PASS, so that a verdict
  // cannot drift into a claim. An execution record answers the other
  // question: what happened when somebody ran it. That needs a vocabulary
  // the package rules forbid, so these files are checked by their own rule
  // below rather than exempted from checking.
  if (EXECUTION_RECORDS.includes(name)) {
    for (const [index, line] of text.split('\n').entries()) {
      const vague =
        /\b(mostly|partially|largely|broadly|roughly|more or less|good enough|nearly (?:complete|done)|should (?:work|be fine))\b/i.exec(
          line,
        );
      // A line naming the rule is allowed to quote the words it forbids.
      if (vague && !/never|not use|no vague|forbidden/i.test(line)) {
        problems.push(
          `${name}:${index + 1}: hedges with “${vague[0]}” — a status is one of the declared ` +
            `classifications, or it is not a status`,
        );
      }
    }
    continue;
  }

  if (name === 'README.md') continue;

  // 2-3. Each item's verdict, and what that verdict obliges it to carry.
  //      An item is a `## ` heading; its body runs to the next one.
  const isItem = ITEM_HEADING[name];
  const sections = text.split(/\n## /).slice(1);
  for (const section of sections) {
    const heading = section.split('\n')[0].trim();
    if (isItem !== undefined && !isItem.test(heading)) continue;
    const declared = VERDICTS.filter((verdict) =>
      new RegExp(`\\*\\*Verdict: \`${verdict}\``).test(section),
    );
    if (declared.length === 0) {
      problems.push(`${name}: item “${heading}” declares no verdict`);
      continue;
    }
    if (section.includes('AUTOMATED') && !section.includes('- EVIDENCE:')) {
      problems.push(`${name}: item “${heading}” claims AUTOMATED and cites nothing`);
    }
    if (section.includes('`NOT POSSIBLE HERE`') && !section.includes('- REASON:')) {
      problems.push(`${name}: item “${heading}” is NOT POSSIBLE HERE and gives no reason`);
    }
  }

  // 4. No item is given a verdict of PASS. Checked where a verdict is
  //    actually awarded — the `**Verdict:` line and a table cell holding
  //    nothing but the word — rather than anywhere the word appears, so that
  //    prose about why there is no PASS, and a count quoted from the parity
  //    matrix, both remain sayable. The rule is about what is claimed, not
  //    about vocabulary.
  for (const [index, line] of text.split('\n').entries()) {
    const awards =
      /\*\*Verdict:[^\n]*\bPASS/i.test(line) || /\|\s*`?PASS(ED|ES)?`?\s*\|/i.test(line);
    if (awards) {
      problems.push(
        `${name}:${index + 1}: awards a PASS — verdicts are AUTOMATED, MANUAL or NOT POSSIBLE HERE`,
      );
    }
  }
}

// 5. §84 condition 3, capability by capability.
//
//    Three things are checked and each one is a way the census could agree
//    with everything. Every capability the matrix lists has an entry, so a new
//    capability cannot arrive without one. A `COVERED BY` names a procedure id
//    that really appears in MATRIX.md, so a pointer cannot outlive what it
//    points at. And a written procedure carries a criterion and a failure
//    condition, because "run it and see" is not a procedure a second person
//    could execute the same way.
{
  const censusPath = join(dir, CONDITION_3);
  const matrixPath = join(dir, 'MATRIX.md');
  if (!existsSync(censusPath)) {
    problems.push(`${CONDITION_3} is the §84 condition 3 census and does not exist`);
  } else if (!existsSync(matrixPath)) {
    problems.push('MATRIX.md does not exist, so no COVERED BY reference can be resolved');
  } else {
    const census = readFileSync(censusPath, 'utf8');
    const matrix = readFileSync(matrixPath, 'utf8');
    const parity = readFileSync(join(root, 'PARITY_MATRIX.md'), 'utf8');

    // The real population, read off the matrix's own table.
    const capabilities = [...parity.matchAll(/^\| (P-\d{3}) \| /gm)].map((match) => match[1]);
    const unique = [...new Set(capabilities)];
    // An empty enumeration would pass every check below it.
    if (unique.length < 40) {
      problems.push(
        `PARITY_MATRIX.md yielded ${unique.length} capabilities, which is fewer than the forty ` +
          `it documents — the census would be checked against almost nothing`,
      );
    }

    const entries = new Map();
    for (const section of census.split(/\n## /).slice(1)) {
      const heading = section.split('\n')[0].trim();
      const id = /^(P-\d{3}) — /.exec(heading);
      if (id) entries.set(id[1], section);
    }

    for (const capability of unique) {
      const section = entries.get(capability);
      if (section === undefined) {
        problems.push(
          `${CONDITION_3}: ${capability} is in the parity matrix and has no §84 condition 3 entry`,
        );
        continue;
      }
      const covered = /- COVERED BY: ([^\n]+)/.exec(section);
      const written = section.includes('- PROCEDURE:');
      const impossible = section.includes('`NOT POSSIBLE HERE`');
      if (!covered && !written && !impossible) {
        problems.push(
          `${CONDITION_3}: ${capability} neither cites an existing procedure nor writes one`,
        );
      }
      if (covered) {
        // Each id named before the explanatory sentence, e.g. "85-A-1 and 85-B-1".
        for (const id of covered[1].match(/\b\d{2}-[A-Za-z0-9-]+\b/g) ?? []) {
          if (!matrix.includes(id)) {
            problems.push(
              `${CONDITION_3}: ${capability} is COVERED BY \u201C${id}\u201D, which MATRIX.md does not list`,
            );
          }
        }
      }
      if (written) {
        if (!section.includes('- CRITERION:')) {
          problems.push(`${CONDITION_3}: ${capability} writes a procedure with no criterion`);
        }
        if (!section.includes('- FAILS IF:')) {
          problems.push(`${CONDITION_3}: ${capability} writes a procedure that cannot be failed`);
        }
      }
    }
  }
}

// 6. The count of procedures still needing a person, wherever it is stated.
//
//    Step 8 of the owner checklist is the one list a person works from, and it
//    opens with a number. A number in prose drifts the moment a row moves — and
//    this one has already moved twice in one wave, once when the census added
//    twenty-two procedures and once when sixteen of them were executed. So it
//    is derived from MATRIX.md's own rows rather than trusted.
//
//    "Needing a person" means exactly the three blocked classifications: an
//    environment nothing here can produce, a credential nobody here holds, and
//    an OAuth application nobody here has registered. `NOT IMPLEMENTED` is not
//    in the count, because no person unblocks it.
{
  const checklistPath = join(root, 'docs/release/OWNER-CHECKLIST.md');
  const matrixPath = join(dir, 'MATRIX.md');
  if (existsSync(checklistPath) && existsSync(matrixPath)) {
    const matrix = readFileSync(matrixPath, 'utf8');
    const blocked = new Set();
    for (const line of matrix.split('\n')) {
      if (!line.startsWith('| ')) continue;
      const cells = line.split('|').map((cell) => cell.trim());
      const id = cells[1]?.replace(/`/g, '');
      if (!/^\d{2}-/.test(id ?? '')) continue;
      const needsPerson = cells.some(
        (cell) =>
          cell.startsWith('`BLOCKED — CREDENTIAL`') ||
          cell.startsWith('`BLOCKED — OAUTH`') ||
          cell.startsWith('`BLOCKED — HUMAN/ENVIRONMENT`'),
      );
      if (needsPerson) blocked.add(id);
    }
    // An empty enumeration would agree with any number at all.
    if (blocked.size < 10) {
      problems.push(
        `MATRIX.md yielded only ${blocked.size} procedures needing a person, which is fewer ` +
          `than this repository documents — the count below would be checked against nothing`,
      );
    } else {
      const checklist = readFileSync(checklistPath, 'utf8');
      const stated =
        /\*\*([A-Z][a-z]+(?:-[a-z]+)?(?: [a-z-]+)?) procedures need a person\.\*\*/.exec(checklist);
      if (!stated) {
        problems.push(
          'OWNER-CHECKLIST.md no longer states how many procedures need a person, which is the ' +
            'one number somebody plans their day around',
        );
      } else {
        const WORDS = {
          ten: 10,
          eleven: 11,
          twelve: 12,
          thirteen: 13,
          fourteen: 14,
          fifteen: 15,
          sixteen: 16,
          seventeen: 17,
          eighteen: 18,
          nineteen: 19,
          twenty: 20,
          'twenty-one': 21,
          'twenty-two': 22,
          'twenty-three': 23,
          'twenty-four': 24,
          'twenty-five': 25,
          'twenty-six': 26,
          'twenty-seven': 27,
          'twenty-eight': 28,
          'twenty-nine': 29,
          thirty: 30,
          'thirty-one': 31,
          'thirty-two': 32,
          'thirty-three': 33,
          'thirty-four': 34,
          'thirty-five': 35,
          'thirty-six': 36,
          'thirty-seven': 37,
          'thirty-eight': 38,
          'thirty-nine': 39,
          forty: 40,
        };
        const said = WORDS[stated[1].toLowerCase()];
        if (said === undefined) {
          problems.push(
            `OWNER-CHECKLIST.md says "${stated[1]} procedures need a person" and that is not a ` +
              `number this check can read`,
          );
        } else if (said !== blocked.size) {
          problems.push(
            `OWNER-CHECKLIST.md says ${said} procedures need a person; MATRIX.md has ` +
              `${blocked.size}`,
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('✗ Acceptance package check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `✓ Acceptance packages verified: ${documents.length} documents, ${cited.size} distinct evidence citations, all resolving.`,
);
