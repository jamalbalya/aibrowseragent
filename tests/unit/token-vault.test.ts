/**
 * TEST-CONNECTOR-002 — the connector credential boundary.
 *
 * The vault's design claim is narrow and testable: a token leaves it exactly
 * once, already wrapped in an `Authorization` header, so a caller that only
 * ever receives a header cannot put a raw token anywhere. These tests hold
 * that claim by enumerating the module's public surface rather than by
 * checking the one method everybody remembers.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import {
  assertNoSecrets,
  ConnectorSecretLeakError,
  SECRET_FIELD_NAMES,
  TokenVault,
} from '@/connectors/oauth/token-vault';

const NOW = 1_700_000_000_000;
const TOKEN = 'gho_secret_access_token_value';

let area: MemoryStorageArea;
let vault: TokenVault;

beforeEach(async () => {
  area = new MemoryStorageArea();
  vault = new TokenVault(area);
  await vault.store('github', {
    accessToken: TOKEN,
    tokenType: 'Bearer',
    refreshToken: 'refresh_secret',
    scopes: ['public_repo'],
    accountLabel: 'octocat',
  });
});

describe('getting a credential out', () => {
  it('hands back a header, never a token', async () => {
    expect(await vault.authorizationHeader('github', NOW)).toBe(`Bearer ${TOKEN}`);
  });

  it('exposes no method that returns a bare access token', () => {
    // The enumerable surface is the argument: a reviewer adding an
    // `accessToken()` getter for convenience breaks this test, which is
    // exactly when someone should be asked why.
    const surface = Object.getOwnPropertyNames(TokenVault.prototype).sort();
    expect(surface).toEqual([
      'authorizationHeader',
      'clear',
      'constructor',
      'isUsable',
      'key',
      'refreshTokenForRefreshOnly',
      'store',
      'summary',
      'updateAfterRefresh',
    ]);
  });

  it('says nothing about a connector it has never seen', async () => {
    expect(await vault.authorizationHeader('unknown', NOW)).toBeNull();
    expect(await vault.isUsable('unknown', NOW)).toBe(false);
    expect(await vault.summary('unknown', NOW)).toEqual({
      connected: false,
      scopes: [],
      canRefresh: false,
    });
  });

  it('honours the token type the service chose', async () => {
    await vault.store('other', { accessToken: 'x', tokenType: 'DPoP', scopes: [] });
    expect(await vault.authorizationHeader('other', NOW)).toBe('DPoP x');
  });

  it('falls back to Bearer when the service said nothing', async () => {
    await vault.store('other', { accessToken: 'x', tokenType: '', scopes: [] });
    expect(await vault.authorizationHeader('other', NOW)).toBe('Bearer x');
  });
});

describe('expiry', () => {
  it('refuses a token that has expired', async () => {
    await vault.store('github', {
      accessToken: TOKEN,
      tokenType: 'Bearer',
      scopes: [],
      expiresAt: NOW - 1,
    });
    expect(await vault.authorizationHeader('github', NOW)).toBeNull();
    expect(await vault.isUsable('github', NOW)).toBe(false);
  });

  it('treats a token as expired slightly before it is', async () => {
    // A token that expires during the request is a failure the user sees.
    // The skew spends a minute of validity to avoid it.
    await vault.store('github', {
      accessToken: TOKEN,
      tokenType: 'Bearer',
      scopes: [],
      expiresAt: NOW + 30_000,
    });
    expect(await vault.authorizationHeader('github', NOW)).toBeNull();

    await vault.store('github', {
      accessToken: TOKEN,
      tokenType: 'Bearer',
      scopes: [],
      expiresAt: NOW + 120_000,
    });
    expect(await vault.authorizationHeader('github', NOW)).toBe(`Bearer ${TOKEN}`);
  });

  it('treats a token with no stated expiry as usable', async () => {
    // GitHub's OAuth tokens do not expire unless the app opts in. Inventing
    // an expiry for them would disconnect a working connector.
    expect(await vault.isUsable('github', NOW + 10 * 365 * 24 * 3600_000)).toBe(true);
  });
});

describe('the summary a caller outside the boundary gets', () => {
  it('describes the connection without any credential', async () => {
    const summary = await vault.summary('github', NOW);
    expect(summary).toEqual({
      connected: true,
      scopes: ['public_repo'],
      accountLabel: 'octocat',
      canRefresh: true,
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
    expect(JSON.stringify(summary)).not.toContain('refresh_secret');
  });

  it('reports a connector whose token expired as not connected, but still refreshable', async () => {
    await vault.store('github', {
      accessToken: TOKEN,
      tokenType: 'Bearer',
      refreshToken: 'refresh_secret',
      scopes: ['public_repo'],
      expiresAt: NOW - 1,
    });
    const summary = await vault.summary('github', NOW);
    expect(summary.connected).toBe(false);
    expect(summary.canRefresh).toBe(true);
  });
});

describe('refresh', () => {
  it('keeps the existing refresh token when the response omits one', async () => {
    // A refresh response usually says nothing about the refresh token, which
    // means "keep yours". Dropping it would silently turn a refreshable
    // connection into one that needs re-authorising at the next expiry.
    await vault.updateAfterRefresh('github', {
      accessToken: 'new-access',
      tokenType: 'Bearer',
      scopes: ['public_repo'],
    });
    expect(await vault.refreshTokenForRefreshOnly('github')).toBe('refresh_secret');
    expect(await vault.authorizationHeader('github', NOW)).toBe('Bearer new-access');
  });

  it('takes a rotated refresh token when the response carries one', async () => {
    await vault.updateAfterRefresh('github', {
      accessToken: 'new-access',
      tokenType: 'Bearer',
      refreshToken: 'rotated',
      scopes: ['public_repo'],
    });
    expect(await vault.refreshTokenForRefreshOnly('github')).toBe('rotated');
  });
});

describe('clearing', () => {
  it('leaves nothing behind in storage', async () => {
    await vault.clear('github');
    expect(await vault.authorizationHeader('github', NOW)).toBeNull();
    expect(await area.keys()).toEqual([]);
    // Not just the accessor: the raw storage holds no trace either.
    const dump = JSON.stringify(await Promise.all((await area.keys()).map((key) => area.get(key))));
    expect(dump).not.toContain(TOKEN);
  });

  it('clears one connector without touching another', async () => {
    await vault.store('other', { accessToken: 'other-token', tokenType: 'Bearer', scopes: [] });
    await vault.clear('github');
    expect(await vault.authorizationHeader('other', NOW)).toBe('Bearer other-token');
  });
});

describe('the secret-shaped-field check', () => {
  it('names both the wire and the camelCase spelling of every credential field', () => {
    // A response object spread into a record carries snake_case; an internal
    // object carries camelCase. Catching only one spelling catches neither
    // reliably.
    for (const wire of ['access_token', 'refresh_token', 'client_secret', 'id_token']) {
      const camel = wire.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
      expect(SECRET_FIELD_NAMES).toContain(wire);
      expect(SECRET_FIELD_NAMES).toContain(camel);
    }
  });

  it.each(SECRET_FIELD_NAMES)('rejects a record carrying %s', (field) => {
    expect(() => assertNoSecrets({ [field]: 'value' })).toThrow(ConnectorSecretLeakError);
  });

  it('finds one nested inside an object or an array', () => {
    expect(() => assertNoSecrets({ a: { b: { access_token: 'x' } } })).toThrow(
      ConnectorSecretLeakError,
    );
    expect(() => assertNoSecrets([{ ok: 1 }, { refreshToken: 'x' }])).toThrow(
      ConnectorSecretLeakError,
    );
  });

  it('names the field it found, so the fix is obvious', () => {
    try {
      assertNoSecrets({ nested: { codeVerifier: 'v' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorSecretLeakError);
      expect((error as ConnectorSecretLeakError).field).toBe('codeVerifier');
    }
  });

  it('passes an ordinary connector record', () => {
    expect(() =>
      assertNoSecrets({
        connectorId: 'github',
        state: 'READY',
        scopes: ['public_repo'],
        operation: 'read_issue',
      }),
    ).not.toThrow();
  });

  it('terminates on a cyclic structure', () => {
    // A depth cap rather than a visited set: cheaper, and a credential six
    // levels down a cycle is not a shape any of this code produces.
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => assertNoSecrets(cyclic)).not.toThrow();
  });

  it('ignores a value that merely contains a token string', () => {
    // The check is about field names. Payload scanning is the egress gate's
    // job, and duplicating it here would produce two answers to one question.
    expect(() => assertNoSecrets({ note: `the token is ${TOKEN}` })).not.toThrow();
  });
});
