/**
 * A controlled Google, for testing the verifier without Google.
 *
 * Generates a real RSA keypair, publishes it as a JWKS, and signs real RS256
 * ID tokens with it. Every claim is settable, so each refusal branch in
 * `verifyGoogleIdToken` is exercised against a token that is genuinely
 * malformed in exactly one way rather than against a string.
 *
 * **This is not a substitute for live Google acceptance**, and nothing here
 * pretends to be: it verifies that *our* verification is correct, not that
 * Google's real tokens pass it. Live acceptance needs real Google credentials
 * and is reported as credential-blocked.
 */
import { GOOGLE_ISSUERS, type JsonWebKey1, type JwksProvider } from '@server/index';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export interface ClaimOverrides {
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string;
  readonly nonce?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly email?: string | null;
  readonly email_verified?: boolean;
}

export interface HeaderOverrides {
  readonly alg?: string;
  readonly kid?: string;
}

export class GoogleFixture {
  private constructor(
    readonly kid: string,
    private readonly privateKey: CryptoKey,
    private readonly jwk: JsonWebKey1,
  ) {}

  static async create(kid = 'test-key-1'): Promise<GoogleFixture> {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
      n?: string;
      e?: string;
    };
    return new GoogleFixture(kid, pair.privateKey, {
      kid,
      kty: 'RSA',
      alg: 'RS256',
      n: exported.n ?? '',
      e: exported.e ?? '',
    });
  }

  /** The published key set, as the verifier's port sees it. */
  jwks(extra: readonly JsonWebKey1[] = []): JwksProvider {
    return { keys: () => Promise.resolve([this.jwk, ...extra]) };
  }

  /** A key set that does not contain this fixture's key. */
  static emptyJwks(): JwksProvider {
    return { keys: () => Promise.resolve([]) };
  }

  /** Signs an ID token. Overrides replace individual claims or header fields. */
  async idToken(
    base: { readonly audience: string; readonly nonce: string; readonly now: number },
    claims: ClaimOverrides = {},
    header: HeaderOverrides = {},
  ): Promise<string> {
    const seconds = Math.floor(base.now / 1000);
    const payload = {
      iss: claims.iss ?? GOOGLE_ISSUERS[0],
      aud: claims.aud ?? base.audience,
      sub: claims.sub ?? 'google-subject-1',
      nonce: claims.nonce ?? base.nonce,
      exp: claims.exp ?? seconds + 3600,
      iat: claims.iat ?? seconds,
      ...(claims.email === undefined ? {} : { email: claims.email }),
      ...(claims.email_verified === undefined ? {} : { email_verified: claims.email_verified }),
    };
    const encodedHeader = encodeJson({
      alg: header.alg ?? 'RS256',
      typ: 'JWT',
      ...(header.kid === undefined ? { kid: this.kid } : { kid: header.kid }),
    });
    const encodedPayload = encodeJson(payload);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      this.privateKey,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    return `${encodedHeader}.${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
  }

  /** A token whose signature was made over different bytes. */
  async tamperedToken(base: {
    readonly audience: string;
    readonly nonce: string;
    readonly now: number;
  }): Promise<string> {
    const token = await this.idToken(base);
    const [head, payload, signature] = token.split('.') as [string, string, string];
    // Re-encode the payload with a different subject, keeping the signature.
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
          c.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
    decoded.sub = 'somebody-else';
    return `${head}.${encodeJson(decoded)}.${signature}`;
  }
}
