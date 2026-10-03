/**
 * TEST-SECURITY-032 — what the repository is allowed to say about being
 * published, and what the release artifact is allowed to contain.
 *
 * Two different failures, both of which this repository has a standing rule
 * against and neither of which any other test would notice.
 *
 * The first is a claim. "Available on the Chrome Web Store" is a sentence
 * somebody writes while a submission is *planned*, and it survives into a
 * README long after anyone remembers it was aspirational. It costs nothing to
 * write and is indistinguishable from a fact once written, which is exactly
 * the shape of statement worth testing rather than trusting. A reader
 * checking whether this extension is published has no way to tell a hopeful
 * sentence from a true one; a failing test does.
 *
 * The second is the artifact. A recorded digest is only meaningful if the
 * packaging is deterministic, and the three properties that make it so —
 * sorted entries, fixed timestamps, fixed compression with no extra fields —
 * are each one line that a well-meaning edit could remove without any other
 * check noticing. The archive would still be valid. It would just stop being
 * the same archive twice, and the digest in the documentation would quietly
 * become a description of one build run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
// @ts-expect-error — a build script, plain JS with JSDoc types, imported here so
// the rule is exercised rather than read.
import { checkWebAccessibleResources } from '../../scripts/release-rules.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

/** Every markdown file that a reader might take as a statement of fact. */
function documents(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(root, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const relative = `${dir}/${entry}`;
    if (statSync(join(root, relative)).isDirectory()) {
      // The specification is supplied verbatim and is not this repository's
      // claim to make or to edit.
      if (relative.endsWith('/spec')) continue;
      out.push(...documents(relative));
    } else if (entry.endsWith('.md')) {
      out.push(relative);
    }
  }
  return out;
}

import { API_PROVIDER_IDS } from '@/providers/registry/api-providers';

const MARKDOWN = ['README.md', 'PARITY_MATRIX.md', 'CHANGELOG.md', ...documents('docs')];

/** The version this tree builds, which is not the version that is published. */
const PREPARED = JSON.parse(read('package.json')).version as string;
/** The version on the Chrome Web Store, verified by reading the listing. */
const PUBLISHED = '0.1.0';
/** The item id the listing is served at, supplied by the account owner. */
const ITEM_ID = 'hlhcfmlgoojeoapmijopmicdmmhealhl';

