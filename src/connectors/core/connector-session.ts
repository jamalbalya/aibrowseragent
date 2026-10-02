/**
 * A connector's authorization lifecycle.
 *
 * Holds the state machine, runs the OAuth exchange, refreshes, and accepts a
 * token the user supplied themselves. It is the only thing that touches the
 * token vault's write side, and the only thing that ever sees an authorization
 * code or a pasted credential.
 *
 * The state machine is the one in `@/security/state/auth-states`, shared with
 * AI providers — same six states, same edges, same rule that the only route
 * into `READY` is from `AUTHENTICATING` with a confirmed authentication. The
 * *status* type is connector-specific, so a connector can never be handed to
 * something expecting a provider.
 *
 * A failed refresh moves to `NEEDS_AUTH` and stops. It is not retried as a
 * network error: an expired grant does not become valid by asking again, and
 * a loop of refresh attempts against a revoked token is how an integration
 * ends up rate-limited and still broken.
 */

import { getLogger } from '@/logging/logger';
import {
  canTransitionAuthState,
  isReadyReason,
  type AuthState,
} from '@/security/state/auth-states';
import {
  prepareAuthorization,
  validateCallback,
  type PendingAuthorization,
} from '@/connectors/oauth/oauth-flow';
import { type TokenVault, type StoredTokens } from '@/connectors/oauth/token-vault';
import type { AuthFlowPort } from '@/connectors/oauth/auth-flow-port';
import type { ConnectorDescriptor } from './types';

const log = getLogger('security');

/**
 * Thrown by an introspector when the **service** refused the credential.
 *
 * Any other failure is a failure to ask, and the two reach the user as
 * different sentences because they lead to different actions: a rejected token
 * needs a new token, and an unreachable service needs trying again later. A
 * single "could not connect" would send half of those users to the wrong one.
 *
 * It deliberately carries no detail from the response body. A service's error
 * text for a bad credential can echo the credential back.
 */
export class TokenRejected extends Error {
  constructor(message = 'The service refused this token.') {
    super(message);
    this.name = 'TokenRejected';
  }
}

export type ConnectorState = AuthState;

export type ConnectorStateReason =
  | 'not_configured'
  | 'no_grant'
  | 'grant_expired'
  | 'authorization_opened'
  | 'authenticated'
  | 'authorization_refused'
  | 'authorization_invalid'
  | 'user_cancelled'
  | 'service_unreachable'
  | 'access_refused'
  | 'revoked'
  /** A user-supplied token the service would not accept. */
  | 'token_rejected'
  /** A user-supplied token the service could not be asked about. */
  | 'token_unverified';

export interface ConnectorStatus {
  readonly connectorId: string;
  readonly state: ConnectorState;
  readonly reason: ConnectorStateReason;
  readonly scopes: readonly string[];
  readonly accountLabel?: string;
  readonly since: number;
}

export interface TokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
  readonly error_description?: string;
}

/**
 * What a service said about a token the user supplied.
 *
 * `scopes: null` is **not** an empty list. It means the service would not say
 * what the token may do — which is what GitHub does for a fine-grained
 * personal access token, where no `x-oauth-scopes` header comes back. The two
 * are kept apart because they lead to different behaviour: an empty list is a
 * token that may do nothing, and `null` is a token whose reach is unknown, and
 * writing `[]` for both would turn "we could not establish this" into "the
 * service said no". The same three-state discipline the provider capability
 * record uses, for the same reason.
 */
export interface TokenIntrospection {
  readonly accountLabel?: string;
  readonly scopes: readonly string[] | null;
}

/**
 * The outcome of connecting with a supplied token.
 *
 * `scopesEstablished` is `false` when the service would not say what the token
 * may do, and it is **not** stored. After a worker restart `reconcile` rebuilds
 * the status from the vault, where a token whose scopes were unknown and one
 * whose scopes were genuinely empty look identical — both are `[]`, which is
 * the truth about what this build knows either way. The distinction is
 * available at the moment of connecting, which is the moment the user is
 * reading the result, and that is the only place it is reported.
 */
export interface TokenConnectOutcome {
  readonly status: ConnectorStatus;
  readonly scopesEstablished: boolean;
}

/** A credential the user pasted, on its way to being checked. */
export interface SuppliedCredential {
  readonly token: string;
  /** `Bearer` for GitHub, `Basic` for a service that wants email:token. */
  readonly tokenType: string;
}

