/**
 * The Google OAuth client this build authorizes AI accounts with.
 *
 * Configured at build time and never at run time, for the reason
 * `identity/identity-config.ts` gives about the backend origin: a client id
 * settable from a message is a client id an attacker can set, and the value of
 * pinning it is that nothing can.
 *
 * **There is no default, and no secret.** A Chrome Extension OAuth client has
 * no client secret — Google states that a secret "is not applicable to
 * requests from clients registered as Android, iOS, or Chrome applications" —
 * so the authorization is a public client with PKCE, and there is nothing
 * confidential to embed. A build with no client id simply cannot offer the
 * Google route; `isGoogleProviderAuthConfigured` is what the panel reads, so
 * the absence surfaces as a disabled button with a reason rather than as a
 * request to nowhere.
 */

/**
 * The redirect URI Chrome gives this extension.
 *
 * `https://<extension-id>.chromiumapp.org/` is a virtual address: nothing
 * resolves it, and only `chrome.identity.launchWebAuthFlow` intercepts a
 * navigation to it. It is also the only redirect Google will register for a
 * Chrome Extension client — `chrome-extension://` is not accepted, and the
 * loopback alternative belongs to desktop clients, which Google's own Gemini
 * OAuth guide pairs with a downloaded `client_secret.json`.
 *
 * Built from the runtime extension id rather than stored, so a build loaded
 * unpacked under a different id produces its own and fails Google's exact-match
 * check loudly instead of silently redirecting somewhere else.
 */
export function googleRedirectUri(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org/`;
}

export interface GoogleProviderAuthConfig {
  /** `*.apps.googleusercontent.com`. Public; carries no secret. */
  readonly clientId: string;
}

function configuredClientId(): string | null {
  const raw: unknown = (import.meta as { env?: Record<string, unknown> }).env
    ?.VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Shape-checked rather than trusted. A value that is not a Google client id
  // would send the user to an authorization screen that refuses them, and the
  // honest answer is that this build is not configured.
  if (!trimmed.endsWith('.apps.googleusercontent.com')) return null;
  return trimmed;
}

export function loadGoogleProviderAuthConfig(): GoogleProviderAuthConfig | null {
  const clientId = configuredClientId();
  return clientId === null ? null : { clientId };
}

export function isGoogleProviderAuthConfigured(): boolean {
  return loadGoogleProviderAuthConfig() !== null;
}
