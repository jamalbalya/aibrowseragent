/**
 * The access token, which the domain deliberately does not mint.
 *
 * `SessionService.createSession` returns a session and an `accessExpiresAt`
 * but no access token, and the comment there says why: signing needs a key
 * that `config.ts` requires a deployment to inject, and injecting a key is
 * transport work rather than domain work. This is that work, kept out of the
 * router so the router stays a parser.
 *
 * ## Format
 *
 * ```
 *   v1.<base64url(payload)>.<base64url(HMAC-SHA-256)>
 * ```
 *
 * A compact signed assertion, not a JWT. The difference matters: a JWT
 * carries its algorithm in a header that the verifier reads, and "read the
 * algorithm from the token" is the single most reliably exploited mistake in
 * the format's history — `alg: none`, and HMAC verified with a public key.
 * Here the version prefix is **compared, not parsed**: `v1` means HMAC-SHA-256
 * and nothing else, there is no negotiation, and a token that begins any
 * other way is refused before it is decoded.
 *
 * The MAC covers the version prefix and the payload together, under a
 * domain-separated label, so a signature from one purpose cannot be replayed
 * as another. That is the same convention the refresh digest uses
 * (`aba/auth/refresh/v1`), for the same reason.
 *
 * ## What is in it
 *
 * The account, the session and an expiry. **No email, no Google subject, no
 * display name, no device id, no refresh token.** An access token is shown to
 * whatever it authenticates against; anything in it is something that has
 * left the server.
 */
import { timingSafeEqual } from './token';

/** The one accepted version. Compared literally; never read as a parameter. */
const VERSION = 'v1';

/** Domain separation. A MAC from another purpose must not verify here. */
const LABEL = 'aba/auth/access/v1';

export interface AccessTokenClaims {
  /** The ABA account. */
  readonly sub: string;
  /** The session that issued it, so revoking the session invalidates it. */
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
}

/**
 * Signs and verifies access tokens.
 *
 * A port rather than a free function, so the signing key is supplied once at
 * composition and never travels as an argument through call sites that have
 * no business holding it.
 */
export interface AccessTokenIssuer {
  sign(claims: AccessTokenClaims): Promise<string>;
  verify(token: string, now: number): Promise<AccessTokenClaims | null>;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array | null {
  // Length must be a valid base64url length. A malformed token is refused
  // rather than coerced into whatever `atob` makes of it.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Builds an issuer over a signing key.
 *
 * The key is imported once. A key shorter than 32 bytes is refused at
 * construction rather than at first use, because a weak signing key is a
 * deployment mistake that should stop a server starting, not produce tokens
 * nobody can trust.
 */
export async function createAccessTokenIssuer(signingKey: string): Promise<AccessTokenIssuer> {
  const raw = encoder.encode(signingKey);
  if (raw.byteLength < 32) {
    throw new Error('the access-token signing key must be at least 32 bytes');
  }
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);

  const mac = async (signed: string): Promise<string> =>
    base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signed))));

  return {
    async sign(claims: AccessTokenClaims): Promise<string> {
      const payload = base64url(encoder.encode(JSON.stringify(claims)));
      const signed = `${LABEL}.${VERSION}.${payload}`;
      return `${VERSION}.${payload}.${await mac(signed)}`;
    },

    async verify(token: string, now: number): Promise<AccessTokenClaims | null> {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [version, payload, signature] = parts as [string, string, string];
      // Compared, not parsed. There is no algorithm field to trust.
      if (version !== VERSION) return null;
      if (payload.length === 0 || signature.length === 0) return null;

      const expected = await mac(`${LABEL}.${VERSION}.${payload}`);
      // Constant time: a byte-by-byte comparison that returns early leaks how
      // much of a forged signature was right, one request at a time.
      if (!timingSafeEqual(signature, expected)) return null;

      const bytes = fromBase64url(payload);
      if (bytes === null) return null;
      let claims: unknown;
      try {
        claims = JSON.parse(decoder.decode(bytes));
      } catch {
        return null;
      }
      if (!isClaims(claims)) return null;
      // Expiry is checked after the signature, so an expired token and a
      // forged one are told apart only by something that already verified.
      if (claims.exp <= now) return null;
      return claims;
    },
  };
}

function isClaims(value: unknown): value is AccessTokenClaims {
  if (typeof value !== 'object' || value === null) return false;
  const claims = value as Partial<AccessTokenClaims>;
  return (
    typeof claims.sub === 'string' &&
    typeof claims.sid === 'string' &&
    typeof claims.iat === 'number' &&
    typeof claims.exp === 'number'
  );
}
