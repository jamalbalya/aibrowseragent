/**
 * TEST-COPY-001 — the public copy names the connectors that actually exist.
 *
 * ## Why this exists
 *
 * Three documents a user or a reviewer reads — the store listing, the privacy
 * policy and the data-flow table — all said the build had **one** connector,
 * GitHub, and that it was connected by an OAuth grant. By then it had three,
 * none of them using OAuth. The listing went further and said *"There is no
 * Jira, Confluence, Figma or Google Sheets integration"*, which was a
 * specific, confident claim about two things that had shipped.
 *
 * Nobody had been careless. `check-parity.mjs` already guards the one number
 * in that copy that anybody thought to guard — *"N of 40 capabilities PASS"* —
 * and the connector sentences had no guard at all, so they aged quietly while
 * everything around them was checked.
 *
 * ## What is asserted, and what is deliberately not
 *
 * The **set** of connectors, derived from the descriptor factories rather than
 * from a list in this file: a connector added without a mention in the public
 * copy fails here, and so does copy naming one that does not exist. That is
 * the staleness that actually happened, in both directions.
 *
 * Not the prose. These documents are written for people and their wording is a
 * judgement; pinning sentences would make every edit a test failure and teach
 * everyone to delete the test. What is pinned is the thing a reader would be
 * misled about.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { githubDescriptor } from '@/connectors/adapters/github';
import { figmaDescriptor } from '@/connectors/adapters/figma';
import { jiraDescriptor } from '@/connectors/adapters/jira';

/**
 * Every connector this build ships, by display name.
 *
 * From the factories, so adding a fourth and forgetting the copy is a failure
 * rather than a silent inaccuracy. The redirect URI is a required argument for
 * GitHub's and is irrelevant here.
 */
const CONNECTORS = [
  // `authKind` as the shipped worker configures it. The factory defaults to
  // `oauth2`, because the OAuth configuration on the descriptor is correct and
  // is what a deployment holding a client secret elsewhere would use — but no
  // such deployment exists, so the shipped build passes `api_token`. That the
  // *extension* reports it is asserted where it can be:
  // `connector.spec.ts :: the connector is registered, and says how it can be
  // connected`. This file is about the copy.
  githubDescriptor({ redirectUri: 'https://example.test/callback', authKind: 'api_token' }),
  figmaDescriptor(),
  jiraDescriptor(),
];

/** Services the copy says are absent. Named here, and checked against reality. */
const DISCLAIMED = ['Confluence', 'Google Sheets'];

const PUBLIC_COPY = [
  'docs/release/store-listing.md',
  'docs/PRIVACY.md',
  'docs/release/data-flows.md',
] as const;

function copy(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('every shipped connector is named in the public copy', () => {
  it('names all three, in every document a reader reaches', () => {
    expect(CONNECTORS).toHaveLength(3);
    for (const path of PUBLIC_COPY) {
      const text = copy(path);
      for (const descriptor of CONNECTORS) {
        expect(text, `${path} does not name ${descriptor.displayName}`).toContain(
          descriptor.displayName,
        );
      }
    }
  });

  it('claims no connector that does not exist', () => {
    // The direction that produced the worst sentence: the listing said there
    // was no Jira or Figma integration, confidently, after both had shipped.
    const shipped = new Set(CONNECTORS.map((descriptor) => descriptor.displayName));
    for (const absent of DISCLAIMED) {
      expect(shipped.has(absent), `${absent} is disclaimed but is shipped`).toBe(false);
    }
  });

  it('does not say there is only one connector', () => {
    // The exact stale phrasing, and the shapes it would most likely come back
    // in. Narrow on purpose: this is the sentence that was wrong, not a ban on
    // the word "one".
    for (const path of PUBLIC_COPY) {
      const text = copy(path).toLowerCase();
      for (const stale of [
        'only one connector',
        'one connector only',
        'a single connector',
        'the only connector',
      ]) {
        expect(text, `${path} still says "${stale}"`).not.toContain(stale);
      }
    }
  });
});

describe('the copy describes how a connector is actually connected', () => {
  it('says a token, not an OAuth authorization, because that is what happens', () => {
    // All three use a credential the user creates in their own account. The
    // data-flow table described "access and refresh tokens" obtained "after
    // the user authorizes", which was a different mechanism entirely — and no
    // connector holds a refresh token, because none uses a flow that issues
    // one.
    // Every one of them, as shipped. Figma and Jira have no other mode; see
    // the note on `CONNECTORS` for GitHub.
    for (const descriptor of CONNECTORS) {
      expect(descriptor.authKind, descriptor.displayName).toBe('api_token');
    }
    // And the two that could not be anything else, asserted without passing
    // an argument — so this is a fact about them rather than about the call.
    expect(figmaDescriptor().authKind).toBe('api_token');
    expect(jiraDescriptor().authKind).toBe('api_token');

    const flows = copy('docs/release/data-flows.md');
    expect(flows).not.toContain('Connector OAuth tokens');
    expect(flows).not.toContain('the user completed an OAuth grant');

    const privacy = copy('docs/PRIVACY.md');
    expect(privacy.toLowerCase()).toMatch(/token you create in your own account/);
  });

  it('says which connectors are read-only, and they are', () => {
    // A reader deciding whether this is useful to them needs it, and it is a
    // consequence of the service reporting no scopes rather than a choice.
    const readOnly = CONNECTORS.filter((descriptor) =>
      descriptor.operations.every((operation) => operation.kind === 'read'),
    ).map((descriptor) => descriptor.displayName);
    expect(readOnly.sort()).toEqual(['Figma', 'Jira']);

    const listing = copy('docs/release/store-listing.md');
    for (const name of readOnly) {
      expect(listing, `the listing does not say ${name} is read-only`).toMatch(
        new RegExp(`${name}[^.]*read-only|read-only[^.]*${name}`, 'i'),
      );
    }
  });

  it('discloses the one destination that is not fixed in the build', () => {
    // Jira's origin comes from the user. A privacy document that listed only
    // fixed destinations would be describing a different extension.
    const siteBound = CONNECTORS.filter((descriptor) => descriptor.siteBinding !== undefined);
    expect(siteBound.map((descriptor) => descriptor.displayName)).toEqual(['Jira']);

    const flows = copy('docs/release/data-flows.md');
    expect(flows).toContain('atlassian.net');
    expect(flows.toLowerCase()).toMatch(/only that one|bound/);

    const privacy = copy('docs/PRIVACY.md');
    expect(privacy).toContain('atlassian.net');
  });

  it('does not promise a Google sign-in the shipped build cannot offer', () => {
    // The build compiles in no backend origin, so the option is absent rather
    // than offered and broken. Public copy saying otherwise would be the one
    // inaccuracy a reviewer could catch in thirty seconds.
    const listing = copy('docs/release/store-listing.md');
    expect(listing.toLowerCase()).toMatch(/no google sign-in in this build/);
  });
});
