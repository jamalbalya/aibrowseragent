/**
 * Google ID token verification.
 *
 * This is the module that decides whether an authentication actually
 * happened, so it is written to fail closed at every step and to trust
 * nothing that arrived with the token.
 *
 * **What it verifies, in order, abandoning on the first failure:**
 *
 *  1. the token is three base64url segments and the header parses;
 *  2. `alg` is `RS256` — taken from an allowlist, never from the token. A
 *     token is not permitted to nominate its own algorithm, because `none`
 *     and HMAC-with-the-public-key are the two classic forgeries and both
 *     begin with the verifier believing the header;
 *  3. `kid` names a key in the published set. An absent `kid`, or one that
 *     names no key, is a refusal rather than a reason to try every key;
 *  4. the **signature** over `header.payload`;
 *  5. `iss` is one of Google's two published issuer strings, exactly;
 *  6. `aud` equals this client id, exactly;
 *  7. `exp` is in the future and `iat` is not implausibly ahead, both with a
 *     small fixed clock skew;
 *  8. `nonce` equals the one this flow generated, compared in constant time;
 *  9. `sub` is present and non-empty — it is the identity, and a token
 *     without one identifies nobody.
 *
 * **`email_verified` is read, never assumed.** An unverified address is
 * carried through as unverified and the identity layer refuses to match or
 * link on it (AUTH-18).
 *
 * Nothing here performs I/O. The public keys arrive through a port, so the
 * verifier is exercised in tests against keys a test generated and signed
 * with, which is what lets every failure branch be covered without Google.
 */
import { fail, ok, type Result } from './errors';

/** Google's published issuer strings. Both are valid; nothing else is. */
export const GOOGLE_ISSUERS: readonly string[] = [
  'https://accounts.google.com',
  'accounts.google.com',
];

/** The one signature algorithm accepted. Taken from here, never from a token. */
const ACCEPTED_ALG = 'RS256';

/** Tolerance for clock disagreement between this server and Google. */
export const CLOCK_SKEW_MS = 60_000;

/** One key from the provider's published set. */
export interface JsonWebKey1 {
  readonly kid: string;
  readonly kty: string;
  readonly alg?: string;
  readonly n: string;
  readonly e: string;
}

/**
 * Supplies the provider's current signing keys.
 *
 * A port, so the verifier performs no network call and a test can hand it a
 * key it generated. A production adapter fetches and caches Google's JWKS.
 */
export interface JwksProvider {
  keys(): Promise<readonly JsonWebKey1[]>;
}

/** The claims this design reads, and no others. */
export interface GoogleIdentityClaims {
  readonly subject: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export interface VerifyOptions {
  readonly idToken: string;
  /** This application's Google client id. Compared against `aud`, exactly. */
  readonly audience: string;
  /** The nonce this flow generated. Compared against the token's, exactly. */
  readonly expectedNonce: string;
  readonly now: number;
  readonly jwks: JwksProvider;
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function parseSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Constant-time comparison, for the nonce. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function readString(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(claims: Record<string, unknown>, name: string): number | null {
  const value = claims[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Verifies a Google ID token and returns only the claims this design uses.
 *
 * Every failure is `INVALID_ARGUMENT`. The reason is deliberately not
 * distinguished to the caller: telling an attacker which check failed tells
 * them which forgery to try next, and no legitimate client can act on the
 * difference.
 */
export async function verifyGoogleIdToken(
  options: VerifyOptions,
): Promise<Result<GoogleIdentityClaims>> {
  const segments = options.idToken.split('.');
  if (segments.length !== 3) return fail('INVALID_ARGUMENT');
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];

  const header = parseSegment(encodedHeader);
  if (header === null) return fail('INVALID_ARGUMENT');

  // The algorithm is ours, not the token's. `alg: none` and an HMAC signed
  // with the public key both work only against a verifier that reads this
  // field as an instruction.
  if (header.alg !== ACCEPTED_ALG) return fail('INVALID_ARGUMENT');
  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (kid === null) return fail('INVALID_ARGUMENT');

  const keys = await options.jwks.keys();
  const jwk = keys.find((candidate) => candidate.kid === kid);
  // No trying every key: an unknown `kid` is an unknown signer.
  if (jwk === undefined) return fail('INVALID_ARGUMENT');
  if (jwk.kty !== 'RSA') return fail('INVALID_ARGUMENT');
  if (jwk.alg !== undefined && jwk.alg !== ACCEPTED_ALG) return fail('INVALID_ARGUMENT');

  const signature = base64UrlToBytes(encodedSignature);
  if (signature === null) return fail('INVALID_ARGUMENT');

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return fail('INVALID_ARGUMENT');
  }

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as ArrayBuffer,
    signed,
  );
  if (!signatureValid) return fail('INVALID_ARGUMENT');

  const claims = parseSegment(encodedPayload);
  if (claims === null) return fail('INVALID_ARGUMENT');

  const issuer = readString(claims, 'iss');
  if (issuer === null || !GOOGLE_ISSUERS.includes(issuer)) return fail('INVALID_ARGUMENT');

  const audience = readString(claims, 'aud');
  if (audience === null || audience !== options.audience) return fail('INVALID_ARGUMENT');

  const expiry = readNumber(claims, 'exp');
  if (expiry === null || expiry * 1000 + CLOCK_SKEW_MS <= options.now)
    return fail('INVALID_ARGUMENT');

  const issuedAt = readNumber(claims, 'iat');
  // A token issued in the future is a token from a clock nobody controls.
  if (issuedAt === null || issuedAt * 1000 - CLOCK_SKEW_MS > options.now) {
    return fail('INVALID_ARGUMENT');
  }

  const nonce = readString(claims, 'nonce');
  if (nonce === null || !constantTimeEqual(nonce, options.expectedNonce)) {
    return fail('INVALID_ARGUMENT');
  }

  const subject = readString(claims, 'sub');
  if (subject === null) return fail('INVALID_ARGUMENT');

  const email = readString(claims, 'email');
  // Absent means false. A missing claim is not a verified address.
  const emailVerified = claims.email_verified === true;

  return ok({ subject, email, emailVerified });
}
