/**
 * TEST-SECURITY-079 — the privacy documents agree with the manifest.
 *
 * ## The failure this exists to prevent, which already happened
 *
 * `docs/release/privacy-policy-outline.md` is the document that says what the
 * **hosted** privacy policy must state — the one a Chrome Web Store reviewer
 * reads. Under "What is never accessed" it listed:
 *
 * > The user's identity — `chrome.identity` is genuinely unavailable
 *
 * That was true when it was written. Then `identity` was declared as an
 * optional permission, so that `launchWebAuthFlow` could receive Google's
 * redirect, and the sentence became false — in the document an owner publishes
 * **from**. Publishing it would have put a false statement in a legal document
 * and on a store disclosure form, which the outline's own opening paragraph
 * warns against in the strongest terms it has.
 *
 * Nothing would have caught it. `release-claims.test.ts` guards claims about
 * being *published*; `public-copy-connectors.test.ts` guards which connectors
 * exist. No test compared a privacy claim against the manifest.
 *
 * ## What is asserted
 *
 * The **negative** claims, because those are the dangerous ones. A privacy
 * document may say a permission is absent only when it really is absent — from
 * `permissions` *and* from `optional_permissions`, since an optional permission
 * is one the extension can hold. A document may say whatever it likes about a
 * permission it does declare; that is prose, and prose is the author's.
 *
 * And the other direction for the one permission whose presence is itself a
 * disclosure: `identity` is declared, so both documents have to mention it. A
 * permission a user can be asked to grant, undisclosed, is the gap this pass
 * closed.
 *
 * ## What is deliberately not asserted
 *
 * The wording. These are documents written for people, and pinning sentences
 * makes every edit a test failure and teaches everyone to delete the test.
 * What is pinned is the thing a reader would be misled about.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

interface Manifest {
  readonly permissions?: readonly string[];
  readonly optional_permissions?: readonly string[];
  readonly oauth2?: unknown;
}

const manifest = JSON.parse(read('public/manifest.json')) as Manifest;

/**
 * Every permission this extension can hold.
 *
 * Required and optional together, deliberately. An optional permission is one
 * the user can be asked for and can grant, so a document calling it absent is
 * wrong in exactly the way that matters — and splitting the two is how the
 * `identity` sentence survived being read several times.
 */
const HELD: readonly string[] = [
  ...(manifest.permissions ?? []),
  ...(manifest.optional_permissions ?? []),
];

/** The documents a reader or a reviewer takes as statements about privacy. */
const PRIVACY_DOCS = [
  'docs/PRIVACY.md',
  'docs/release/privacy-policy-outline.md',
  'docs/release/data-flows.md',
] as const;

/**
 * Phrasings that assert a permission is absent.
 *
 * Narrow and literal on purpose. A broad pattern over prose produces false
 * positives on sentences like "the `identity` permission is optional", which
 * is a correct statement this test must not break.
 */
function claimsAbsent(raw: string, permission: string): boolean {
  // Hard-wrapped prose puts line breaks inside these phrases, so the text is
  // normalised to single spaces first. Without this the guard reads clean on a
  // document that plainly makes the claim.
  const text = raw.replace(/\s+/g, ' ');
  const patterns = [
    `does not request \`${permission}\``,
    `does not request the \`${permission}\``,
    `the \`${permission}\` permission is not requested`,
    `\`${permission}\` is genuinely unavailable`,
    `\`chrome.${permission}\` is genuinely unavailable`,
    `no \`${permission}\` permission`,
  ];
  const lowered = text.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern.toLowerCase()));
}

describe('01 — no privacy document calls a held permission absent', () => {
  it.each(PRIVACY_DOCS)('%s', (relative) => {
    const text = read(relative);
    for (const permission of HELD) {
      expect(
        claimsAbsent(text, permission),
        `${relative} says \`${permission}\` is not requested, and the manifest declares it`,
      ).toBe(false);
    }
  });

  it('still allows a true absence to be claimed, so the guard is not vacuous', () => {
    // These three are the load-bearing absences the privacy documents rest on,
    // and they must stay claimable. A guard that forbade every negative
    // statement would be worse than none: the honest strong claims are the
    // negative ones.
    for (const absent of ['cookies', 'history', 'bookmarks']) {
      expect(HELD, absent).not.toContain(absent);
    }
    // Whitespace-normalised before matching, because these documents are
    // hard-wrapped: `docs/PRIVACY.md` says "not request the `cookies`
    // permission" with a line break inside the phrase, and a guard that could
    // not see it would be a guard that never fires on the real text.
    const privacy = read('docs/PRIVACY.md');
    expect(claimsAbsent(privacy, 'cookies')).toBe(true);
  });

  it('would catch the sentence that was actually wrong', () => {
    // The guard's own discrimination, checked against the real text rather
    // than argued: this is what the outline said, verbatim, and `identity` is
    // declared.
    expect(
      claimsAbsent('The user’s identity — `chrome.identity` is genuinely unavailable', 'identity'),
    ).toBe(true);
    expect(HELD).toContain('identity');
  });
});