describe('the repository does not claim a publication that has not happened', () => {
  /**
   * Phrases that assert the extension is obtainable. Written as whole claims
   * rather than as the words "Chrome Web Store", because this repository has
   * a great deal to say about the store truthfully — a checklist, a set of
   * permission justifications, and several statements that it is *not*
   * published. Forbidding the subject would forbid the honesty.
   */
  const CLAIMS = [
    /available (?:on|in|from) the chrome web store/i,
    /published (?:on|to|in) the chrome web store/i,
    /live (?:on|in) the chrome web store/i,
    /listed (?:on|in) the chrome web store/i,
    /submitted (?:for review|to the chrome web store)/i,
    /under review/i,
    /install (?:it |this |the extension )?from the chrome web store/i,
    /get it (?:on|from) the chrome web store/i,
    /download (?:it |this )?from the chrome web store/i,
  ];

  /**
   * **This test inverted on 4 October 2026, and the reason matters.**
   *
   * It used to forbid every one of the claims above anywhere, because none of
   * them was true. Then `0.1.0` was published, and a blanket ban would have
   * forced the documentation to stay silent about a fact a reader most needs:
   * there is a live listing, and the build in this tree is not what is on it.
   *
   * So the ban is now aimed at the claim that is still false. `0.1.0` is
   * published and may be described as such. The **prepared** version is not,
   * and no line may put it in the same sentence as availability or submission
   * language. That is the actual confusion to prevent — a reader concluding
   * that what they can install is what this tree builds — and it is a sharper
   * rule than the old one, which could not tell the two apart at all.
   *
   * `CHANGELOG.md` is now in the scanned set. It was outside every guard in
   * this file until the parity counts drifted in it, and it is the file with
   * by far the most publication language in it, so leaving it out was the
   * weakest point of this suite.
   */
  it.each(MARKDOWN)('%s does not claim the prepared version is on the store', (file) => {
    const text = read(file);
    // Line by line, because a document that legitimately discusses both
    // versions would trip a whole-file test for no reason.
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.includes(PREPARED)) continue;
      for (const claim of CLAIMS) {
        expect(
          claim.test(line),
          `${file}:${index + 1} puts the prepared version ${PREPARED} beside "${claim.source}"`,
        ).toBe(false);
      }
    }
  });

  it('states which version is published and which is merely prepared', () => {
    // The absence of a false claim is not the presence of a true one, which is
    // this suite's oldest rule. Two versions now exist and a reader has to be
    // able to tell them apart without inferring anything.
    const changelog = read('CHANGELOG.md');
    expect(changelog, 'CHANGELOG.md does not name the prepared version').toContain(PREPARED);
    expect(changelog, 'CHANGELOG.md does not name the published version').toContain(PUBLISHED);
    // The prepared version says, in its own section, that it is not out.
    const prepared = changelog.slice(
      changelog.indexOf(`## ${PREPARED}`),
      changelog.indexOf(`## ${PUBLISHED}`),
    );
    expect(prepared.length, `no ## ${PREPARED} section above ## ${PUBLISHED}`).toBeGreaterThan(200);
    expect(prepared).toMatch(/not been uploaded, submitted or published/i);
    // And the published one is identified well enough to be checked by a
    // reader, rather than asserted. The item id is the whole point: without it
    // nobody can confirm the claim.
    expect(changelog, 'the published listing is not identified').toContain(ITEM_ID);
  });

  it('says plainly, in the release documentation, what the store state is', () => {
    // The absence of a false claim is not the presence of a true one. A
    // reader looking for the answer should find it stated, not inferred from
    // nothing being said.
    //
    // The true statement changed when a submission was actually made, so this
    // case changed with it. What it must not become is weaker: the three facts
    // below are each a thing a reader could otherwise get wrong, and the third
    // is the one that is easiest to state carelessly.
    const store = read('docs/release/chrome-web-store-submission-checklist.md');
    // 1. Which version is published, named rather than implied.
    expect(store).toContain(`\`${PUBLISHED}\` is published`);
    // 2. And which one is not. This replaces the old "not approved and not
    //    published" assertion: that sentence became false when the item was
    //    published, but the risk it guarded against did not go away — it moved
    //    to the next version.
    expect(store).toMatch(/nothing about `0\.\d+\.\d+` has been uploaded, submitted or published/i);
    // 3. The published artifact is not the artifact this repository builds
    //    today — engineering continues and the digest is a function of the
    //    source tree.
    expect(store).toContain('not the artifact this repository builds');
    // 4. The listing is identified, so a reader can check the claim instead of
    //    taking it. This is the assertion that replaces "cannot observe the
    //    store": the repository now can, because it was given the item id, and
    //    a status that is checkable must say how.
    expect(store).toContain(ITEM_ID);
    expect(store).toMatch(/verified rather than reported/i);
    expect(store).toContain('ACCOUNT OWNER ACTION REQUIRED');
    // And the thing that cannot be done here is named as such rather than
    // left as an empty checkbox somebody might tick.
    expect(store).toContain('Developer Agreement');
  });

  it('states the two-artifact distinction where the artifact is described', () => {
    // The specific way this documentation could now become false without any
    // sentence in it being wrong: a reader who finds a digest beside the words
    // "submitted" will conclude that digest is under review.
    const release = read('docs/release/README.md');
    expect(release).toContain('Two artifacts, and which one is which');
    expect(release).toContain('Published artifact');
    expect(release).toContain('Current engineering artifact');
    expect(release).toMatch(/has \*{0,2}not been uploaded/i);
    // No digest anywhere in the submission section.
    //
    // This is narrower than "no digest in this file" on purpose, because two
    // digests in it are legitimate and both say so where they appear: a
    // reproducibility measurement taken at a named historical commit, and the
    // `package-lock.json` hash that identifies the toolchain. Forbidding the
    // subject would forbid the honesty, the same way the store-availability
    // patterns above are written as whole claims rather than as the words
    // "Chrome Web Store".
    //
    // What must never appear is a digest *beside submission language*, because
    // a reader who finds one there will conclude it is the archive under
    // review — and it would be stale the next time `src/` changed, which is the
    // defect this document already had three times.
    const section = release.slice(
      release.indexOf('## What has and has not happened'),
      release.indexOf('\n## ', release.indexOf('## What has and has not happened') + 4),
    );
    expect(section.length).toBeGreaterThan(200);
    // The section states both versions and their states. It used to assert
    // 'Pending Review'; that is simply no longer what is true.
    expect(section).toContain(PUBLISHED);
    expect(section).toContain(PREPARED);
    expect(section).toMatch(/is published/i);
    expect(section, 'a digest appears beside submission language').not.toMatch(/\b[0-9a-f]{64}\b/);
    // And the rule itself is still written down, so the next person knows why.
    expect(release).toContain('No digest is written into this document any more');
  });

  it('keeps the two halves of the checklist apart', () => {
    const store = read('docs/release/chrome-web-store-submission-checklist.md');
    const complete = store.indexOf('## REPOSITORY COMPLETE');
    const owner = store.indexOf('## ACCOUNT OWNER ACTION REQUIRED');
    expect(complete).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(complete);
  });
});

