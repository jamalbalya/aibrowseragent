/**
 * PKCE, server-side.
 *
 * The verifier is generated here and **never leaves this server** — the
 * extension is a public client and anything it holds is readable by anyone
 * who installs it. What the extension sees is the challenge, embedded in an
 * authorization URL, which is useless without the verifier.
 *
 * `S256` only. `plain` is not implemented and there is no parameter that
 * would select it: a downgrade needs something to downgrade to, and the
 * repository's connector OAuth made the same choice for the same reason.
 */

/** RFC 7636 allows 43–128 characters; 32 random bytes lands at 43 base64url. */
const VERIFIER_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newCodeVerifier(): string {
  const bytes = new Uint8Array(VERIFIER_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