export interface ConnectorSessionOptions {
  readonly descriptor: ConnectorDescriptor;
  readonly vault: TokenVault;
  readonly authFlow: AuthFlowPort;
  readonly clientId: string;
  /**
   * Performs the token exchange.
   *
   * Injected rather than built here, because the token endpoint is the one
   * connector request that must **not** carry a bearer token and must not be
   * attributed to a task — it is authentication, not a data operation.
   */
  readonly exchange: (endpoint: string, body: URLSearchParams) => Promise<TokenResponse>;
  /**
   * Asks the service about a token the user supplied, before it is stored.
   *
   * Injected for the same reason `exchange` is, and it is the same kind of
   * call: authentication rather than a task data operation. It must not be
   * routed through the connector transport, because the transport reads the
   * credential out of the vault — and the whole point here is to check a
   * credential *before* anything is written to the vault, so that an eviction
   * mid-way cannot leave an unverified token behind that `reconcile` would
   * then read back as a grant.
   *
   * Absent for a connector that has no `api_token` path, where
   * `connectWithToken` refuses.
   */
  readonly introspect?: (credential: SuppliedCredential) => Promise<TokenIntrospection>;
  readonly now?: () => number;
  readonly authorizationTimeoutMs?: number;
  readonly onStatusChange?: (status: ConnectorStatus) => void;
}

