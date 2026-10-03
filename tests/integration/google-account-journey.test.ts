/**
 * TEST-GOOGLE-001 — the whole account-integration journey, for an authorized
 * Google account.
 *
 * ## What this covers that nothing else does
 *
 * `brain-routing.test.ts` proves the selected account is the one that runs, for
 * accounts holding a pasted key. An authorized account differs in the one way
 * that matters at request time: **its credential expires**. So the journey has
 * steps the key path does not have, and each is a place a plausible
 * implementation goes wrong:
 *
 *  - the token is renewed *before* a request rather than after one has failed;
 *  - a renewal that is refused is not retried, because a revoked grant does
 *    not become valid by being asked again;
 *  - a connection with no refresh token reports itself unusable rather than
 *    sending a spent access token;
 *  - the renewed token is written back, so one expiry costs one renewal and
 *    not one per request;
 *  - the credential reaches `Authorization`, never the API-key header;
 *  - and disconnecting clears the OAuth record, not just the key slot that
 *    this kind of account never had.
 *
 * ## The real stack, minus the socket
 *
 * The real `AccountStore` over a real serialised area, the real
 * `CredentialStore`, the real `GoogleProviderAuth`, the real
 * `credentialForConnection`, the real `resolveBrainAccount` and the real
 * `GeminiAdapter`. Only two things are supplied by the test: the token
 * endpoint, which is a function, and the transport under the adapter, which
 * records what it was handed. Real sockets in real Chromium are the E2E
 * layer's job and `google-provider-auth.spec.ts` does that part.
 *
 * ## No credential
 *
 * Every token is a fixed literal that authenticates nothing, and no request
 * leaves the process.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { AccountStore } from '@/providers/accounts/account-store';
import { CredentialStore, type StoredOAuthTokens } from '@/config/settings';
import {
  GoogleProviderAuth,
  needsRefresh,
  type GoogleProviderToken,
} from '@/providers/oauth/google-provider-auth';
import {
  credentialForConnection,
  type RenewOutcome,
} from '@/providers/accounts/connection-credential';
import { GOOGLE_AUTH } from '@/providers/accounts/authorization';
import { UNKNOWN_CAPABILITIES } from '@/providers/core/types';
import { resolveBrainAccount, BrainUnavailable } from '@/providers/accounts/resolve-brain';
import { accountAfterSelection } from '@/providers/accounts/account-model';
import { GEMINI_PROVIDER_ID, GeminiAdapter } from '@/providers/adapters/gemini';
import type { ConnectedAccount } from '@/providers/accounts/account-model';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';
import type { ProviderTransport } from '@/security/egress/provider-transport';

const CLIENT = '1234567890-abcdef.apps.googleusercontent.com';
const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/';
const ENDPOINT = 'https://gemini.endpoint.test/v1beta';
/** Not credentials: fixed literals that authenticate nothing. */
const CODE = 'google-code-under-test';
const ACCESS = 'google-access-first';
const RENEWED = 'google-access-renewed';
const REFRESH = 'google-refresh-under-test';
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

let clock = NOW;
const now = (): number => clock;

/** Scripts the authorization window. */
class ScriptedFlow implements AuthFlowPort {
  constructor(private readonly reply: (url: string) => AuthFlowOutcome) {}
  run(request: { authorizationUrl: string }): Promise<AuthFlowOutcome> {
    return Promise.resolve(this.reply(request.authorizationUrl));
  }
}

function callbackFor(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
  const url = new URL(REDIRECT);
  url.searchParams.set('state', state);
  url.searchParams.set('code', CODE);
  return url.toString();
}

/** What the endpoint was actually asked, so routing can be asserted on it. */
interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
}

let seen: Seen[];
let tokenPosts: string[];
let tokenReply: { status: number; body: unknown };
let area: SerializedStorageArea;
let accounts: AccountStore;
let credentials: CredentialStore;

function recording(): ProviderTransport {
  return {
    request: (url, init) => {
      seen.push({
        url,
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        ),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    },
  };
}

function googleAuth(
  flow: AuthFlowPort = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) })),
): GoogleProviderAuth {
  return new GoogleProviderAuth({
    clientId: CLIENT,
    redirectUri: REDIRECT,
    authFlow: flow,
    post: (body) => {
      tokenPosts.push(body);
      return Promise.resolve(tokenReply);
    },
    requestPermission: () => Promise.resolve(true),
    now,
  });
}

