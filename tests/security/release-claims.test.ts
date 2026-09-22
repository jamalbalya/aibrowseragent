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

const MARKDOWN = ['README.md', 'PARITY_MATRIX.md', ...documents('docs')];

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
    /install (?:it |this |the extension )?from the chrome web store/i,
    /get it (?:on|from) the chrome web store/i,
    /download (?:it |this )?from the chrome web store/i,
    /our chrome web store listing/i,
  ];

  it.each(MARKDOWN)('%s claims no store availability', (file) => {
    const text = read(file);
    for (const claim of CLAIMS) {
      expect(claim.test(text), `${file} matches ${claim}`).toBe(false);
    }
  });

  it('says plainly, in the release documentation, that it has not been submitted', () => {
    // The absence of a false claim is not the presence of a true one. A
    // reader looking for the answer should find it stated, not inferred from
    // nothing being said.
    const store = read('docs/release/chrome-web-store-submission-checklist.md');
    expect(store).toContain('has not been submitted and is not published');
    expect(store).toContain('ACCOUNT OWNER ACTION REQUIRED');
    // And the thing that cannot be done here is named as such rather than
    // left as an empty checkbox somebody might tick.
    expect(store).toContain('Developer Agreement');
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
