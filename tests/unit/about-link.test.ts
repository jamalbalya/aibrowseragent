/**
 * TEST-ABOUT-001 — the one outbound link in the interface, and the byline that
 * must not be beside it.
 *
 * Two rules meet here and they are easy to break in opposite directions. The
 * Chrome Web Store listing carries "Created by Jamal Balya". The extension's
 * own interface carries a profile link and no attribution text at all. A change
 * that adds the byline to the UI, or that points the link somewhere else, is
 * the kind of thing nobody reviews twice — so both are pinned.
 *
 * Read off the built bundle rather than the source, because the bundle is what
 * ships. A string can be introduced by a dependency, a template or a
 * substitution that the source files do not show.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROFILE_URL } from '@/sidepanel/components/AboutLink';

const DIST = resolve(__dirname, '../../dist');

/** Every shipped text file, so nothing is checked in only one place. */
function bundleText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|css|json)$/.test(entry.name)) parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(DIST);
  return parts.join('\n');
}

describe('TEST-ABOUT-001 — the profile link', () => {
  it('01 — points at exactly the profile it is meant to', () => {
    // Exact, including the scheme and the host. A typo here is a link to
    // somebody else, and nothing else in the build would notice.
    expect(PROFILE_URL).toBe('https://www.linkedin.com/in/jamalbalya');
  });

  it('02 — is https, so the credit cannot be tampered with in transit', () => {
    expect(new URL(PROFILE_URL).protocol).toBe('https:');
  });

  it.skipIf(!existsSync(DIST))(
    '03 — reaches the shipped bundle, with noopener and noreferrer',
    () => {
      const text = bundleText();
      expect(text).toContain(PROFILE_URL);
      // The opened page gets no handle back to the panel and no referrer. The
      // panel is a trusted surface; handing a tab a `window.opener` to it is
      // exactly what `noopener` exists to prevent.
      expect(text).toContain('noopener noreferrer');
    },
  );

  it.skipIf(!existsSync(DIST))('04 — the byline is nowhere in the interface', () => {
    // The store listing's line, which belongs to the store listing. The
    // release documentation says a check would be the wrong tool because "the
    // string simply is not there" — that is exactly a thing worth checking,
    // and the reasoning was backwards: an absence nothing verifies is an
    // absence that returns.
    const text = bundleText();
    for (const forbidden of ['Created by Jamal Balya', 'Created by']) {
      expect(text, `"${forbidden}" is in the shipped bundle`).not.toContain(forbidden);
    }
  });

  it('05 — it is the only outbound link in the interface', () => {
    // A census, and deliberately over the *source* rather than the bundle. The
    // first version of this case scanned the built output for `href` and found
    // nothing at all: the bundler hoists the URL to a variable and emits
    // `href:e`, so a bundle scan cannot answer "which links does the interface
    // have" — it can only answer "does this string ship", which case 03 does.
    //
    // The claim belongs to the source anyway. Anything else in the panel
    // pointing off-origin is a decision somebody should make deliberately.
    const dir = resolve(__dirname, '../../src/sidepanel');
    const files: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css|html)$/.test(entry.name)) files.push(full);
      }
    };
    walk(dir);
    // An empty enumeration would agree with everything.
    expect(files.length).toBeGreaterThan(10);

    // `href` specifically, not "any absolute URL in the source". The broader
    // scan was tried first and it was the wrong instrument: it flagged
    // `https://api.openai.com/v1` and `https://example.com/mcp`, which are
    // `placeholder` text in two input fields — examples shown to a user typing
    // their own endpoint, not somewhere the interface sends anybody.
    const found = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/href\s*=\s*[{"']([^"'}]+)/g)) {
        const target = match[1]?.trim() ?? '';
        // A JSX expression resolves at runtime; the constant it names is what
        // case 01 pins, and case 03 proves which string ships.
        if (target === 'PROFILE_URL') {
          found.add(PROFILE_URL);
          continue;
        }
        if (/^https?:\/\//.test(target)) found.add(target);
      }
    }
    expect([...found]).toEqual([PROFILE_URL]);
  });
});