/** The worker's wiring, assembled from the same parts it assembles. */
function credentialFor(connectionId: string): Promise<string | undefined> {
  return credentialForConnection(connectionId, {
    keyFor: (id) => credentials.getConnectionKey(id),
    tokensFor: (id) => credentials.getOAuthTokens(id),
    storeTokens: (id, tokens) => credentials.setOAuthTokens(id, tokens),
    needsRenewal: (tokens) => needsRefresh(tokens, now()),
    renew: async (refreshToken): Promise<RenewOutcome> => {
      const renewed = await googleAuth().refresh(refreshToken);
      if (!renewed.ok) return { ok: false };
      return { ok: true, tokens: toStored(renewed.token) };
    },
  });
}

function toStored(token: GoogleProviderToken): StoredOAuthTokens {
  return {
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    scope: token.scope,
  };
}

/** Steps 3–4: authorize, and store the result as a connected account. */
async function connectGoogleAccount(displayName = 'Google Gemini'): Promise<ConnectedAccount> {
  const authorized = await googleAuth().authorize(new AbortController().signal);
  if (!authorized.ok) throw new Error(`authorization failed: ${authorized.failure}`);

  const connectionId = accounts.mintConnectionId();
  // The credential first, then the record: the ordering the key path uses, and
  // for the same reason — a record whose credential never landed is an account
  // that fails at its first request with nothing to explain why.
  await credentials.setOAuthTokens(connectionId, toStored(authorized.token));

  const account: ConnectedAccount = {
    connectionId,
    abaUserId: 'unassigned',
    providerId: GEMINI_PROVIDER_ID,
    protocol: 'gemini',
    displayName,
    accountLabel: 'authorized with Google',
    authKind: 'oauth2',
    baseUrl: ENDPOINT,
    // No model. Discovery runs against the new credential and the user chooses
    // from what the account can actually use.
    modelId: null,
    capabilities: null,
    capabilityScope: null,
    status: 'connected',
    lastValidated: now(),
    createdAt: now(),
  };
  await accounts.put(account);
  return account;
}

async function resolve(account: ConnectedAccount): Promise<{ modelId: string }> {
  return resolveBrainAccount(account, {
    adapterFor: () => new GeminiAdapter(recording()),
    keyFor: (connectionId) => credentialFor(connectionId),
    staleMessage: (modelId) => `${modelId} is no longer offered.`,
  });
}

beforeEach(() => {
  clock = NOW;
  seen = [];
  tokenPosts = [];
  tokenReply = {
    status: 200,
    body: {
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
      scope: GOOGLE_AUTH.scope,
    },
  };
  area = new SerializedStorageArea(new MemoryStorageArea());
  accounts = new AccountStore(area);
  credentials = new CredentialStore(new MemoryStorageArea());
});

describe('01 — authorize, discover, select, run', () => {
  it('connects an account that holds no key and no model', async () => {
    const account = await connectGoogleAccount();

    expect(account.authKind).toBe('oauth2');
    // No model is chosen for the user. A default here would be this build
    // asserting something about somebody else's catalogue.
    expect(account.modelId).toBeNull();
    // The credential is an OAuth record, and the key slot is empty — an
    // account holding both would be two credentials that could disagree.
    expect(await credentials.getConnectionKey(account.connectionId)).toBeUndefined();
    expect((await credentials.getOAuthTokens(account.connectionId))?.accessToken).toBe(ACCESS);
  });

  it('discovers models from the endpoint with the authorized credential', async () => {
    const account = await connectGoogleAccount();
    const adapter = new GeminiAdapter(recording());
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      baseUrl: ENDPOINT,
      apiKey: (await credentialFor(account.connectionId))!,
      credentialScheme: 'bearer',
      model: 'gemini-2.5-flash',
    });

    const models = await adapter.listModels();
    // Real ids from the endpoint's own answer, not a list in this build.
    expect(models.map((model) => model.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(seen[0]!.headers['x-goog-api-key']).toBeUndefined();
  });

  it('refuses to run until a model is selected, and says so', async () => {
    const account = await connectGoogleAccount();
    // The honest state of a freshly authorized account: usable, with nothing
    // chosen. The refusal names the fix.
    await expect(resolve(account)).rejects.toThrow(/no model selected/i);
  });

  it('sends the selected model and the authorized credential', async () => {
    const account = await connectGoogleAccount();
    const chosen = accountAfterSelection(account, 'gemini-2.5-pro');
    await accounts.put(chosen);

    const resolved = await resolve(chosen);
    expect(resolved.modelId).toBe('gemini-2.5-pro');
    // The adapter was handed the token, not a key, and the token is not in
    // the URL — which the egress gate turns into a destination identity that
    // reaches consent records and audit rows.
    expect(seen).toHaveLength(0);

    const adapter = new GeminiAdapter(recording());
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      baseUrl: ENDPOINT,
      apiKey: (await credentialFor(chosen.connectionId))!,
      credentialScheme: 'bearer',
      model: chosen.modelId!,
    });
    await adapter.listModels();
    expect(seen[0]!.url.startsWith(ENDPOINT)).toBe(true);
    expect(seen[0]!.url).not.toContain(ACCESS);
  });
});

