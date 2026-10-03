/**
 * TEST-SECURITY-077 — authorizing a Google account for the Gemini API.
 *
 * ## What this is and is not
 *
 * It is a provider credential obtained by OAuth: an access token bound to one
 * connected account, which the Gemini adapter presents as a bearer token. It
 * is **not** a sign-in to AI Browser Agent — nothing here creates a product
 * account, a session or an `abaUserId`, and the first group below asserts that
 * the two subsystems share no state, because the product requirement is
 * precisely that Google is a way to reach an AI account and not a login gate.
 *
 * ## The claims
 *
 * 1. **Google authorizes Google, and nothing else.** Exactly one provider is
 *    Google-authorizable, and the reason each other provider is not travels
 *    with a source. A user cannot be shown a Google button that implies their
 *    Anthropic subscription is reachable.
 * 2. **A public client, with no secret.** The exchange body carries a client
 *    id, a code, a verifier and a redirect, and no `client_secret` in any
 *    spelling — a Chrome Extension client has none, and sending an empty one
 *    would claim to be a confidential client whose secret is the empty string.
 * 3. **A narrowed grant is a failure, not a partial success.** Google's
 *    consent screen lets a user uncheck a scope, and a token without
 *    `cloud-platform` can neither list a model nor run one. Storing it would
 *    produce an account that looks connected and fails at first use.
 * 4. **The callback is untrusted.** Wrong redirect, wrong state, stale state,
 *    a provider error and a missing code are each refused with their own named
 *    reason, in an order where nothing is read off a URL that has not yet
 *    matched the redirect.
 * 5. **The credential goes in the header the service reads.** A bearer token
 *    in `x-goog-api-key` is an unauthenticated request carrying the user's
 *    credential, so the scheme comes from the account record and not from the
 *    shape of the string.
 *
 * ## No credential
 *
 * Every token here is a fixed literal that authenticates nothing, and no
 * request leaves the process: the token endpoint is a function supplied by the
 * test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GOOGLE_AUTH,
  PROVIDER_AUTHORIZATION,
  authorizationFor,
  isGoogleAuthorizable,
  providerAuthorization,
  supportsAccountDiscoveryFromGoogleIdentity,
} from '@/providers/accounts/authorization';
import {
  GoogleProviderAuth,
  namesAClientProblem,
  needsRefresh,
  prepareGoogleAuthorization,
  readGoogleCallback,
  readTokenResponse,
  refreshBody,
  tokenExchangeBody,
  type GoogleAuthResult,
} from '@/providers/oauth/google-provider-auth';
import { GEMINI_PROVIDER_ID, GeminiAdapter } from '@/providers/adapters/gemini';
import { ensureIdentityPermission, WebAuthFlow } from '@/providers/oauth/web-auth-flow';
import { providerAuthDestination, EGRESS_CHANNELS } from '@/security/egress/destination';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';

const ROOT = resolve(import.meta.dirname, '../../src');
const CLIENT = '1234567890-abcdef.apps.googleusercontent.com';
const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/';
/** Not credentials: fixed literals that authenticate nothing. */
const CODE = 'google-code-under-test';
const ACCESS = 'google-access-token-under-test';
const REFRESH = 'google-refresh-token-under-test';
const NOW = 1_700_000_000_000;

