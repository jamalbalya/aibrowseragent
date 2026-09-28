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
const ITEM_HEADING = { 'docs/THREAT_MODEL.md': /^T-\d+ — / };

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

if (problems.length > 0) {
  console.error('✗ Acceptance package check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `✓ Acceptance packages verified: ${documents.length} documents, ${cited.size} distinct evidence citations, all resolving.`,
);