describe('02 — the credential expires, which the key path never does', () => {
  it('renews before a request rather than after one fails', async () => {
    const account = await connectGoogleAccount();
    expect(await credentialFor(account.connectionId)).toBe(ACCESS);
    expect(tokenPosts).toHaveLength(1);

    // One minute before expiry, which is inside the two-minute skew, so the
    // renewal happens now rather than mid-request. (Three minutes out is
    // outside it and must *not* renew — the case below pins that edge, and
    // writing this one at three minutes first is how the edge got checked.)
    clock = NOW + HOUR - 60 * 1000;
    tokenReply = {
      status: 200,
      body: { access_token: RENEWED, expires_in: 3600, scope: GOOGLE_AUTH.scope },
    };

    expect(await credentialFor(account.connectionId)).toBe(RENEWED);
    expect(tokenPosts).toHaveLength(2);
    expect(new URLSearchParams(tokenPosts[1]).get('grant_type')).toBe('refresh_token');
  });

  it('does not renew a token that is not due yet', async () => {
    const account = await connectGoogleAccount();
    // Three minutes before expiry: outside the skew. A build that renewed on
    // every read would spend a refresh token for nothing and would look
    // identical from the outside.
    clock = NOW + HOUR - 3 * 60 * 1000;
    expect(await credentialFor(account.connectionId)).toBe(ACCESS);
    expect(tokenPosts).toHaveLength(1);
  });

  it('writes the renewed token back, so one expiry costs one renewal', async () => {
    const account = await connectGoogleAccount();
    clock = NOW + HOUR;
    tokenReply = {
      status: 200,
      body: { access_token: RENEWED, expires_in: 3600, scope: GOOGLE_AUTH.scope },
    };

    expect(await credentialFor(account.connectionId)).toBe(RENEWED);
    const before = tokenPosts.length;
    // Two more reads, no more renewals.
    expect(await credentialFor(account.connectionId)).toBe(RENEWED);
    expect(await credentialFor(account.connectionId)).toBe(RENEWED);
    expect(tokenPosts).toHaveLength(before);
    // And the refresh token survived a renewal that did not reissue one.
    expect((await credentials.getOAuthTokens(account.connectionId))?.refreshToken).toBe(REFRESH);
  });

  it('does not retry a refused renewal, and reports no credential', async () => {
    const account = await connectGoogleAccount();
    const chosen = accountAfterSelection(account, 'gemini-2.5-flash');
    await accounts.put(chosen);

    clock = NOW + HOUR;
    tokenReply = { status: 400, body: { error: 'invalid_grant' } };

    expect(await credentialFor(account.connectionId)).toBeUndefined();
    const attempts = tokenPosts.length;
    // Asked again, and not retried: a revoked grant does not become valid by
    // being asked again, and a loop against one earns a rate limit.
    expect(await credentialFor(account.connectionId)).toBeUndefined();
    expect(tokenPosts).toHaveLength(attempts + 1);

    // And the refusal the user sees names the thing they have to do, which is
    // not "reconnect its API key" — they never had one.
    await expect(resolve(chosen)).rejects.toThrow(/authorizing again/i);
    await expect(resolve(chosen)).rejects.toBeInstanceOf(BrainUnavailable);
  });

  it('reports a connection with no refresh token as needing authorizing again', async () => {
    // Google issues no refresh token when the user has consented before and
    // the request did not force the screen. The access token is spent, and
    // sending it would be a request that fails for a reason the user cannot
    // see.
    tokenReply = {
      status: 200,
      body: { access_token: ACCESS, expires_in: 3600, scope: GOOGLE_AUTH.scope },
    };
    const account = await connectGoogleAccount();
    expect((await credentials.getOAuthTokens(account.connectionId))?.refreshToken).toBeUndefined();

    clock = NOW + HOUR;
    expect(await credentialFor(account.connectionId)).toBeUndefined();
    // No renewal was attempted: there was nothing to attempt it with.
    expect(tokenPosts).toHaveLength(1);
  });
});

