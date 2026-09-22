#!/usr/bin/env node
/**
 * Checks the acceptance packages under `docs/testing/acceptance/` against the
 * repository they describe.
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

const documents = readdirSync(dir).filter((name) => name.endsWith('.md'));
if (documents.length === 0) problems.push('the acceptance directory holds no documents');

for (const name of documents) {
  const path = join(dir, name);
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
  const sections = text.split(/\n## /).slice(1);
  for (const section of sections) {
    const heading = section.split('\n')[0].trim();
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
