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
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { figmaDescriptor } from '@/connectors/adapters/figma';
import { jiraDescriptor } from '@/connectors/adapters/jira';
import type { ConnectorDescriptor } from '@/connectors/core/types';

const ADAPTERS = resolve(import.meta.dirname, '../../src/connectors/adapters');

/**
 * Every connector this build ships, discovered from the adapter directory.
 *
 * **The first version of this file kept a hand-written list of three
 * factories**, and its comment claimed the set was "derived from the descriptor
 * factories". It was not. A fourth adapter was added and this file passed
 * unchanged — the exact staleness it exists to prevent, in the guard against
 * that staleness.
 *
 * So the directory is the source. Every module under `adapters/` that exports a
 * `<name>Descriptor` function is a connector, and a fifth one appears here
 * without anybody remembering to add it. The one argument any of them needs is
 * supplied below; a factory that needs a different one fails loudly here rather
 * than being skipped.
 */
async function shippedConnectors(): Promise<ConnectorDescriptor[]> {
  const modules = readdirSync(ADAPTERS).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  const found: ConnectorDescriptor[] = [];

  for (const file of modules) {
    const loaded: Record<string, unknown> = await import(`${ADAPTERS}/${file}`);
    for (const [name, value] of Object.entries(loaded)) {
      if (!/Descriptor$/.test(name) || typeof value !== 'function') continue;
      const factory = value as (options?: unknown) => ConnectorDescriptor;
      // GitHub's needs a redirect URI and an auth kind; the others take
      // nothing. Passing an options object to a factory that ignores it is
      // harmless, which is what lets one call cover all of them.
      found.push(factory({ redirectUri: 'https://example.test/callback', authKind: 'api_token' }));
    }
  }
  return found;
}

/**
 * The catalogue entries are not connectors, and must not be counted as them.
 *
 * `known-endpoints.ts` names ten AI provider endpoints. They live elsewhere and
 * are a different thing; this guard is about connectors.
 */
const DISCLAIMED = ['Google Sheets'];

const PUBLIC_COPY = [
  'docs/release/store-listing.md',
  'docs/PRIVACY.md',
  'docs/release/data-flows.md',
] as const;

function copy(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('every shipped connector is named in the public copy', () => {
  it('names every one of them, in every document a reader reaches', async () => {
    const connectors = await shippedConnectors();
    // A floor rather than an exact count: the number is allowed to grow, and
    // the point is that the copy grows with it.
    expect(connectors.length).toBeGreaterThanOrEqual(4);
    for (const path of PUBLIC_COPY) {
      const text = copy(path);
      for (const descriptor of connectors) {
        expect(text, `${path} does not name ${descriptor.displayName}`).toContain(
          descriptor.displayName,
        );
      }
    }
  });

  it('claims no connector that does not exist', async () => {
    // The direction that produced the worst sentence: the listing said there
    // was no Jira or Figma integration, confidently, after both had shipped.
    const shipped = new Set((await shippedConnectors()).map((d) => d.displayName));
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
  it('says a token, not an OAuth authorization, because that is what happens', async () => {
    // All three use a credential the user creates in their own account. The
    // data-flow table described "access and refresh tokens" obtained "after
    // the user authorizes", which was a different mechanism entirely — and no
    // connector holds a refresh token, because none uses a flow that issues
    // one.
    // Every one of them, as shipped. Figma and Jira have no other mode; see
    // the note on `CONNECTORS` for GitHub.
    for (const descriptor of await shippedConnectors()) {
      expect(descriptor.authKind, descriptor.displayName).toBe('api_token');
    }
    // And two that could not be anything else, asserted without passing an
    // argument — so this is a fact about them rather than about the call.
    // GitHub's factory defaults to `oauth2`, because its OAuth configuration
    // is correct and is what a deployment holding a client secret elsewhere
    // would use; the shipped worker passes `api_token`, which
    // `connector.spec.ts` asserts on the real extension.
    expect(figmaDescriptor().authKind).toBe('api_token');
    expect(jiraDescriptor().authKind).toBe('api_token');

    const flows = copy('docs/release/data-flows.md');
    expect(flows).not.toContain('Connector OAuth tokens');
    expect(flows).not.toContain('the user completed an OAuth grant');

    const privacy = copy('docs/PRIVACY.md');
    expect(privacy.toLowerCase()).toMatch(/token you create in your own account/);
  });

  it('says which connectors are read-only, and they are', async () => {
    // A reader deciding whether this is useful to them needs it, and it is a
    // consequence of the service reporting no scopes rather than a choice.
    const readOnly = (await shippedConnectors())
      .filter((descriptor) => descriptor.operations.every((operation) => operation.kind === 'read'))
      .map((descriptor) => descriptor.displayName);
    expect(readOnly.sort()).toEqual(['Confluence', 'Figma', 'Jira']);

    const listing = copy('docs/release/store-listing.md');
    for (const name of readOnly) {
      expect(listing, `the listing does not say ${name} is read-only`).toMatch(
        new RegExp(`${name}[^.]*read-only|read-only[^.]*${name}`, 'i'),
      );
    }
  });

  it('discloses the destinations that are not fixed in the build', async () => {
    // Jira's origin comes from the user. A privacy document that listed only
    // fixed destinations would be describing a different extension.
    const siteBound = (await shippedConnectors()).filter(
      (descriptor) => descriptor.siteBinding !== undefined,
    );
    expect(siteBound.map((descriptor) => descriptor.displayName).sort()).toEqual([
      'Confluence',
      'Jira',
    ]);

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
