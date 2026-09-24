/**
 * The authenticated half of the identity API: listing, linking, unlinking.
 *
 * Separate from `GoogleSignIn` and `EmailSignIn` because these are not
 * sign-ins. They act on an account the caller is **already** authenticated
 * as, they take the access token as their credential, and none of them
 * produces or replaces a session — which is the property that makes linking
 * safe to offer at all.
 *
 * ## What the client cannot do
 *
 * **It cannot describe an identity.** There is no method here that takes an
 * email address, a subject or a kind and asks for it to be attached. Linking
 * starts a flow on the server and finishes it by handing back proof material
 * the server itself minted and verifies. So "the client claimed to own this
 * address" is not a request this module can make.
 *
 * **It cannot name an account.** Every request carries a bearer token and
 * nothing else; the account is whatever that token's session resolves to.
 */
import { getLogger } from '@/logging/logger';
import { IDENTITY_PATHS } from './identity-config';
import type { IdentityTransport } from './identity-transport';
import type { SessionStore } from './session-store';
import type { AuthFlowPort } from '@/connectors/oauth/auth-flow-port';
import { CALLBACK_PATH, parseCallback, SIGN_IN_TIMEOUT_MS } from './google-sign-in';
import type { IdentityConfig } from './identity-config';

const log = getLogger('security');

/** One linked way of signing in, as the panel renders it. */
export interface LinkedIdentity {
  readonly id: string;
  readonly kind: 'google' | 'email';
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly linkedAt: number;
  readonly lastUsedAt: number | null;
  /** Whether removing it is permitted right now. Decided by the server. */
  readonly removable: boolean;
}

export type LinkFailure =
  | 'NOT_CONFIGURED'
  | 'NOT_SIGNED_IN'
  /** The identity is attached to some account. Never says which. */
  | 'IDENTITY_IN_USE'
  | 'CANCELLED'
  | 'INVALID_EMAIL'
  | 'INVALID_CODE'
  | 'RATE_LIMITED'
  | 'DELIVERY_FAILED'
  | 'REFUSED'
  | 'UNREACHABLE';

export type DetachFailure =
  'NOT_CONFIGURED' | 'NOT_SIGNED_IN' | 'LAST_IDENTITY' | 'NOT_FOUND' | 'UNREACHABLE';

export interface IdentityClientOptions {
  readonly config: IdentityConfig;
  readonly transport: IdentityTransport;
  readonly sessions: SessionStore;
  readonly authFlow: AuthFlowPort;
  readonly timeoutMs?: number;
}

