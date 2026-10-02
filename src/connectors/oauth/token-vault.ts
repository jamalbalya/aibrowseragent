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
  /**
   * The scheme the credential header carries, or `null` for none at all.
   *
   * `Bearer` for almost everything, `Basic` for a service that wants
   * base64(user:token). `null` means the header's value **is** the token, with
   * no prefix — which is what Figma's `X-Figma-Token` is, and what sending
   * `Bearer <token>` to it would break.
   *
   * Explicit, and never a default. An empty string still means `Bearer`,
   * because that is what it has always meant and changing it would alter
   * every record already on disk; `null` is a new state a writer has to ask
   * for. A connector that needed a bare token and got `Bearer` prepended
   * would send an unauthenticated request with the credential attached to it.
   */
  readonly tokenType: string | null;
  readonly refreshToken?: string;
  /** Absolute epoch milliseconds, or `undefined` when the service said nothing. */
  readonly expiresAt?: number;
  readonly scopes: readonly string[];
  /** Non-secret label for the UI, e.g. an account name the service returned. */
  readonly accountLabel?: string;
  /**
   * The one origin this credential may be sent to, for a site-bound connector.
   *
   * Written here, with the credential, because that is what makes the binding
   * real: the origin and the token are one record, so a token saved for one
   * site can never be sent to another, and replacing the site replaces the
   * credential. Absent for every connector whose origin its descriptor
   * declares.
   *
   * Not a secret, and stored beside one — so it is reachable only through
   * `boundOrigin` below, which hands back an origin and never a token.
   */
  readonly boundOrigin?: string;
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
   * The value of the credential header for a connector, or `null`.
   *
   * The only way a credential leaves this module. It was called
   * `authorizationHeader` and returned `"<scheme> <token>"` always, on the
   * stated grounds that it leaves "already wrapped" so a caller cannot log a
   * token it never sees. One connector broke that: Figma's REST API takes a
   * personal access token in `X-Figma-Token` and ignores `Authorization`, and
   * that header's syntax is the token with no prefix. A wrapped value sent to
   * it is an unauthenticated request with the credential attached.
   *
   * So a `null` `tokenType` returns the token itself. What the rename records
   * is that the guarantee was never really about the prefix: it is that this
   * is the **one** exit, that only the transport calls it, and that what comes
   * out goes straight into a header and nowhere else. `tests/unit/token-vault`
   * asserts the whole enumerable surface for exactly that reason.
   */
  async credentialHeaderValue(connectorId: string, now: number): Promise<string | null> {
    const tokens = await this.area.get<StoredTokens>(this.key(connectorId));
    if (!tokens) return null;
    if (isExpired(tokens, now)) return null;
    // `null` is the only way to get an unprefixed value, and a writer has to
    // ask for it. An absent or empty `tokenType` still means `Bearer`.
    if (tokens.tokenType === null) return tokens.accessToken;
    return `${tokens.tokenType || 'Bearer'} ${tokens.accessToken}`;
  }

  /**
   * The origin this connector's credential is bound to, or `null`.
   *
   * A second accessor rather than a field on `summary`, because the transport
   * needs it on a path where it must not also be handed anything else, and
   * because a caller asking "where may this go" is asking a different question
   * from "what may the panel show". It returns an origin: there is no token in
   * it and no token can be derived from it.
   *
   * `null` both for a connector with no binding and for one with no stored
   * credential at all. The transport treats the second as nothing-permitted
   * rather than everything-permitted, which is why this cannot usefully be
   * confused with "unbound".
   */
  async boundOrigin(connectorId: string): Promise<string | null> {
    const tokens = await this.area.get<StoredTokens>(this.key(connectorId));
    return tokens?.boundOrigin ?? null;
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