describe('a release build ships nothing that only a test needed', () => {
  const BUILD = read('scripts/build.mjs');
  const VALIDATOR = read('scripts/validate-release.mjs');

  it('keeps the loopback matches in the development manifest, where the suite needs them', () => {
    // Stated as the starting point, so the narrowing below is visibly a
    // change rather than a description of something that was already true.
    const manifest = JSON.parse(read('public/manifest.json')) as {
      web_accessible_resources: { resources: string[]; matches: string[] }[];
    };
    const entry = manifest.web_accessible_resources[0];
    expect(entry?.resources).toEqual(['oauth/callback.html']);
    expect(entry?.matches).toContain('https://github.com/*');
    expect(entry?.matches).toContain('http://127.0.0.1/*');
  });

  it('narrows them to https origins when the build is a release', () => {
    // The mock authorization server runs on loopback, so the end-to-end suite
    // genuinely needs the wider set. A shipped build does not, and leaving it
    // there would let any page served from loopback load an extension page —
    // and confirm the extension is installed.
    expect(BUILD).toContain("process.env.RELEASE_BUILD === '1'");
    expect(BUILD).toContain('web_accessible_resources');
    expect(BUILD).toContain("match.startsWith('https://')");
  });

  it('refuses to produce an entry that matches nothing', () => {
    // Narrowing to the empty set would be a manifest Chrome rejects, and
    // failing at build time says so in one line instead.
    expect(BUILD).toContain('left no match for');
  });

  it('gates the narrowing by running the rule, not by reading its source', () => {
    // An earlier version of this asserted the rule's text appeared in the
    // validator, and a mutation walked through it: two rules in that file
    // open with the same words, so removing one left the assertion satisfied
    // by the other. The rule is now a function, and the question asked of it
    // is what it says about a hostile manifest.
    expect(VALIDATOR).toContain('checkWebAccessibleResources(manifest)');

    const loopback = checkWebAccessibleResources({
      web_accessible_resources: [
        {
          resources: ['oauth/callback.html'],
          matches: ['https://github.com/*', 'http://127.0.0.1/*'],
        },
      ],
    });
    expect(loopback).toHaveLength(1);
    expect(loopback[0]).toContain('http://127.0.0.1/*');
    expect(loopback[0]).toContain('development affordance');
  });

  it('accepts the manifest a release build actually produces', () => {
    // The positive control. A rule that refused everything would satisfy the
    // case above and be useless.
    expect(
      checkWebAccessibleResources({
        web_accessible_resources: [
          { resources: ['oauth/callback.html'], matches: ['https://github.com/*'] },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses an entry that reaches every site, however it is spelled', () => {
    for (const match of ['<all_urls>', 'https://*/*', 'http://*/*']) {
      const failures = checkWebAccessibleResources({
        web_accessible_resources: [{ resources: ['oauth/callback.html'], matches: [match] }],
      });
      expect(failures, match).toHaveLength(1);
      expect(failures[0], match).toContain('every site');
    }
  });

  it('refuses an entry that matches nothing, which Chrome would reject anyway', () => {
    const failures = checkWebAccessibleResources({
      web_accessible_resources: [{ resources: ['oauth/callback.html'], matches: [] }],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('matches no origin at all');
  });
});

describe('the release artifact is packaged deterministically', () => {
  const PACKAGER = read('scripts/package-release.mjs');

  it('fixes every timestamp rather than recording the build time', () => {
    // A real mtime says when the build machine ran, which is not a property
    // of the release and is the single largest source of ZIP nondeterminism.
    expect(PACKAGER).toMatch(/const DOS_TIME = 0;/);
    expect(PACKAGER).toMatch(/const DOS_DATE = 33;/);
    expect(PACKAGER).toContain('writeUInt16LE(DOS_TIME');
    expect(PACKAGER).toContain('writeUInt16LE(DOS_DATE');
    // And no path takes a time from the filesystem or the clock.
    expect(PACKAGER).not.toContain('Date.now()');
    expect(PACKAGER).not.toContain('.mtime');
  });

  it('orders entries by path rather than by whatever the filesystem returned', () => {
    // `readdirSync` order is not promised to be stable across filesystems, so
    // sorting happens twice on purpose: while walking, and again over the
    // collected list.
    expect(PACKAGER).toContain('a.name < b.name ? -1 : a.name > b.name ? 1 : 0');
    const collect = PACKAGER.slice(PACKAGER.indexOf('function collect()'));
    expect(collect).toContain('.sort(');
  });

  it('writes no extra field and no archive comment', () => {
    // Both are free-form regions that a packer may fill with anything,
    // including a timestamp. Zero-length is the only reproducible choice.
    expect(PACKAGER).toContain('writeUInt16LE(0, 28); // no extra field');
    expect(PACKAGER).toContain('writeUInt16LE(0, 20); // no archive comment');
  });

  it('can check its own determinism, so the pinning cannot regress silently', () => {
    expect(PACKAGER).toContain('--verify');
    expect(PACKAGER).toContain('Archive is not deterministic');
    // The release pipeline runs the verifying form, not the bare one.
    const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts.scripts['release']).toContain('package-release.mjs --verify');
  });

  it('adds no dependency to produce the one file that reaches users', () => {
    // Everything the packer needs is in Node itself.
    expect(PACKAGER).toContain("from 'node:zlib'");
    expect(PACKAGER).toContain("from 'node:crypto'");
    expect(PACKAGER).not.toMatch(/from '(?!node:)[a-z@]/);
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(name, `${name} looks like a packaging dependency`).not.toMatch(
        /^(archiver|jszip|adm-zip|zip-a-folder|yazl)$/,
      );
    }
  });

  it('refuses to package something that is not an extension', () => {
    // An empty or manifest-less dist would otherwise produce a valid archive
    // of the wrong thing, with a digest recorded for it.
    expect(PACKAGER).toContain('holds no manifest.json, so it is not an extension package');
    expect(PACKAGER).toContain('dist/ is empty');
  });

  it('says in its own output that nothing has been published', () => {
    expect(PACKAGER).toContain('has NOT been submitted or published anywhere');
  });
});

describe('the parity records know what the build actually registers', () => {
  /**
   * A provider added without reaching the parity records is a record that
   * understates the product, and this repository has just had one.
   *
   * `nine-router` was registered in `ccb113e` and four commits later neither
   * `PARITY_MATRIX.md` nor `parity-evidence.json` mentioned it: the matrix still
   * said "Three adapters ship and all three pass one shared conformance suite",
   * and P-033-C5 still asserted "what has not happened is a request to a
   * commercial endpoint" after one had. Both were true when written, and both
   * had quietly stopped being true — which is the failure mode this file exists
   * to catch, in the direction nobody watches: a claim that is too *small*.
   *
   * The registry is the source of truth, read rather than restated.
   */
  const PARITY = read('PARITY_MATRIX.md');
  const EVIDENCE = read('parity-evidence.json');

  it('makes the changelog state the parity counts the matrix actually holds', () => {
    // **The one claim document outside every guard in this file.** `MARKDOWN`
    // above sweeps `README.md`, `PARITY_MATRIX.md` and everything under
    // `docs/`; `CHANGELOG.md` is at the repository root, so nothing read it —
    // and it drifted. It said *"seven capabilities are PARTIAL and three are
    // NOT-STARTED"* long after the matrix had moved to three and one,
    // overstating the product's gaps by a wide margin in the one file a reader
    // reaches for to find out what shipped.
    //
    // Derived rather than restated, which is the whole point: the numbers come
    // out of the matrix table, so a capability changing status fails this test
    // instead of silently making a sentence false.
    // The last cell of the row, found by dropping the empties a leading and
    // trailing pipe produce. Taken positionally rather than by index so that
    // adding a column to the table does not quietly stop this working.
    const statusOf = (row: string): string | undefined => {
      const cells = row
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      return cells.at(-1);
    };
    const rows = PARITY.split('\n').filter((line) => /^\|\s*P-\d+\s*\|/.test(line));
    expect(rows.length, 'no capability rows found in PARITY_MATRIX.md').toBeGreaterThan(30);

    const partial = rows.filter((row) => statusOf(row) === 'PARTIAL').length;
    const notStarted = rows.filter((row) => statusOf(row) === 'NOT-STARTED').length;

    const WORDS = [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ];
    const changelog = read('CHANGELOG.md');
    const claim =
      /([A-Za-z]+) capabilit(?:y|ies) (?:is|are)\s+PARTIAL and ([A-Za-z]+) (?:is|are) NOT-STARTED/.exec(
        changelog,
      );
    expect(claim, 'CHANGELOG.md no longer states the parity counts').not.toBeNull();

    expect(WORDS.indexOf(claim![1]!.toLowerCase()), `CHANGELOG says "${claim![1]}" PARTIAL`).toBe(
      partial,
    );
    expect(
      WORDS.indexOf(claim![2]!.toLowerCase()),
      `CHANGELOG says "${claim![2]}" NOT-STARTED`,
    ).toBe(notStarted);

    // The same claim again, in digits, because the word-form check above is
    // what this guard was built for and it is not enough.
    //
    // On 4 October 2026 the CHANGELOG still read "30 PASS, 8 PARTIAL, 2
    // NOT-STARTED" two sections below a word-form sentence this guard was
    // keeping correct. The regex above matches "N capabilities are PARTIAL and
    // M are NOT-STARTED" and nothing else, so a numeric restatement was outside
    // every guard — the same hole, in the same file, that this test was added
    // to close. Any "<n> PASS, <n> PARTIAL, <n> NOT-STARTED" is now read too.
    const digits = /(\d+)\s+PASS,\s*(\d+)\s+PARTIAL,\s*(\d+)\s+NOT-STARTED/g;
    const numeric = [...changelog.matchAll(digits)];
    expect(
      numeric.length,
      'CHANGELOG.md states no numeric parity counts; if that is deliberate, delete this check ' +
        'rather than leaving it passing vacuously',
    ).toBeGreaterThan(0);
    const pass = rows.filter((row) => statusOf(row) === 'PASS').length;
    for (const match of numeric) {
      expect(Number(match[1]), `CHANGELOG says ${match[1]} PASS`).toBe(pass);
      expect(Number(match[2]), `CHANGELOG says ${match[2]} PARTIAL`).toBe(partial);
      expect(Number(match[3]), `CHANGELOG says ${match[3]} NOT-STARTED`).toBe(notStarted);
    }
  });

  it('names every registered provider in the parity matrix', () => {
    for (const id of API_PROVIDER_IDS) {
      expect(PARITY, `PARITY_MATRIX.md does not mention ${id}`).toContain(id);
    }
  });

  it('counts adapters the way the registry does, wherever it counts them', () => {
    // The specific stale sentence, generalised: any claim about how many
    // adapters *ship* or *pass the conformance suite* has to agree with the
    // registry. Claims about how many **vendor keys** the §85-F scenario needs
    // are a different statement and are deliberately not matched — 9Router is a
    // gateway the owner runs, not a fourth vendor, so "three vendor keys for
    // three adapters" remains the right requirement there.
    const words = ['one', 'two', 'three', 'four', 'five', 'six'];
    const expected = words[API_PROVIDER_IDS.length - 1];
    expect(expected, 'provider count outgrew this list').toBeDefined();
    // Guard the guard: an off-by-one here would compare against the wrong word
    // and fail for the right records.
    expect(words[3]).toBe('four');
    expect(API_PROVIDER_IDS.length).toBeGreaterThanOrEqual(4);

    for (const [label, raw] of [
      ['PARITY_MATRIX.md', PARITY],
      ['parity-evidence.json', EVIDENCE],
    ] as const) {
      // Struck-through text is superseded history, kept on purpose — the
      // roadmap item "~~At least three provider adapters passing the same
      // suite~~ **Done.**" is a record of what was once asked for, and
      // rewriting it would destroy the thing that makes it a record. Matching
      // it would forbid the honesty, the same way forbidding the words "Chrome
      // Web Store" would forbid the statements above that it is not published.
      const text = raw.replace(/~~[\s\S]*?~~/g, '');
      const claims = [
        ...text.matchAll(
          /\b(one|two|three|four|five|six)\b[^.\n]{0,40}?adapters?\s+(?:ship|pass)/gi,
        ),
        ...text.matchAll(/all\s+\b(one|two|three|four|five|six)\b\s+adapters/gi),
      ].map((match) => match[1]!.toLowerCase());
      for (const claim of claims) {
        expect(claim, `${label} claims ${claim} adapters; the registry has ${expected}`).toBe(
          expected,
        );
      }
    }
  });

  it('does not still say a commercial endpoint has never been reached', () => {
    // The clause's own note carried that sentence after it had stopped being
    // true. It is a factual claim about what has happened, so it belongs under
    // the same rule as every other claim in this suite.
    expect(EVIDENCE).not.toMatch(/has not happened is a request to a commercial endpoint/i);
    expect(PARITY).not.toMatch(/has \*\*not\*\* happened is a request to a commercial provider/i);
    // And the evidence that replaced it is cited, so the correction is
    // checkable rather than asserted.
    expect(EVIDENCE).toContain('nine-router-live.test.ts');
  });

  it('still says plainly what has not been reached', () => {
    // Correcting the stale half must not quietly drop the limit that remains:
    // the native vendor endpoints are unexercised and need keys nobody here
    // holds. A row that loses its blocker reads as complete.
    expect(EVIDENCE).toMatch(/native anthropic or gemini adapters/i);
    expect(EVIDENCE).toMatch(/api\.openai\.com directly/i);
    expect(PARITY).toMatch(/native\*{0,2} `?anthropic`?\s*\n?\s*or `?gemini`?/i);
  });
});