function file(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

/** Returns one scripted callback URL. */
class ScriptedFlow implements AuthFlowPort {
  seen: string[] = [];
  constructor(private readonly outcome: (url: string) => AuthFlowOutcome) {}
  run(request: { authorizationUrl: string }): Promise<AuthFlowOutcome> {
    this.seen.push(request.authorizationUrl);
    return Promise.resolve(this.outcome(request.authorizationUrl));
  }
}

/** Builds a callback for an authorization URL, as Google would. */
function callbackFor(authorizationUrl: string, overrides: Record<string, string> = {}): string {
  const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
  const url = new URL(REDIRECT);
  url.searchParams.set('state', state);
  url.searchParams.set('code', CODE);
  for (const [key, value] of Object.entries(overrides)) url.searchParams.set(key, value);
  return url.toString();
}

describe('01 — a Google connection authorizes Google, and says so about the rest', () => {
  it('names exactly one Google-authorizable provider', () => {
    // If a second one ever becomes true it will be because a vendor changed
    // something, and that is worth a failing test rather than a silent new
    // button.
    const google = PROVIDER_AUTHORIZATION.filter((entry) => entry.googleAuthorizable);
    expect(google.map((entry) => entry.providerId)).toEqual([GEMINI_PROVIDER_ID]);
    expect(isGoogleAuthorizable(GEMINI_PROVIDER_ID)).toBe(true);
    for (const other of ['openai-compatible', 'anthropic', 'nine-router']) {
      expect(isGoogleAuthorizable(other), other).toBe(false);
    }
  });

  it('gives every other provider a way in, and a reason Google is not it', () => {
    for (const entry of PROVIDER_AUTHORIZATION) {
      // Every provider can be connected somehow. A row offering nothing would
      // be a provider the user cannot use.
      expect(
        entry.methods.some((method) => method.kind === 'api_key'),
        entry.providerId,
      ).toBe(true);
      if (entry.googleAuthorizable) continue;
      // And the thing a user would reasonably expect — a subscription, a
      // Google authorization — is listed as unavailable with a source rather
      // than omitted.
      expect(entry.unavailable.length, entry.providerId).toBeGreaterThan(0);
      for (const item of entry.unavailable) {
        expect(item.reason.length, item.label).toBeGreaterThan(40);
        expect(item.source.startsWith('https://'), item.label).toBe(true);
      }
    }
  });

  it('states that a Google identity cannot enumerate AI accounts', () => {
    // The one claim the clarified requirement most invites: connect Gmail and
    // see your AI accounts. No vendor here offers it, and the answer is a
    // function rather than a comment so the panel can cite it.
    expect(supportsAccountDiscoveryFromGoogleIdentity()).toBe(false);
  });

  it('reports the Google method unavailable when no client id is compiled in', () => {
    const absent = authorizationFor(GEMINI_PROVIDER_ID, { googleClientConfigured: false });
    const method = absent!.methods.find((entry) => entry.kind === 'google_oauth');
    expect(method!.configured).toBe(false);
    // With a reason, so the panel disables the button and says why rather than
    // offering one that cannot work.
    expect(method!.unavailableReason).toMatch(/no Google OAuth client id/i);

    const present = authorizationFor(GEMINI_PROVIDER_ID, { googleClientConfigured: true });
    const enabled = present!.methods.find((entry) => entry.kind === 'google_oauth');
    expect(enabled!.configured).toBe(true);
    expect(enabled!.unavailableReason).toBeUndefined();
  });

  it('never reports configured from the table alone', () => {
    // The table carries a placeholder so that reading it without the build
    // state cannot report the method as available. A mutation deleting the
    // placeholder is caught here.
    const raw = PROVIDER_AUTHORIZATION.find(
      (entry) => entry.providerId === GEMINI_PROVIDER_ID,
    )!.methods.find((method) => method.kind === 'google_oauth');
    expect(raw!.configured).toBe(false);
  });

  it('discloses that a paid API is being connected', () => {
    for (const entry of providerAuthorization({ googleClientConfigured: true })) {
      expect(['paid_api', 'depends_on_endpoint']).toContain(entry.billing);
    }
    const gemini = authorizationFor(GEMINI_PROVIDER_ID, { googleClientConfigured: true })!;
    expect(gemini.billing).toBe('paid_api');
    // And the Google method says where the money goes, because an OAuth
    // consent screen does not.
    const method = gemini.methods.find((entry) => entry.kind === 'google_oauth')!;
    expect(method.requires).toMatch(/billed/i);
  });
});

describe('02 — the authorization request is a public client with PKCE', () => {
  it('sends S256, a state, and asks for a refresh token', async () => {
    const prepared = await prepareGoogleAuthorization(
      { clientId: CLIENT, redirectUri: REDIRECT },
      NOW,
    );
    const url = new URL(prepared.url);
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTH.authorizationEndpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Without both of these Google issues no refresh token, and the
    // connection dies silently at the first expiry.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('does not ask Google to add previously granted scopes', () => {
    // `include_granted_scopes` would make the token's reach depend on this
    // user's unrelated history with the client rather than on what this
    // connection asked for.
    const source = file('providers/oauth/google-provider-auth.ts');
    expect(source).not.toContain("set('include_granted_scopes'");
  });

  it('never puts the verifier in the URL', async () => {
    const prepared = await prepareGoogleAuthorization(
      { clientId: CLIENT, redirectUri: REDIRECT },
      NOW,
    );
    expect(prepared.url).not.toContain(prepared.pending.codeVerifier);
    // And two authorizations do not share one.
    const second = await prepareGoogleAuthorization(
      { clientId: CLIENT, redirectUri: REDIRECT },
      NOW,
    );
    expect(second.pending.codeVerifier).not.toBe(prepared.pending.codeVerifier);
    expect(second.pending.state).not.toBe(prepared.pending.state);
  });

  it('carries no client secret in any spelling', () => {
    const body = tokenExchangeBody({
      clientId: CLIENT,
      code: CODE,
      codeVerifier: 'verifier-under-test',
      redirectUri: REDIRECT,
    });
    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe(CLIENT);
    expect(form.get('code_verifier')).toBe('verifier-under-test');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    // Not absent-and-empty: absent. An empty secret is a claim to be a
    // confidential client.
    expect([...form.keys()].sort()).toEqual([
      'client_id',
      'code',
      'code_verifier',
      'grant_type',
      'redirect_uri',
    ]);
    // And the module holds no secret to send.
    const source = file('providers/oauth/google-provider-auth.ts');
    expect(source).not.toMatch(/client_secret['"]?\s*[,:]\s*['"][^'"]/);

    const renew = new URLSearchParams(refreshBody({ clientId: CLIENT, refreshToken: REFRESH }));
    expect([...renew.keys()].sort()).toEqual(['client_id', 'grant_type', 'refresh_token']);
  });

  it('passes a login hint only when the user supplied one', async () => {
    const without = await prepareGoogleAuthorization(
      { clientId: CLIENT, redirectUri: REDIRECT },
      NOW,
    );
    expect(new URL(without.url).searchParams.has('login_hint')).toBe(false);

    const with_ = await prepareGoogleAuthorization(
      { clientId: CLIENT, redirectUri: REDIRECT, loginHint: 'someone@example.test' },
      NOW,
    );
    expect(new URL(with_.url).searchParams.get('login_hint')).toBe('someone@example.test');
  });
});

describe('03 — the callback is untrusted, and each refusal is its own', () => {
  const pending = {
    state: 'state-under-test',
    codeVerifier: 'verifier-under-test',
    redirectUri: REDIRECT,
    createdAt: NOW,
  };

  it('refuses a callback at a different address before reading anything off it', () => {
    // The classic shape: a host that merely starts with the right one. The
    // code is present and must not be reached.
    const result = readGoogleCallback(
      `https://abcdefghijklmnop.chromiumapp.org.evil.test/?state=state-under-test&code=${CODE}`,
      pending,
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure).toBe('CALLBACK_INVALID');
  });

  it('reports the user declining as declining, not as a state problem', () => {
    const result = readGoogleCallback(`${REDIRECT}?error=access_denied`, pending, NOW);
    expect(result.ok === false && result.failure).toBe('DECLINED');
    // Google's own code, not its description — the description is text on a
    // URL anyone can navigate to.
    expect(result.ok === false && result.reason).toContain('access_denied');
  });

  it('refuses a mismatched and a missing state', () => {
    for (const url of [`${REDIRECT}?state=other&code=${CODE}`, `${REDIRECT}?code=${CODE}`]) {
      const result = readGoogleCallback(url, pending, NOW);
      expect(result.ok === false && result.failure, url).toBe('STATE_MISMATCH');
    }
  });

  it('refuses a state that has gone stale', () => {
    const result = readGoogleCallback(
      `${REDIRECT}?state=state-under-test&code=${CODE}`,
      pending,
      NOW + 60 * 60 * 1000,
    );
    expect(result.ok === false && result.failure).toBe('STATE_EXPIRED');
  });

  it('refuses a callback with no authorization in progress', () => {
    const result = readGoogleCallback(`${REDIRECT}?state=x&code=${CODE}`, undefined, NOW);
    expect(result.ok === false && result.failure).toBe('CALLBACK_INVALID');
  });

  it('accepts the one shape that is correct', () => {
    const result = readGoogleCallback(
      `${REDIRECT}?state=state-under-test&code=${CODE}`,
      pending,
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.code).toBe(CODE);
  });
});

describe('04 — a narrowed grant is a failure', () => {
  it('refuses a token that did not get the scope it asked for', () => {
    const narrowed = readTokenResponse(
      {
        access_token: ACCESS,
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/userinfo.email',
      },
      NOW,
    );
    expect('error' in narrowed && narrowed.error).toBe('SCOPE_NOT_GRANTED');
    // A sentence a person can act on: authorize again and leave it selected.
    expect('error' in narrowed && narrowed.reason).toMatch(/authorize again/i);
  });

  it('accepts the scope Google’s own Gemini OAuth guide uses', () => {
    const token = readTokenResponse(
      { access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH, scope: GOOGLE_AUTH.scope },
      NOW,
    );
    expect('error' in token).toBe(false);
    expect('error' in token ? null : token.accessToken).toBe(ACCESS);
    expect('error' in token ? null : token.refreshToken).toBe(REFRESH);
    expect('error' in token ? 0 : token.expiresAt).toBe(NOW + 3_600_000);
  });

  it('treats a token with no stated lifetime as already needing refresh', () => {
    const token = readTokenResponse({ access_token: ACCESS, scope: GOOGLE_AUTH.scope }, NOW);
    expect('error' in token).toBe(false);
    // Rather than valid forever, which is the permissive reading and the one
    // that produces a connection failing at an unpredictable moment.
    expect('error' in token ? false : needsRefresh(token, NOW)).toBe(true);
  });

  it('refreshes before expiry rather than after it', () => {
    const token = { expiresAt: NOW + 10 * 60 * 1000 };
    expect(needsRefresh(token, NOW)).toBe(false);
    // Two minutes of skew: a request started just before expiry must not
    // arrive just after it.
    expect(needsRefresh(token, NOW + 9 * 60 * 1000)).toBe(true);
  });

  it('refuses a reply with no token and one that is not an object', () => {
    for (const body of [null, 'nope', {}, { access_token: '' }]) {
      const result = readTokenResponse(body, NOW);
      expect('error' in result && result.error, JSON.stringify(body)).toBe('EXCHANGE_FAILED');
    }
  });
});

describe('05 — the whole flow, with no network and no credential', () => {
  let posted: string[];
  let permissionAsked: number;
  let granted: boolean;

  function auth(
    flow: AuthFlowPort,
    reply: { status: number; body: unknown },
    clientId: string | null = CLIENT,
  ): GoogleProviderAuth {
    return new GoogleProviderAuth({
      clientId,
      redirectUri: REDIRECT,
      authFlow: flow,
      post: (body) => {
        posted.push(body);
        return Promise.resolve(reply);
      },
      requestPermission: () => {
        permissionAsked += 1;
        return Promise.resolve(granted);
      },
      now: () => NOW,
    });
  }

  const good = {
    status: 200,
    body: {
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
      scope: GOOGLE_AUTH.scope,
    },
  };

  beforeEach(() => {
    posted = [];
    permissionAsked = 0;
    granted = true;
  });

  it('authorizes, exchanges, and never sends the code anywhere else', async () => {
    const flow = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) }));
    const result = await auth(flow, good).authorize(new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.token.accessToken).toBe(ACCESS);
    // One exchange, carrying the code once.
    expect(posted).toHaveLength(1);
    expect(new URLSearchParams(posted[0]).get('code')).toBe(CODE);
    // The code is not in the authorization URL, which is the only thing the
    // browser saw.
    expect(flow.seen[0]).not.toContain(CODE);
  });

  it('asks for the permission before opening anything, and stops if declined', async () => {
    granted = false;
    const flow = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) }));
    const result = await auth(flow, good).authorize(new AbortController().signal);

    expect(result.ok === false && result.failure).toBe('PERMISSION_DENIED');
    expect(permissionAsked).toBe(1);
    // Nothing was opened and nothing was exchanged: a declined dialog leaves
    // the user exactly where they were.
    expect(flow.seen).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('asks for no permission at all when the build has no client id', async () => {
    const flow = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) }));
    const result = await auth(flow, good, null).authorize(new AbortController().signal);

    expect(result.ok === false && result.failure).toBe('NOT_CONFIGURED');
    // The order matters: a build that cannot do this must not show the user a
    // permission dialog first.
    expect(permissionAsked).toBe(0);
    expect(flow.seen).toEqual([]);
  });

  it('reports a cancelled window as cancelled', async () => {
    const flow = new ScriptedFlow(() => ({ kind: 'cancelled', reason: 'the window was closed' }));
    const result = await auth(flow, good).authorize(new AbortController().signal);
    expect(result.ok === false && result.failure).toBe('CANCELLED');
    expect(posted).toEqual([]);
  });

  it('reports a refused exchange without echoing Google’s reply', async () => {
    const flow = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) }));
    const result = await auth(flow, {
      status: 400,
      body: { error: 'invalid_grant', error_description: `code ${CODE} is bad` },
    }).authorize(new AbortController().signal);

    expect(result.ok === false && result.failure).toBe('EXCHANGE_FAILED');
    // A token endpoint's error body can echo the authorization code back.
    expect(result.ok === false && result.reason).not.toContain(CODE);
  });

  it('keeps the stored refresh token when renewing', async () => {
    const flow = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) }));
    const renewed: GoogleAuthResult = await auth(flow, {
      status: 200,
      // Google does not reissue a refresh token on a renewal.
      body: { access_token: 'renewed-access-token', expires_in: 3600, scope: GOOGLE_AUTH.scope },
    }).refresh(REFRESH);

    expect(renewed.ok).toBe(true);
    expect(renewed.ok === true && renewed.token.accessToken).toBe('renewed-access-token');
    expect(renewed.ok === true && renewed.token.refreshToken).toBe(REFRESH);
  });

  it('does not retry a refused renewal', async () => {
    const flow = new ScriptedFlow((url) => ({ kind: 'callback', url: callbackFor(url) }));
    const result = await auth(flow, { status: 400, body: { error: 'invalid_grant' } }).refresh(
      REFRESH,
    );
    expect(result.ok === false && result.failure).toBe('EXCHANGE_FAILED');
    // One attempt. A revoked grant does not become valid by being asked
    // again, and a loop against one is how a client gets rate-limited.
    expect(posted).toHaveLength(1);
  });
});