describe('02 — a permission a user can be asked to grant is disclosed', () => {
  it('names every optional permission in the privacy policy', () => {
    // An optional permission is a prompt the user will see. One that appears
    // in a Chrome dialog and nowhere in the policy is the gap this closed.
    const privacy = read('docs/PRIVACY.md');
    for (const permission of manifest.optional_permissions ?? []) {
      expect(privacy, `docs/PRIVACY.md does not mention \`${permission}\``).toContain(permission);
    }
  });

  it('says that each one is optional, not merely that it exists', () => {
    // Listing `identity` without saying it is optional and declinable would be
    // a worse disclosure than useful: the reader would reasonably assume it is
    // granted at install.
    const privacy = read('docs/PRIVACY.md');
    for (const permission of manifest.optional_permissions ?? []) {
      const line = privacy
        .split('\n')
        .find((candidate) => candidate.includes(permission) && candidate.includes('|'));
      expect(line, `no permission-table row for \`${permission}\``).toBeDefined();
      expect(line!.toLowerCase()).toContain('optional');
    }
  });

  it('tells the outline that the identity permission has to be described', () => {
    // The outline is what the hosted policy is written from, so the
    // requirement has to be visible there and not only in this repository's
    // own account of the code.
    const outline = read('docs/release/privacy-policy-outline.md');
    expect(outline).toContain('identity');
    expect(outline.toLowerCase()).toContain('optional');
    // And the mitigation that makes the permission acceptable, since a policy
    // that names the permission without it invites the obvious worry.
    expect(outline).toContain('oauth2');
    expect(outline.toLowerCase()).toMatch(/getauthtoken/);
  });
});

describe('02b — every permission has a justification to submit', () => {
  it('justifies each one the manifest declares, required or optional', () => {
    // The Chrome Web Store asks for a justification per permission, and
    // `store-listing.md` holds the text the owner submits. `identity` was
    // added to the manifest and to the listing's prose and **not** to this
    // table — so the one permission most likely to draw a question had no
    // prepared answer. The count is what makes that visible.
    const listing = read('docs/release/store-listing.md');
    const table = listing.slice(
      listing.indexOf('| Permission'),
      listing.indexOf('### If review asks about'),
    );
    for (const permission of HELD) {
      expect(table, `no justification row for \`${permission}\``).toContain(`\`${permission}\``);
    }
  });

  it('marks an optional permission as optional in that table', () => {
    const listing = read('docs/release/store-listing.md');
    for (const permission of manifest.optional_permissions ?? []) {
      const row = listing.split('\n').find((line) => line.startsWith(`| \`${permission}\``));
      expect(row, `no row starting with \`${permission}\``).toBeDefined();
      expect(row!).toContain('(optional)');
    }
  });
});

describe('03 — the manifest keeps the property the disclosure depends on', () => {
  it('declares no oauth2 key, which is what keeps getAuthToken unusable', () => {
    // Both privacy documents now rest on this, so it is asserted here as well
    // as in the places that already check it. If the key ever appears, these
    // documents become wrong and this is one of the tests that says so.
    expect(manifest.oauth2).toBeUndefined();
  });

  it('keeps identity optional rather than required', () => {
    expect(manifest.permissions ?? []).not.toContain('identity');
    expect(manifest.optional_permissions ?? []).toContain('identity');
  });
});

describe('04 — the outline points at where the policy is actually published', () => {
  it('names the repository, the file, and the date that must move', () => {
    // The section used to offer generic choices — "GitHub Pages", "any page you
    // control" — which was right before one was chosen and no help afterwards.
    // An owner updating a published legal document should not have to
    // rediscover which repository renders it.
    const outline = read('docs/release/privacy-policy-outline.md');
    expect(outline).toContain('about-jamal');
    expect(outline).toContain('src/lib/content/privacy.ts');
    expect(outline).toContain('EFFECTIVE_DATE');
    // And the step that distinguishes "changed" from "published".
    expect(outline.toLowerCase()).toContain('verify the live page');
  });

  it('agrees with every other document about the policy URL', () => {
    // One URL, in several documents, and a reviewer follows whichever they
    // find. A divergence here is a listing pointing somewhere nobody meant.
    const url = 'https://about.jamal-balya.workers.dev/en/privacy';
    for (const relative of [
      'docs/PRIVACY.md',
      'docs/release/privacy-policy-outline.md',
      'docs/release/OWNER-CHECKLIST.md',
      'docs/release/chrome-web-store-submission-checklist.md',
    ]) {
      expect(read(relative), relative).toContain(url);
    }
  });
});