export class ConnectorSession {
  private status: ConnectorStatus;
  private pending: PendingAuthorization | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ConnectorSessionOptions) {
    this.now = options.now ?? (() => Date.now());
    this.status = {
      connectorId: options.descriptor.id,
      state: 'UNCONFIGURED',
      reason: 'not_configured',
      scopes: [],
      since: this.now(),
    };
  }

  current(): ConnectorStatus {
    return this.status;
  }

  /**
   * Applies a transition, or refuses it.
   *
   * Refusing leaves the status alone rather than throwing: an out-of-order
   * signal — a stale tab event arriving after the user cancelled — is normal
   * and should not crash whatever was waiting.
   */
  private transition(
    to: ConnectorState,
    reason: ConnectorStateReason,
    extra: { scopes?: readonly string[]; accountLabel?: string } = {},
  ): boolean {
    if (!canTransitionAuthState(this.status.state, to)) {
      log.warn('Rejected an invalid connector transition.', {
        connectorId: this.status.connectorId,
        from: this.status.state,
        to,
      });
      return false;
    }
    // The one edge that must not be reachable by accident.
    if (to === 'READY' && !isReadyReason(reason)) return false;

    this.status = {
      ...this.status,
      state: to,
      reason,
      ...(extra.scopes === undefined ? {} : { scopes: extra.scopes }),
      ...(extra.accountLabel === undefined ? {} : { accountLabel: extra.accountLabel }),
      since: this.now(),
    };
    this.options.onStatusChange?.(this.status);
    return true;
  }

  /** Reconciles the in-memory status with what the vault actually holds. */
  async reconcile(): Promise<ConnectorStatus> {
    const summary = await this.options.vault.summary(this.options.descriptor.id, this.now());
    if (summary.connected) {
      if (this.status.state !== 'READY') {
        // A worker restart loses the status but not the grant. Rebuilding it
        // goes through AUTHENTICATING so the only route into READY stays the
        // only route into READY.
        this.transition('NEEDS_AUTH', 'no_grant');
        this.transition('AUTHENTICATING', 'authorization_opened');
        this.transition('READY', 'authenticated', {
          scopes: summary.scopes,
          ...(summary.accountLabel === undefined ? {} : { accountLabel: summary.accountLabel }),
        });
      }
      return this.status;
    }

    if (this.status.state === 'READY') this.transition('NEEDS_AUTH', 'grant_expired');
    else if (this.status.state === 'UNCONFIGURED') this.transition('NEEDS_AUTH', 'no_grant');
    return this.status;
  }

  /**
   * Runs the whole authorization, end to end.
   *
   * Every failure path lands somewhere explicit. Nothing here returns a
   * half-authorised connector, and nothing reports success on a callback that
   * did not validate.
   */
  async authorize(scopes: readonly string[], signal: AbortSignal): Promise<ConnectorStatus> {
    const oauth = this.options.descriptor.oauth;
    if (!oauth) {
      this.transition('UNAVAILABLE', 'not_configured');
      return this.status;
    }

    if (this.status.state === 'UNCONFIGURED') this.transition('NEEDS_AUTH', 'no_grant');
    if (!this.transition('AUTHENTICATING', 'authorization_opened')) return this.status;

    const prepared = await prepareAuthorization(
      {
        connectorId: this.options.descriptor.id,
        clientId: this.options.clientId,
        authorizationEndpoint: oauth.authorizationEndpoint,
        redirectUri: oauth.redirectUri,
        scopes,
        ...(oauth.extraAuthorizationParams === undefined
          ? {}
          : { extraParams: oauth.extraAuthorizationParams }),
      },
      this.now(),
    );
    this.pending = prepared.pending;

    const outcome = await this.options.authFlow.run(
      {
        authorizationUrl: prepared.url,
        redirectUri: oauth.redirectUri,
        timeoutMs: this.options.authorizationTimeoutMs ?? 5 * 60 * 1000,
      },
      signal,
    );

    if (outcome.kind === 'cancelled') {
      this.pending = null;
      this.transition('NEEDS_AUTH', 'user_cancelled');
      return this.status;
    }

    return await this.completeCallback(outcome.url);
  }

  /**
   * Validates a callback and exchanges the code.
   *
   * The pending authorization is consumed **before** anything else happens,
   * so a state value can be used exactly once: a replayed callback finds
   * nothing pending and is refused, whatever it carries.
   */
  async completeCallback(callbackUrl: string): Promise<ConnectorStatus> {
    const pending = this.pending;
    this.pending = null;

    const validation = validateCallback(callbackUrl, pending ?? undefined, this.now());
    if (!validation.ok) {
      log.warn('A connector authorization callback was refused.', {
        connectorId: this.options.descriptor.id,
        code: validation.code,
      });
      this.transition(
        'NEEDS_AUTH',
        validation.code === 'PROVIDER_ERROR' ? 'authorization_refused' : 'authorization_invalid',
      );
      return this.status;
    }

    // Belt and braces on top of the state check: the pending record names the
    // connector it belongs to, so a callback cannot complete a different one.
    if (validation.pending.connectorId !== this.options.descriptor.id) {
      this.transition('NEEDS_AUTH', 'authorization_invalid');
      return this.status;
    }

    const oauth = this.options.descriptor.oauth!;
    let response: TokenResponse;
    try {
      response = await this.options.exchange(
        oauth.tokenEndpoint,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: validation.code,
          redirect_uri: validation.pending.redirectUri,
          client_id: this.options.clientId,
          code_verifier: validation.pending.codeVerifier,
        }),
      );
    } catch (error) {
      log.warn('A connector token exchange failed.', {
        connectorId: this.options.descriptor.id,
        // The message, never the body: a token endpoint's response can echo
        // the code back.
        error: error instanceof Error ? error.name : 'unknown',
      });
      this.transition('UNAVAILABLE', 'service_unreachable');
      return this.status;
    }

    if (response.error !== undefined || !response.access_token) {
      this.transition('NEEDS_AUTH', 'authorization_refused');
      return this.status;
    }

    const granted = response.scope
      ? response.scope.split(/\s+/).filter(Boolean)
      : [...validation.pending.scopes];
    await this.options.vault.store(this.options.descriptor.id, {
      accessToken: response.access_token,
      tokenType: response.token_type ?? 'Bearer',
      ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
      ...(response.expires_in === undefined
        ? {}
        : { expiresAt: this.now() + response.expires_in * 1000 }),
      scopes: granted,
    } satisfies StoredTokens);

    this.transition('READY', 'authenticated', { scopes: granted });
    return this.status;
  }

  /**
   * Refreshes the access token.
   *
   * An authentication operation, not a data operation. A failure moves the
   * connector to `NEEDS_AUTH` and stops — it is never retried as a transient
   * network error, because a revoked grant does not recover by being asked
   * again and a retry loop against one is just noise.
   */
  async refresh(): Promise<ConnectorStatus> {
    const oauth = this.options.descriptor.oauth;
    const refreshToken = await this.options.vault.refreshTokenForRefreshOnly(
      this.options.descriptor.id,
    );
    if (!oauth || refreshToken === null) {
      this.transition('NEEDS_AUTH', 'grant_expired');
      return this.status;
    }

    let response: TokenResponse;
    try {
      response = await this.options.exchange(
        oauth.tokenEndpoint,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.options.clientId,
        }),
      );
    } catch {
      this.transition('UNAVAILABLE', 'service_unreachable');
      return this.status;
    }

    if (response.error !== undefined || !response.access_token) {
      // The grant is gone. Say so, and stop using it.
      await this.options.vault.clear(this.options.descriptor.id);
      this.transition('NEEDS_AUTH', 'grant_expired');
      return this.status;
    }

    await this.options.vault.updateAfterRefresh(this.options.descriptor.id, {
      accessToken: response.access_token,
      tokenType: response.token_type ?? 'Bearer',
      ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
      ...(response.expires_in === undefined
        ? {}
        : { expiresAt: this.now() + response.expires_in * 1000 }),
      scopes: this.status.scopes,
    });

    // Already READY in the common case; this keeps the record honest when a
    // refresh happened while the connector had drifted to NEEDS_AUTH.
    if (this.status.state !== 'READY') {
      this.transition('AUTHENTICATING', 'authorization_opened');
      this.transition('READY', 'authenticated');
    }
    return this.status;
  }

  /**
   * Connects with a token the user supplied, instead of running a flow.
   *
   * ## Why this path exists at all
   *
   * It is not a convenience. Every one of the six Tier-1 services requires a
   * `client_secret` in its authorization-code token exchange — GitHub,
   * Atlassian and Figma all do, and Atlassian does not support PKCE at all —
   * and `ConnectorOAuthConfig` refuses to carry one, because a secret shipped
   * inside an extension is readable by anyone who unzips it. So the flow this
   * class runs cannot be completed for any of them, with or without a
   * registered application. `docs/connectors.md` has the table.
   *
   * A token the user creates in their own account and pastes in needs no
   * registered application and no secret anywhere. It is the one mechanism
   * that works today, which is why it is here.
   *
   * ## The order of operations is the control
   *
   * The service is asked about the credential **before** the vault is written.
   * The other order would mean that a worker evicted between the write and the
   * check leaves an unverified token stored — and `reconcile` reads the vault,
   * sees a connection, and reports `READY`. Nothing would ever re-check it.
   *
   * So: introspect, and only on success store and transition. A refusal stores
   * nothing, and the state it lands in says which kind of refusal it was.
   *
   * ## Scopes, and the third state
   *
   * Whatever the service confirms is what is recorded. When it will not say
   * (`scopes: null`), **nothing** is recorded, so `hasScopes` is false for
   * every operation that needs one and every write refuses. Reads that need no
   * scope still work. Claiming the scopes the descriptor wanted would be
   * asserting a permission nobody established, and the first thing it would
   * buy is a write that fails at the service after the user approved it.
   */
  async connectWithToken(credential: SuppliedCredential): Promise<TokenConnectOutcome> {
    if (this.options.descriptor.authKind !== 'api_token' || !this.options.introspect) {
      // Not a widening available to any connector that happens to be loaded:
      // a descriptor says whether it has this path, and one that does not
      // cannot be talked onto it.
      this.transition('UNAVAILABLE', 'not_configured');
      return { status: this.status, scopesEstablished: false };
    }
    if (credential.token.length === 0) {
      this.transition('NEEDS_AUTH', 'token_rejected');
      return { status: this.status, scopesEstablished: false };
    }

    // A connector already holding a token is the ordinary case for *replacing*
    // one, after the user rotated or revoked it. There is no READY ->
    // AUTHENTICATING edge, deliberately, so the replacement steps back through
    // NEEDS_AUTH first — which is also honest: between discarding the old
    // token and accepting the new one, the connector is not connected.
    if (this.status.state !== 'AUTHENTICATING' && this.status.state !== 'NEEDS_AUTH') {
      this.transition('NEEDS_AUTH', 'no_grant');
    }
    if (!this.transition('AUTHENTICATING', 'authorization_opened')) {
      return { status: this.status, scopesEstablished: false };
    }

    let introspection: TokenIntrospection;
    try {
      introspection = await this.options.introspect(credential);
    } catch (error) {
      // Nothing is stored, and the reason distinguishes the two cases the user
      // would act on differently: a token the service refused, and a service
      // that could not be reached to ask.
      const refused = error instanceof TokenRejected;
      log.warn('A user-supplied connector token was not accepted.', {
        connectorId: this.options.descriptor.id,
        refused,
      });
      this.transition('NEEDS_AUTH', refused ? 'token_rejected' : 'token_unverified');
      return { status: this.status, scopesEstablished: false };
    }

    const scopes = introspection.scopes === null ? [] : [...introspection.scopes];

    await this.options.vault.store(this.options.descriptor.id, {
      accessToken: credential.token,
      tokenType: credential.tokenType,
      // No refresh token and no expiry: a token the user created does not
      // expire on a schedule this build knows, and inventing one would make a
      // working connector stop working for no reason.
      scopes,
      ...(introspection.accountLabel === undefined
        ? {}
        : { accountLabel: introspection.accountLabel }),
    });

    this.transition('READY', 'authenticated', {
      scopes,
      ...(introspection.accountLabel === undefined
        ? {}
        : { accountLabel: introspection.accountLabel }),
    });
    return { status: this.status, scopesEstablished: introspection.scopes !== null };
  }

  /** Forgets the grant. The service-side revocation is best effort. */
  async disconnect(): Promise<ConnectorStatus> {
    await this.options.vault.clear(this.options.descriptor.id);
    this.pending = null;
    this.transition('UNCONFIGURED', 'revoked');
    return this.status;
  }

  /** Records that the service refused access, which is terminal until reset. */
  markAccessRefused(): ConnectorStatus {
    this.transition('DENIED', 'access_refused');
    return this.status;
  }

  /** Whether the granted scopes cover what an operation needs. */
  hasScopes(required: readonly string[]): boolean {
    return required.every((scope) => this.status.scopes.includes(scope));
  }
}