describe('06 — the credential goes in the header the service reads', () => {
  it('sends a bearer token as Authorization and never in the key header', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const adapter = new GeminiAdapter({
      request: (url, init) => {
        seen.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
        return Promise.resolve(
          new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    const connected = await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: ACCESS,
      credentialScheme: 'bearer',
      model: 'gemini-2.5-flash',
    });
    expect(connected.authenticated).toBe(true);
    // A label that does not claim the user pasted a key.
    expect(connected.accountLabel).toMatch(/authorized with Google/i);

    await adapter.listModels();
    const headers = Object.fromEntries(
      Object.entries(seen[0]!.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(headers.authorization).toBe(`Bearer ${ACCESS}`);
    // Not present and empty: absent. An empty key header beside a bearer
    // token is a second, blank credential on the request.
    expect(headers['x-goog-api-key']).toBeUndefined();
    // And never in the URL, which the egress gate turns into a destination
    // identity that reaches consent records and audit rows.
    expect(seen[0]!.url).not.toContain(ACCESS);
  });

  it('still sends a pasted key in the key header and no Authorization', async () => {
    const seen: Record<string, string>[] = [];
    const adapter = new GeminiAdapter({
      request: (_url, init) => {
        seen.push((init.headers ?? {}) as Record<string, string>);
        return Promise.resolve(
          new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: 'gemini-key-under-test',
      model: 'gemini-2.5-flash',
    });
    await adapter.listModels();
    const headers = Object.fromEntries(
      Object.entries(seen[0]!).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(headers['x-goog-api-key']).toBe('gemini-key-under-test');
    expect(headers.authorization).toBeUndefined();
  });

  it('decides the scheme from the account record, not from the string', () => {
    // Both credentials are opaque strings, so an adapter that guessed would
    // send one in the header the endpoint ignores — an unauthenticated
    // request carrying the user's credential.
    const source = file('providers/accounts/resolve-brain.ts');
    expect(source).toContain("account.authKind === 'oauth2' ? 'bearer' : 'api_key'");
  });
});

describe('06b — a misconfigured client is reported as that, not as the user’s fault', () => {
  const pending = {
    state: 'state-under-test',
    codeVerifier: 'verifier-under-test',
    redirectUri: REDIRECT,
    createdAt: NOW,
  };

  it('separates a wrong client registration from a user declining', () => {
    // Google pins a Chrome Extension client to **one** extension id, and an
    // unpacked build has a different id from a published one. Reporting that
    // as "Google refused the authorization" sends a user hunting through
    // their own Google account for a problem in the build.
    for (const code of ['redirect_uri_mismatch', 'invalid_client', 'unauthorized_client']) {
      const result = readGoogleCallback(`${REDIRECT}?error=${code}`, pending, NOW);
      expect(result.ok === false && result.failure, code).toBe('CLIENT_MISMATCH');
      // The sentence names whose problem it is and where the fix is written.
      expect(result.ok === false && result.reason).toMatch(/extension id/i);
      expect(result.ok === false && result.reason).toMatch(/G-6/);
      // And offers the path that does work in the meantime.
      expect(result.ok === false && result.reason).toMatch(/API key/i);
    }

    // A user saying no is still a user saying no.
    const declined = readGoogleCallback(`${REDIRECT}?error=access_denied`, pending, NOW);
    expect(declined.ok === false && declined.failure).toBe('DECLINED');
  });

  it('reads one field of a token-endpoint refusal and nothing else', () => {
    expect(namesAClientProblem({ error: 'invalid_client' })).toBe(true);
    expect(namesAClientProblem({ error: 'redirect_uri_mismatch' })).toBe(true);
    expect(namesAClientProblem({ error: 'invalid_grant' })).toBe(false);
    for (const nothing of [null, undefined, 'invalid_client', 42, {}, { error: 42 }]) {
      expect(namesAClientProblem(nothing), JSON.stringify(nothing)).toBe(false);
    }
    // A boolean, so nothing from the body can reach a message, a log or a
    // record — a token endpoint's error body can echo the authorization code.
    expect(typeof namesAClientProblem({ error: 'invalid_client' })).toBe('boolean');
  });

  it('does not echo Google’s description, which can carry the code back', () => {
    const result = readGoogleCallback(
      `${REDIRECT}?error=invalid_client&error_description=${encodeURIComponent(`code ${CODE} rejected`)}`,
      pending,
      NOW,
    );
    expect(result.ok === false && result.reason).not.toContain(CODE);
  });
});

describe('06c — an OAuth-authorized call names a quota project', () => {
  it('sends x-goog-user-project with a bearer credential and not with a key', async () => {
    // Google documents that a user-credential call to a client-based API must
    // name a project for billing and quota, and answers one that does not
    // with a message saying exactly that. A key carries its own project, so a
    // key request must not send this — it would name a second project for one
    // call.
    const seen: Record<string, string>[] = [];
    const adapter = new GeminiAdapter({
      request: (_url, init) => {
        seen.push(
          Object.fromEntries(
            Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ]),
          ),
        );
        return Promise.resolve(
          new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });

    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: ACCESS,
      credentialScheme: 'bearer',
      quotaProject: 'my-project-1',
      model: 'gemini-2.5-flash',
    });
    await adapter.listModels();
    expect(seen[0]!['x-goog-user-project']).toBe('my-project-1');

    const keyed = new GeminiAdapter({
      request: (_url, init) => {
        seen.push(
          Object.fromEntries(
            Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ]),
          ),
        );
        return Promise.resolve(
          new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    await keyed.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: 'gemini-key-under-test',
      quotaProject: 'my-project-1',
      model: 'gemini-2.5-flash',
    });
    await keyed.listModels();
    expect(seen[1]!['x-goog-user-project']).toBeUndefined();
  });

  it('omits the header rather than sending it empty when none is configured', async () => {
    const seen: Record<string, string>[] = [];
    const adapter = new GeminiAdapter({
      request: (_url, init) => {
        seen.push(
          Object.fromEntries(
            Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
              k.toLowerCase(),
              v,
            ]),
          ),
        );
        return Promise.resolve(
          new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: ACCESS,
      credentialScheme: 'bearer',
      model: 'gemini-2.5-flash',
    });
    await adapter.listModels();
    // Absent, not empty: an empty value is a project id Google cannot resolve.
    expect('x-goog-user-project' in seen[0]!).toBe(false);
  });

  it('turns Google’s quota-project refusal into a sentence naming the setting', async () => {
    // The failure an owner would otherwise hit immediately after G-6: a 403
    // whose shared message is "the key was accepted but is not permitted to
    // use this model", which mentions a key they do not have and sends them
    // to change a model that is fine.
    const adapter = new GeminiAdapter({
      request: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 403,
                status: 'PERMISSION_DENIED',
                message:
                  'Your application is authenticating by using local Application Default ' +
                  'Credentials. The generativelanguage.googleapis.com API requires a quota ' +
                  'project, which is not set by default.',
              },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    });
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: ACCESS,
      credentialScheme: 'bearer',
      model: 'gemini-2.5-flash',
    });

    // `validateConnection`, not `listModels`: the latter returns an empty list
    // on a refusal by design, so it produces no message to assert on. This is
    // the path the connect flow and the capability check take.
    const health = await adapter.validateConnection();
    const message = JSON.stringify(health);
    expect(message).toMatch(/Cloud project/i);
    expect(message).toMatch(/G-6|API key/);
    // And it does not tell them to change the model.
    expect(message).not.toMatch(/not permitted to use this model/);
  });

  it('keeps the shared message for a key request that says the same thing', async () => {
    // The phrase is only read for a bearer credential. A key request cannot be
    // short a quota project, so matching it there would be a coincidence
    // producing a confusing message.
    const adapter = new GeminiAdapter({
      request: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 403, status: 'PERMISSION_DENIED', message: 'quota project missing' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    });
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: 'gemini-key-under-test',
      model: 'gemini-2.5-flash',
    });
    expect(JSON.stringify(await adapter.validateConnection())).toMatch(
      /not permitted to use this model/,
    );
  });

  it('tells an authorized account to re-authorize rather than check its key', async () => {
    const adapter = new GeminiAdapter({
      request: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    });
    await adapter.connect({
      providerId: GEMINI_PROVIDER_ID,
      apiKey: ACCESS,
      credentialScheme: 'bearer',
      model: 'gemini-2.5-flash',
    });
    const health = JSON.stringify(await adapter.validateConnection());
    expect(health).toMatch(/Connect the Google account again/i);
    expect(health).not.toMatch(/API key was rejected/);
  });
});

