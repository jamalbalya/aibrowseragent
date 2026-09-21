/**
 * TEST-SECURITY-003 — Origin safety (REQ-SECURITY-003).
 */
import { describe, expect, it } from 'vitest';
import {
  checkNavigable,
  compareOrigins,
  evaluateTransition,
  parseOrigin,
  siteOf,
} from '@/security/origin/origin-validator';

describe('siteOf', () => {
  it('reduces a hostname to its registrable site', () => {
    expect(siteOf('app.example.com')).toBe('example.com');
    expect(siteOf('www.example.com')).toBe('example.com');
    expect(siteOf('example.com')).toBe('example.com');
  });

  it('handles multi-label public suffixes', () => {
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('example.co.id')).toBe('example.co.id');
    expect(siteOf('project.pages.dev')).toBe('project.pages.dev');
  });

  it('leaves IP addresses and localhost intact', () => {
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1');
    expect(siteOf('localhost')).toBe('localhost');
  });

  it('does not treat a lookalike subdomain as the same site', () => {
    expect(siteOf('example.com.evil.net')).toBe('evil.net');
    expect(siteOf('example.com.evil.net')).not.toBe('example.com');
  });
});

describe('checkNavigable', () => {
  it('allows ordinary https pages', () => {
    expect(checkNavigable('https://example.com/page').allowed).toBe(true);
  });

  for (const url of [
    'chrome://settings',
    'chrome-extension://abcdefghijklmnop/page.html',
    'devtools://devtools/bundled/inspector.html',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'view-source:https://example.com',
    'about:blank',
  ]) {
    it(`refuses ${url.split(':')[0]}: URLs`, () => {
      const check = checkNavigable(url);
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('BLOCKED_SCHEME');
    });
  }

  it('refuses file: and ftp: even when insecure origins are allowed', () => {
    // The insecure-origins setting exists for http:// dev servers. If it also
    // unlocked file:, a convenience toggle would hand the agent local
    // filesystem reach — which matters more now that the manifest requests
    // <all_urls> for screenshot capture.
    for (const url of [
      'file:///etc/passwd',
      'file:///C:/Users/me/notes.txt',
      'ftp://example.com/x',
    ]) {
      const permissive = checkNavigable(url, { allowInsecure: true });
      expect(permissive.allowed, url).toBe(false);
      expect(permissive.reason, url).toBe('BLOCKED_SCHEME');
    }
  });

  it('refuses the extension gallery, which could be used to install extensions', () => {
    const check = checkNavigable('https://chromewebstore.google.com/detail/abc');
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('BLOCKED_HOST');
  });

  it('refuses http by default but allows it when explicitly permitted', () => {
    expect(checkNavigable('http://example.com').allowed).toBe(false);
    expect(checkNavigable('http://example.com').reason).toBe('INSECURE_SCHEME');
    expect(checkNavigable('http://example.com', { allowInsecure: true }).allowed).toBe(true);
  });

  it('allows http on localhost for local development', () => {
    expect(checkNavigable('http://localhost:3000/app').allowed).toBe(true);
    expect(checkNavigable('http://127.0.0.1:8080/').allowed).toBe(true);
  });

  it('refuses an unparseable URL', () => {
    expect(checkNavigable('not a url').reason).toBe('INVALID_URL');
  });
});

describe('compareOrigins', () => {
  it('classifies same-origin, same-site and cross-site', () => {
    expect(compareOrigins('https://a.example.com/x', 'https://a.example.com/y')).toBe(
      'same-origin',
    );
    expect(compareOrigins('https://a.example.com', 'https://b.example.com')).toBe('same-site');
    expect(compareOrigins('https://example.com', 'https://evil.com')).toBe('cross-site');
  });

  it('treats a scheme change as not same-origin', () => {
    expect(compareOrigins('https://example.com', 'http://example.com')).toBe('same-site');
  });

  it('treats a port change as not same-origin', () => {
    expect(compareOrigins('https://example.com:443', 'https://example.com:8443')).toBe('same-site');
  });
});

describe('evaluateTransition', () => {
  it('does not require revalidation for a same-origin move', () => {
    const transition = evaluateTransition('https://example.com/a', 'https://example.com/b');
    expect(transition.changed).toBe(false);
    expect(transition.requiresRevalidation).toBe(false);
  });

  it('requires revalidation after a cross-site redirect', () => {
    const transition = evaluateTransition('https://bank.example.com', 'https://evil.test/steal');
    expect(transition.relation).toBe('cross-site');
    expect(transition.requiresRevalidation).toBe(true);
  });

  it('requires revalidation for a same-site subdomain move', () => {
    // Subdomains often sit on different trust boundaries, so this is not
    // treated as free either.
    const transition = evaluateTransition('https://app.example.com', 'https://uploads.example.com');
    expect(transition.relation).toBe('same-site');
    expect(transition.requiresRevalidation).toBe(true);
  });

  it('requires revalidation when either URL cannot be parsed', () => {
    expect(evaluateTransition('https://example.com', 'garbage').requiresRevalidation).toBe(true);
  });
});

describe('parseOrigin', () => {
  it('returns null for a malformed URL rather than throwing', () => {
    expect(parseOrigin('://broken')).toBeNull();
  });

  it('lowercases the hostname', () => {
    expect(parseOrigin('https://EXAMPLE.com/x')?.hostname).toBe('example.com');
  });
});
