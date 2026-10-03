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
 * Google route, and the absence surfaces as a disabled button with a reason
 * rather than as a request to nowhere: the worker turns this module's `null`
 * into `googleClientConfigured` for `providerAuthorization`, which is what
 * fills in the Google method's `configured` flag and the sentence beside it,
 * and the panel reads that flag off `accounts.authMethods`.
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
  /**
   * The Google Cloud project to bill and meter an OAuth-authorized call to.
   *
   * **Required by Google for a user-credential call, and nothing here can
   * derive it.** Google's own documentation: *"When you provide user
   * credentials to authenticate to a client-based API, you must specify the
   * project to use for billing and quota… If your API call returns an error
   * message saying that user credentials are not supported or that the quota
   * project is not set, you must explicitly set the quota project by including
   * the `x-goog-user-project` header."* The Gemini OAuth quickstart's own curl
   * example sends it beside the bearer token.
   *
   * It is **not guessed from the client id.** A Google client id does begin
   * with digits that usually are the project number, and "usually" is not a
   * documented mapping — and this value decides whose quota is spent. So it is
   * configured explicitly by the same person who registers the client, or it
   * is absent and the header is not sent.
   *
   * Absent is a supported state: a key-authorized connection needs none, and
   * an OAuth-authorized call without one either works or returns Google's own
   * message about the quota project, which `classifyGeminiStatus` turns into a
   * sentence naming this setting.
   */
  readonly quotaProject?: string;
}

/**
 * A Google Cloud project id or number, or `null`.
 *
 * Shape-checked rather than trusted, because it travels in a request header: a
 * value with a newline in it is header injection, and a value that is not a
 * project is a request Google refuses for a reason the user cannot act on. The
 * accepted shape is Google's documented one — 6 to 30 characters of lowercase
 * letters, digits and hyphens, not starting or ending with a hyphen — or a bare
 * project number.
 */
export function parseQuotaProject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^[0-9]{1,20}$/.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmed)) return trimmed;
  return null;
}

function configuredClientId(): string | null {
  // One rule, in `inspectClientId`, so the run-time read and the build-time
  // report cannot disagree about what counts as configured.
  const inspected = inspectClientId(
    (import.meta as { env?: Record<string, unknown> }).env?.VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID,
  );
  return inspected.ok ? inspected.clientId : null;
}

export function loadGoogleProviderAuthConfig(): GoogleProviderAuthConfig | null {
  const clientId = configuredClientId();
  if (clientId === null) return null;
  const quotaProject = parseQuotaProject(
    (import.meta as { env?: Record<string, unknown> }).env?.VITE_ABA_GOOGLE_QUOTA_PROJECT,
  );
  return { clientId, ...(quotaProject === null ? {} : { quotaProject }) };
}

/**
 * Why a configured client id was rejected, for a build to report.
 *
 * The failure worth preventing is silent: an owner sets the variable, the value
 * has a typo, the build says nothing, and the panel reports *"this build
 * carries no Google OAuth client id"* — which is true and reads as though the
 * variable had never been set. `scripts/check-extension-env.mjs` runs this at
 * build time and says which it is.
 */
export type ClientIdProblem = 'absent' | 'not_a_google_client_id';

export function inspectClientId(
  raw: unknown,
):
  | { readonly ok: true; readonly clientId: string }
  | { readonly ok: false; readonly problem: ClientIdProblem } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, problem: 'absent' };
  }
  const trimmed = raw.trim();
  if (!trimmed.endsWith('.apps.googleusercontent.com')) {
    return { ok: false, problem: 'not_a_google_client_id' };
  }
  return { ok: true, clientId: trimmed };
}
