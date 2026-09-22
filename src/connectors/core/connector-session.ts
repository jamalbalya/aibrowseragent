/**
 * A connector's authorization lifecycle.
 *
 * Holds the state machine, runs the OAuth exchange, and refreshes. It is the
 * only thing that touches the token vault's write side, and the only thing
 * that ever sees an authorization code.
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
  | 'revoked';

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