function readString(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(body: unknown, field: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isLinkedIdentity(value: unknown): value is LinkedIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<LinkedIdentity>;
  return (
    typeof row.id === 'string' &&
    (row.kind === 'google' || row.kind === 'email') &&
    (row.email === null || typeof row.email === 'string') &&
    typeof row.emailVerified === 'boolean' &&
    typeof row.removable === 'boolean'
  );
}

export class IdentityClient {
  constructor(private readonly options: IdentityClientOptions) {}

  /** The access token, or `null` when this installation holds no session. */
  private async bearer(): Promise<string | null> {
    const access = await this.options.sessions.readAccess();
    return access?.token ?? null;
  }

  /**
   * The caller's own linked identities.
   *
   * There is no parameter, because there is no account to name: the answer is
   * whatever the bearer token's session resolves to.
   */
  async list(): Promise<
    { ok: true; identities: readonly LinkedIdentity[] } | { ok: false; failure: DetachFailure }
  > {
    const bearer = await this.bearer();
    if (bearer === null) return { ok: false, failure: 'NOT_SIGNED_IN' };

    try {
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.identities,
        method: 'GET',
        body: {},
        bearer,
      });
      if (response.status === 401) return { ok: false, failure: 'NOT_SIGNED_IN' };
      if (response.status === 404) return { ok: false, failure: 'NOT_CONFIGURED' };
      if (response.status !== 200) return { ok: false, failure: 'UNREACHABLE' };

      const raw = (response.body as { identities?: unknown })?.identities;
      if (!Array.isArray(raw)) return { ok: false, failure: 'UNREACHABLE' };
      // A malformed row is dropped rather than rendered half-formed: the panel
      // decides what a person may remove from this list.
      return { ok: true, identities: raw.filter(isLinkedIdentity) };
    } catch {
      return { ok: false, failure: 'UNREACHABLE' };
    }
  }

  /**
   * Links a Google account, by running the flow in a tab this extension opens.
   *
   * The same mechanism sign-in uses — `AuthFlowPort`, no new permission, no
   * `chrome.identity` — and the same callback parsing. What differs is only
   * where the completed proof is sent: to the attach route, under the
   * caller's own bearer token, so the outcome is an attached identity rather
   * than a new session.
   */
  async linkGoogle(
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; failure: LinkFailure }> {
    const bearer = await this.bearer();
    if (bearer === null) return { ok: false, failure: 'NOT_SIGNED_IN' };

    let started: { challengeId: string; authorizationUrl: string };
    try {
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.identityLinkStart,
        body: { method: 'google' },
        bearer,
      });
      if (response.status === 404) return { ok: false, failure: 'NOT_CONFIGURED' };
      if (response.status === 401) return { ok: false, failure: 'NOT_SIGNED_IN' };
      const challengeId = readString(response.body, 'challengeId');
      const authorizationUrl = readString(response.body, 'authorizationUrl');
      if (response.status !== 200 || challengeId === null || authorizationUrl === null) {
        return { ok: false, failure: 'REFUSED' };
      }
      // https only, and a real URL: the backend names the endpoint but this
      // extension is what opens it in a tab it created.
      if (new URL(authorizationUrl).protocol !== 'https:') return { ok: false, failure: 'REFUSED' };
      started = { challengeId, authorizationUrl };
    } catch {
      return { ok: false, failure: 'UNREACHABLE' };
    }

    const outcome = await this.options.authFlow.run(
      {
        authorizationUrl: started.authorizationUrl,
        redirectUri: `${this.options.config.backendOrigin}${CALLBACK_PATH}`,
        timeoutMs: this.options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
      },
      signal,
    );
    if (outcome.kind !== 'callback') return { ok: false, failure: 'CANCELLED' };

    const callback = parseCallback(this.options.config.backendOrigin, outcome.url);
    // The challenge that came back must be the one this flow started.
    if (callback === null || callback.challengeId !== started.challengeId) {
      return { ok: false, failure: 'REFUSED' };
    }

    return this.attach({ challengeId: callback.challengeId, exchangeCode: callback.exchangeCode });
  }

  /** Asks the backend to mail a code for an address to be linked. */
  async startEmailLink(
    email: string,
  ): Promise<
    | { ok: true; challengeId: string; expiresAt: number; resendAvailableAt: number }
    | { ok: false; failure: LinkFailure }
  > {
    const bearer = await this.bearer();
    if (bearer === null) return { ok: false, failure: 'NOT_SIGNED_IN' };

    const address = email.trim();
    if (address.length === 0 || address.length > 320) {
      return { ok: false, failure: 'INVALID_EMAIL' };
    }

    try {
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.identityLinkStart,
        // The address as typed apart from surrounding whitespace. No case
        // folding and no rewriting: canonicalisation is one rule in one place,
        // on the server.
        body: { method: 'email', email: address },
        bearer,
      });
      if (response.status === 200) {
        const challengeId = readString(response.body, 'challengeId');
        const expiresAt = readNumber(response.body, 'expiresAt');
        const resendAvailableAt = readNumber(response.body, 'resendAvailableAt');
        if (challengeId === null || expiresAt === null || resendAvailableAt === null) {
          return { ok: false, failure: 'UNREACHABLE' };
        }
        log.info('A code was requested to link an address.', {});
        return { ok: true, challengeId, expiresAt, resendAvailableAt };
      }
      if (response.status === 401) return { ok: false, failure: 'NOT_SIGNED_IN' };
      if (response.status === 404) return { ok: false, failure: 'NOT_CONFIGURED' };
      if (response.status === 400) return { ok: false, failure: 'INVALID_EMAIL' };
      if (response.status === 429) return { ok: false, failure: 'RATE_LIMITED' };
      if (response.status === 502 || response.status === 503) {
        return { ok: false, failure: 'DELIVERY_FAILED' };
      }
      return { ok: false, failure: 'REFUSED' };
    } catch {
      return { ok: false, failure: 'UNREACHABLE' };
    }
  }

  /** Presents the mailed code, attaching the address it was sent to. */
  async completeEmailLink(
    challengeId: string,
    code: string,
  ): Promise<{ ok: true } | { ok: false; failure: LinkFailure }> {
    const presented = code.trim();
    if (!/^[0-9]{6}$/.test(presented)) return { ok: false, failure: 'INVALID_CODE' };
    return this.attach({ challengeId, code: presented });
  }

  /**
   * Removes a linked identity.
   *
   * The server decides whether it may go. `LAST_IDENTITY` is the refusal that
   * matters, and it is passed through unchanged so the panel can explain it.
   */
  async detach(
    identityId: string,
  ): Promise<{ ok: true; revokedSessions: number } | { ok: false; failure: DetachFailure }> {
    const bearer = await this.bearer();
    if (bearer === null) return { ok: false, failure: 'NOT_SIGNED_IN' };

    try {
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.identityDetach,
        body: { identityId },
        bearer,
      });
      if (response.status === 200) {
        return { ok: true, revokedSessions: readNumber(response.body, 'revokedSessions') ?? 0 };
      }
      if (response.status === 401) return { ok: false, failure: 'NOT_SIGNED_IN' };
      if (response.status === 404) {
        // The server answers `NOT_FOUND` for an identity that belongs to
        // somebody else exactly as for one that does not exist, so there is
        // nothing here to tell apart.
        return { ok: false, failure: 'NOT_FOUND' };
      }
      if (response.status === 409) {
        const reason = readString(response.body, 'reason');
        return { ok: false, failure: reason === 'LAST_IDENTITY' ? 'LAST_IDENTITY' : 'NOT_FOUND' };
      }
      return { ok: false, failure: 'UNREACHABLE' };
    } catch {
      return { ok: false, failure: 'UNREACHABLE' };
    }
  }

  /** The one place proof material is presented. Shared by both methods. */
  private async attach(
    proof: { readonly challengeId: string } & ({ code: string } | { exchangeCode: string }),
  ): Promise<{ ok: true } | { ok: false; failure: LinkFailure }> {
    const bearer = await this.bearer();
    if (bearer === null) return { ok: false, failure: 'NOT_SIGNED_IN' };

    try {
      const response = await this.options.transport.send({
        path: IDENTITY_PATHS.identityAttach,
        // The union is already a record of strings; the transport takes one.
        body: proof,
        bearer,
      });
      if (response.status === 200) {
        log.info('An authentication identity was linked.', {});
        return { ok: true };
      }
      if (response.status === 409) {
        const reason = readString(response.body, 'reason');
        return {
          ok: false,
          failure: reason === 'IDENTITY_IN_USE' ? 'IDENTITY_IN_USE' : 'REFUSED',
        };
      }
      if (response.status === 401) return { ok: false, failure: 'REFUSED' };
      if (response.status === 404) return { ok: false, failure: 'NOT_CONFIGURED' };
      return { ok: false, failure: 'REFUSED' };
    } catch {
      return { ok: false, failure: 'UNREACHABLE' };
    }
  }
}
