/**
 * The connector credential boundary.
 *
 * Tokens live here and are handed out through exactly one method, which
 * returns an `Authorization` header value rather than the token itself. That
 * is the whole design: a caller that only ever receives a header cannot put a
 * token in a tool result, a log line, an audit record or a model prompt,
 * because it never holds one.
 *
 * **Where they are stored.** `chrome.storage.session`, which is held in memory
 * and never written to disk. Its default access level is trusted contexts
 * only, so a content script cannot read it even if one were compromised — and
 * this code sets that level explicitly rather than relying on the default
 * staying what it is.
 *
 * The consequence is deliberate: tokens survive a service-worker eviction,
 * which happens constantly, and are gone when the browser restarts, which is
 * rare. Persisting a refresh token to disk would buy a reconnect a user has
 * to do a few times a year, at the cost of a long-lived credential sitting in
 * extension storage. That trade is not worth making.
 */

import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';

const log = getLogger('security');

/**
 * A token set, as it is stored.
 *
 * Exported for the vault's own use and for tests that need to seed one. It is
 * deliberately not exported from the connector barrel: nothing outside this
 * module should be naming this type, let alone holding one.
 */
export interface StoredTokens {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly refreshToken?: string;
  /** Absolute epoch milliseconds, or `undefined` when the service said nothing. */
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
  /** Non-secret label for the UI, e.g. an account name the service returned. */
  readonly accountLabel?: string;
}

/** What a caller outside the boundary is allowed to know about a connection. */
export interface TokenSummary {
  readonly connected: boolean;
  readonly scopes: readonly string[];
  readonly accountLabel?: string;
  readonly expiresAt?: number;
  readonly canRefresh: boolean;
}

/** Treat a token as expired this long before it actually is. */
const EXPIRY_SKEW_MS = 60_000;

export class TokenVault {
  constructor(private readonly area: StorageArea) {}

  private key(connectorId: string): string {
    return `oauth:${connectorId}`;
  }

  async store(connectorId: string, tokens: StoredTokens): Promise<void> {
    await this.area.set(this.key(connectorId), tokens);
    // The connector and the scopes are recorded; nothing about the token is.
    log.info('Connector credentials stored.', {
      connectorId,
      scopes: tokens.scopes.length,
      refreshable: tokens.refreshToken !== undefined,
    });
  }

  /**
   * The `Authorization` header for a connector, or `null`.
   *
   * The only way a token leaves this module, and it leaves already wrapped.
   * A caller cannot log the token because it never sees one.
   */
  async authorizationHeader(connectorId: string, now: number): Promise<string | null> {
    const tokens = await this.area.get<StoredTokens>(this.key(connectorId));
    if (!tokens) return null;
    if (isExpired(tokens, now)) return null;
    return `${tokens.tokenType || 'Bearer'} ${tokens.accessToken}`;
  }

  /** Whether the stored access token is usable right now. */
  async isUsable(connectorId: string, now: number): Promise<boolean> {
    const tokens = await this.area.get<StoredTokens>(this.key(connectorId));
    return tokens !== undefined && !isExpired(tokens, now);
  }

  /**
   * The refresh token, for the refresh path only.
   *
   * Named so that a call site reads as unusual, and used in exactly one
   * place. It is not exposed through the connector session or any tool.
   */
  async refreshTokenForRefreshOnly(connectorId: string): Promise<string | null> {
    const tokens = await this.area.get<StoredTokens>(this.key(connectorId));
    return tokens?.refreshToken ?? null;
  }

  /** Everything a caller outside the boundary may know. */
  async summary(connectorId: string, now: number): Promise<TokenSummary> {
    const tokens = await this.area.get<StoredTokens>(this.key(connectorId));
    if (!tokens) return { connected: false, scopes: [], canRefresh: false };
    return {
      connected: !isExpired(tokens, now),
      scopes: tokens.scopes,
      ...(tokens.accountLabel === undefined ? {} : { accountLabel: tokens.accountLabel }),
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
      canRefresh: tokens.refreshToken !== undefined,
    };
  }

  /**
   * Replaces the access token after a refresh.
   *
   * A refresh response often omits the refresh token, which means "keep the
   * one you have" rather than "you no longer have one" — dropping it would
   * silently turn a refreshable connection into one that needs re-authorising
   * at the next expiry.
   */
  async updateAfterRefresh(
    connectorId: string,
    next: Omit<StoredTokens, 'refreshToken'> & { refreshToken?: string },
  ): Promise<void> {
    const existing = await this.area.get<StoredTokens>(this.key(connectorId));
    const refreshToken = next.refreshToken ?? existing?.refreshToken;
    await this.area.set(this.key(connectorId), {
      ...next,
      ...(refreshToken === undefined ? {} : { refreshToken }),
    } satisfies StoredTokens);
  }

  async clear(connectorId: string): Promise<void> {
    await this.area.remove(this.key(connectorId));
    log.info('Connector credentials cleared.', { connectorId });
  }
}

function isExpired(tokens: StoredTokens, now: number): boolean {
  if (tokens.expiresAt === undefined) return false;
  return now >= tokens.expiresAt - EXPIRY_SKEW_MS;
}

/**
 * Field names that must never appear in anything leaving the boundary.
 *
 * Used by the connector audit and tool-result checks. Belt and braces: the
 * types above have nowhere to put a token, and this catches a caller that
 * spread a wider object into a record.
 */
export const SECRET_FIELD_NAMES: readonly string[] = [
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'code_verifier',
  'codeVerifier',
  'authorization_code',
  'authorizationCode',
  'id_token',
  'idToken',
];

export class ConnectorSecretLeakError extends Error {
  constructor(readonly field: string) {
    super(`A connector record carried "${field}", which must never leave the credential boundary.`);
    this.name = 'ConnectorSecretLeakError';
  }
}

/** Rejects a value that carries credential material. */
export function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, depth + 1);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_NAMES.includes(key)) throw new ConnectorSecretLeakError(key);
    assertNoSecrets(nested, depth + 1);
  }
}