describe('03 — two accounts, one endpoint, different credentials', () => {
  it('gives each request its own credential', async () => {
    const first = await connectGoogleAccount('Google (personal)');
    tokenReply = {
      status: 200,
      body: {
        access_token: 'google-access-second',
        refresh_token: 'google-refresh-second',
        expires_in: 3600,
        scope: GOOGLE_AUTH.scope,
      },
    };
    const second = await connectGoogleAccount('Google (work)');

    // The interesting failure is not the wrong provider. It is the right
    // provider and the wrong account — one adapter instance per provider
    // family is shared, and a credential left in it is a cross-account leak
    // no provider-level test can see.
    expect(await credentialFor(first.connectionId)).toBe(ACCESS);
    expect(await credentialFor(second.connectionId)).toBe('google-access-second');
    expect(first.connectionId).not.toBe(second.connectionId);
  });

  it('a key account and an authorized account coexist', async () => {
    const authorized = await connectGoogleAccount();
    const pasted = accounts.mintConnectionId();
    await credentials.setConnectionKey(pasted, 'gemini-key-under-test');

    expect(await credentialFor(authorized.connectionId)).toBe(ACCESS);
    expect(await credentialFor(pasted)).toBe('gemini-key-under-test');
    // Neither read reaches the other's storage key.
    expect(await credentials.getOAuthTokens(pasted)).toBeUndefined();
    expect(await credentials.getConnectionKey(authorized.connectionId)).toBeUndefined();
  });

  it('renewing one does not touch the other', async () => {
    const first = await connectGoogleAccount('Google (personal)');
    tokenReply = {
      status: 200,
      body: {
        access_token: 'google-access-second',
        refresh_token: 'google-refresh-second',
        expires_in: (10 * HOUR) / 1000,
        scope: GOOGLE_AUTH.scope,
      },
    };
    const second = await connectGoogleAccount('Google (work)');

    clock = NOW + HOUR;
    tokenReply = {
      status: 200,
      body: { access_token: RENEWED, expires_in: 3600, scope: GOOGLE_AUTH.scope },
    };
    expect(await credentialFor(first.connectionId)).toBe(RENEWED);
    // The second is not due, so it was not renewed and still holds its own.
    expect(await credentialFor(second.connectionId)).toBe('google-access-second');
  });
});

describe('04 — switching and disconnecting', () => {
  it('a switch changes which credential the next request carries', async () => {
    const first = await connectGoogleAccount('Google (personal)');
    tokenReply = {
      status: 200,
      body: {
        access_token: 'google-access-second',
        refresh_token: 'google-refresh-second',
        expires_in: 3600,
        scope: GOOGLE_AUTH.scope,
      },
    };
    const second = await connectGoogleAccount('Google (work)');

    await accounts.put(accountAfterSelection(first, 'gemini-2.5-flash'));
    await accounts.put(accountAfterSelection(second, 'gemini-2.5-pro'));

    await accounts.setBrain('unassigned', first.connectionId, 'gemini-2.5-flash');
    const chosenFirst = (await accounts.getBrainAccount('unassigned'))!;
    expect(await credentialFor(chosenFirst.connectionId)).toBe(ACCESS);
    expect((await resolve(chosenFirst)).modelId).toBe('gemini-2.5-flash');

    // Explicit, never silent.
    await accounts.setBrain('unassigned', second.connectionId, 'gemini-2.5-pro');
    const chosenSecond = (await accounts.getBrainAccount('unassigned'))!;
    expect(await credentialFor(chosenSecond.connectionId)).toBe('google-access-second');
    expect((await resolve(chosenSecond)).modelId).toBe('gemini-2.5-pro');
  });

  it('disconnecting clears the OAuth record, not just the key slot', async () => {
    // The failure to avoid: a disconnect that removes `conn:<id>` — which an
    // authorized account never had — and leaves a live refresh token behind.
    const account = await connectGoogleAccount();
    expect(await credentials.getOAuthTokens(account.connectionId)).toBeDefined();

    await accounts.remove(account.connectionId, {
      read: (connectionId) => credentialFor(connectionId),
      write: (connectionId, apiKey) => credentials.setConnectionKey(connectionId, apiKey),
      clear: (connectionId) => credentials.clearConnectionKey(connectionId),
    });

    expect(await credentials.getOAuthTokens(account.connectionId)).toBeUndefined();
    expect(await credentials.getConnectionKey(account.connectionId)).toBeUndefined();
    expect(await accounts.get(account.connectionId)).toBeUndefined();
  });

  it('a capability measurement does not survive a model change', async () => {
    // The same rule the key path has, checked here because an authorized
    // account arrives with `capabilities: null` and a measurement taken later
    // must still be scoped to the pair it was taken on.
    const account = await connectGoogleAccount();
    const measured: ConnectedAccount = {
      ...accountAfterSelection(account, 'gemini-2.5-flash'),
      capabilities: { ...UNKNOWN_CAPABILITIES, unverified: [], vision: true },
      capabilityScope: { connectionId: account.connectionId, modelId: 'gemini-2.5-flash' },
    };
    const switched = accountAfterSelection(measured, 'gemini-2.5-pro');
    expect(switched.capabilities).toBeNull();
    expect(switched.capabilityScope).toBeNull();
  });
});