describe('07 — this is not a sign-in, and shares nothing with one', () => {
  it('names no identity module', () => {
    // The product requirement is that Google reaches an AI account and is not
    // a login gate. A provider authorization that imported the session store
    // or the auth controller would be one edit away from becoming one.
    // Checked on the **code** with comments stripped: the module explains at
    // length that it produces no `abaUserId`, and an assertion on the raw text
    // fails on the explanation — which is the wrong thing to pin, and the
    // same mistake this project has now made twice.
    const source = file('providers/oauth/google-provider-auth.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const forbidden of [
      '@/identity/session-store',
      '@/identity/auth-controller',
      '@/identity/identity-client',
      '@/identity/identity-config',
      'abaUserId',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('uses its own egress channel, not the identity one', () => {
    // `identity` reaches this project's own backend to establish a product
    // account. This reaches a third party for a provider credential. Sharing
    // a channel would let one subsystem's reasoning read as though it applied
    // to the other.
    expect(EGRESS_CHANNELS).toContain('provider_auth');
    const destination = providerAuthDestination(
      GEMINI_PROVIDER_ID,
      GOOGLE_AUTH.tokenEndpoint,
      GOOGLE_AUTH.tokenEndpoint,
    );
    expect(destination.channel).toBe('provider_auth');
    expect(destination.identity).toBe(
      `provider-auth:${GEMINI_PROVIDER_ID}@https://oauth2.googleapis.com`,
    );
  });

  it('denies a token exchange aimed anywhere but the pinned endpoint', () => {
    // A `null` identity is what the gate refuses, so an off-origin exchange is
    // refused by the rule that refuses every unrecognisable destination rather
    // than by a check somebody has to remember to write.
    for (const url of [
      'https://oauth2.googleapis.com.evil.test/token',
      'https://accounts.google.com/token',
      'http://oauth2.googleapis.com/token',
    ]) {
      expect(
        providerAuthDestination(GEMINI_PROVIDER_ID, GOOGLE_AUTH.tokenEndpoint, url).identity,
        url,
      ).toBeNull();
    }
  });

  it('is reachable without signing in to anything', () => {
    // The worker's route creates an account and a credential and touches no
    // session. `currentAbaUserId()` is read as a *scoping label* — the same
    // thing the API-key path reads — and `local-identity.ts` mints one for
    // every installation whether anybody has signed in or not.
    const worker = file('background/service-worker.ts');
    const route = worker.slice(worker.indexOf("router.on('accounts.connectGoogle'"));
    const body = route.slice(0, route.indexOf("router.on('accounts.disconnect'"));
    expect(body).toContain('currentAbaUserId()');
    for (const forbidden of ['authController', 'sessionStore', 'signInWithGoogle']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

describe('08 — the permission is optional, asked once, and narrow', () => {
  it('asks for identity and nothing else', async () => {
    const asked: string[][] = [];
    const granted = await ensureIdentityPermission({
      contains: () => Promise.resolve(false),
      request: (permissions) => {
        asked.push([...permissions.permissions]);
        return Promise.resolve(true);
      },
    });
    expect(granted).toBe(true);
    expect(asked).toEqual([['identity']]);
  });

  it('does not ask again when it is already held', async () => {
    let requests = 0;
    const granted = await ensureIdentityPermission({
      contains: () => Promise.resolve(true),
      request: () => {
        requests += 1;
        return Promise.resolve(true);
      },
    });
    expect(granted).toBe(true);
    expect(requests).toBe(0);
  });

  it('treats a declined or failing dialog as not granted', async () => {
    expect(
      await ensureIdentityPermission({
        contains: () => Promise.resolve(false),
        request: () => Promise.resolve(false),
      }),
    ).toBe(false);
    expect(
      await ensureIdentityPermission({
        contains: () => Promise.reject(new Error('no')),
        request: () => Promise.reject(new Error('no')),
      }),
    ).toBe(false);
  });

  it('refuses a redirect the flow did not register', async () => {
    // Chrome should only ever resolve on the extension's own virtual
    // redirect. A port that passed an arbitrary URL back as a callback would
    // be handing its caller something it is entitled to assume about.
    const flow = new WebAuthFlow({
      launchWebAuthFlow: () => Promise.resolve('https://elsewhere.example.test/?code=x'),
    });
    const outcome = await flow.run(
      {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        redirectUri: REDIRECT,
        timeoutMs: 1000,
      },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('cancelled');
  });

  it('reports a rejection and an empty answer as cancellation, not a crash', async () => {
    for (const result of [
      () => Promise.reject(new Error('The user closed the window.')),
      () => Promise.resolve(undefined),
      () => Promise.resolve(''),
    ]) {
      const outcome = await new WebAuthFlow({ launchWebAuthFlow: result }).run(
        {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          redirectUri: REDIRECT,
          timeoutMs: 1000,
        },
        new AbortController().signal,
      );
      expect(outcome.kind).toBe('cancelled');
    }
  });
});
