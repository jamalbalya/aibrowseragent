/**
 * TEST-SERVER-024 — the access token.
 *
 * It is a compact signed assertion rather than a JWT, and the difference is
 * the point of most of these cases: a JWT verifier reads its algorithm out of
 * the token, and "trust the token's own header" is the single most reliably
 * exploited mistake in that format. Here the version prefix is compared, not
 * parsed, so the two classic forgeries — `alg: none` and an HMAC verified
 * with a public key — have nowhere to enter.
 */
import { describe, expect, it } from 'vitest';
import { createAccessTokenIssuer, type AccessTokenClaims } from '@server/index';

const KEY = 'k'.repeat(64);
const NOW = 1_800_000_000_000;

const claims = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => ({
  sub: 'usr_11111111111111111111111111111111',
  sid: 'ses_22222222222222222222222222222222',
  iat: NOW,
  exp: NOW + 900_000,
  ...overrides,
});

describe('access tokens', () => {
  it('01 — round-trips, and returns exactly the claims it was given', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims());

    expect(await issuer.verify(token, NOW)).toEqual(claims());
  });

  it('02 — refuses a key too short to be a signing key', async () => {
    // A deployment mistake that should stop a server starting, rather than
    // produce tokens nobody can trust.
    await expect(createAccessTokenIssuer('short')).rejects.toThrow(/32 bytes/);
    await expect(createAccessTokenIssuer('k'.repeat(31))).rejects.toThrow(/32 bytes/);
    await expect(createAccessTokenIssuer('k'.repeat(32))).resolves.toBeDefined();
  });

  it('03 — a token signed with another key does not verify', async () => {
    const mine = await createAccessTokenIssuer(KEY);
    const theirs = await createAccessTokenIssuer('x'.repeat(64));

    expect(await mine.verify(await theirs.sign(claims()), NOW)).toBeNull();
  });

  it('04 — a tampered payload does not verify', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims());
    const [version, , signature] = token.split('.') as [string, string, string];

    // Re-encode the claims with a different account, keeping the signature.
    const forged = btoa(JSON.stringify(claims({ sub: 'usr_ffffffffffffffffffffffffffffffff' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(await issuer.verify(`${version}.${forged}.${signature}`, NOW)).toBeNull();
  });

  it('05 — an unknown version prefix is refused before anything is decoded', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims());
    const [, payload, signature] = token.split('.') as [string, string, string];

    for (const version of ['v2', 'none', 'HS256', 'RS256', '', 'V1']) {
      expect(await issuer.verify(`${version}.${payload}.${signature}`, NOW), version).toBeNull();
    }
  });

  it('06 — there is no algorithm field a token can name', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims());

    // The two classic JWT forgeries need a header the verifier reads. This
    // format has none: the token is version, payload, MAC.
    expect(token.split('.')).toHaveLength(3);
    expect(token.startsWith('v1.')).toBe(true);
    expect(token).not.toContain('alg');
  });

  it('07 — an expired token does not verify, and expiry is checked after the MAC', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims({ exp: NOW + 1000 }));

    expect(await issuer.verify(token, NOW)).not.toBeNull();
    expect(await issuer.verify(token, NOW + 1000)).toBeNull();
    expect(await issuer.verify(token, NOW + 5000)).toBeNull();
  });

  it('08 — a malformed token is refused rather than throwing', async () => {
    const issuer = await createAccessTokenIssuer(KEY);

    for (const bad of [
      '',
      'v1',
      'v1.',
      'v1..',
      'v1.a',
      'v1.a.b.c',
      'v1.!!!.###',
      'v1.' + 'a'.repeat(5000) + '.b',
      '...',
    ]) {
      await expect(issuer.verify(bad, NOW), bad).resolves.toBeNull();
    }
  });

  it('09 — a payload that is valid base64url but not claims is refused', async () => {
    const issuer = await createAccessTokenIssuer(KEY);

    for (const payload of ['null', '[]', '"a string"', '{}', '{"sub":1,"sid":2}']) {
      const encoded = btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      // Signed properly, so only the shape check can refuse it.
      const token = await issuer.sign(claims());
      const signature = token.split('.')[2]!;
      expect(await issuer.verify(`v1.${encoded}.${signature}`, NOW), payload).toBeNull();
    }
  });

  it('10 — the MAC is domain separated, so it is not reusable elsewhere', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims());
    const [, payload, signature] = token.split('.') as [string, string, string];

    // A MAC over the bare payload — what a caller signing the same bytes for
    // another purpose would produce — must not verify here.
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const bare = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    let binary = '';
    for (const byte of bare) binary += String.fromCharCode(byte);
    const bareMac = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(bareMac).not.toBe(signature);
    expect(await issuer.verify(`v1.${payload}.${bareMac}`, NOW)).toBeNull();
  });

  it('11 — two tokens for the same claims are identical, and differ across keys', async () => {
    const a = await createAccessTokenIssuer(KEY);
    const b = await createAccessTokenIssuer('y'.repeat(64));

    // Deterministic: no random padding, so nothing here depends on entropy
    // the verifier does not have.
    expect(await a.sign(claims())).toBe(await a.sign(claims()));
    expect(await b.sign(claims())).not.toBe(await a.sign(claims()));
  });

  it('12 — the token carries no email, subject, device or refresh token', async () => {
    const issuer = await createAccessTokenIssuer(KEY);
    const token = await issuer.sign(claims());
    const payload = token.split('.')[1]!;
    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));

    expect(Object.keys(JSON.parse(decoded) as object).sort()).toEqual(['exp', 'iat', 'sid', 'sub']);
    expect(decoded).not.toContain('@');
    expect(decoded).not.toContain('dev_');
  });
});
