/**
 * TEST-CONNECTOR-007 — connecting with a token the user supplied.
 *
 * ## Why this path exists, and why it is tested this hard
 *
 * It was added because the authorization-code flow this build runs **cannot be
 * completed against any of its roadmap services**. GitHub's web application
 * flow requires `client_secret` in the code exchange, PKCE or not; Atlassian
 * requires one and supports no PKCE at all; Figma requires one even with PKCE.
 * `ConnectorOAuthConfig` deliberately carries no secret. So a token the user
 * creates in their own account is not an alternative to the flow here — it is
 * the only mechanism that works, and that makes it the thing standing between
 * this build and a connector anybody can actually use.
 *
 * ## The two properties that carry the weight
 *
 * **Nothing is stored before the service has been asked.** The other order
 * would mean a worker evicted between the write and the check leaves an
 * unverified token in the vault, and `reconcile` reads the vault, sees a
 * connection and reports `READY` — forever, because nothing re-checks it.
 * Several cases below assert the vault is *empty* after a refusal, which is
 * the only way to observe that ordering from outside.
 *
 * **An unknown scope set is not an empty one.** GitHub returns no
 * `x-oauth-scopes` header for a fine-grained token, so what the token may do
 * is not established. The session records nothing, every write refuses, and
 * the outcome says `scopesEstablished: false` so the user is told *why* rather
 * than being shown an empty permission list as though the service had answered.
 *
 * No credential of any kind is used. The token strings here are literals that
 * mean nothing to anybody, and the service's side is a function this file
 * supplies.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea } from '@/storage/storage-area';
import { TokenVault } from '@/connectors/oauth/token-vault';
import {
  ConnectorSession,
  TokenRejected,
  type ConnectorStatus,
  type SuppliedCredential,
  type TokenIntrospection,
} from '@/connectors/core/connector-session';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';
import { githubDescriptor, readGitHubTokenProbe } from '@/connectors/adapters/github';

const NOW = 1_700_000_000_000;
const REDIRECT = 'https://redirect.test/oauth/callback';
/** Not a credential: a fixed string that is not a token for anything. */
const SUPPLIED = 'supplied-token-under-test';

const tokenDescriptor = githubDescriptor({
  apiOrigin: 'https://api.github.test',
  redirectUri: REDIRECT,
  authKind: 'api_token',
});

const flowDescriptor = githubDescriptor({
  apiOrigin: 'https://api.github.test',
  redirectUri: REDIRECT,
  authKind: 'oauth2',
});

class UnusedFlow implements AuthFlowPort {
  ran = 0;
  run(): Promise<AuthFlowOutcome> {
    this.ran += 1;
    return Promise.resolve({ kind: 'cancelled', reason: 'the flow must not be reached' });
  }
}

let vault: TokenVault;
let area: MemoryStorageArea;
let flow: UnusedFlow;
let statuses: ConnectorStatus[];
/** Credentials the introspector was handed, in order. */
let asked: SuppliedCredential[];
/**
 * Every storage key that existed at the moment the introspector ran.
 *
 * Keys rather than one key read by name. A named read returns `undefined` both
 * when nothing is stored and when the name is wrong, so a test built on one
 * passes while proving nothing — which is how the first draft of this file was
 * written, with a key that did not exist. The case below that reads these also
 * asserts the keys are non-empty *after* a successful connect, so the probe is
 * known to be able to see something.
 */
let vaultWhenAsked: string[][];

function build(options: {
  descriptor?: typeof tokenDescriptor;
  introspect?: (credential: SuppliedCredential) => Promise<TokenIntrospection>;
  omitIntrospect?: boolean;
}): ConnectorSession {
  const introspect =
    options.introspect ??
    ((): Promise<TokenIntrospection> => Promise.resolve({ scopes: ['public_repo'] }));

  return new ConnectorSession({
    descriptor: options.descriptor ?? tokenDescriptor,
    vault,
    authFlow: flow,
    clientId: '',
    exchange: () => Promise.reject(new Error('the exchange must not be reached')),
    now: () => NOW,
    onStatusChange: (status) => statuses.push(status),
    ...(options.omitIntrospect === true
      ? {}
      : {
          introspect: async (credential) => {
            asked.push(credential);
            vaultWhenAsked.push(await area.keys());
            return await introspect(credential);
          },
        }),
  });
}

/** Everything in storage, as a string, for "the token is not in here" checks. */
async function storedText(): Promise<string> {
  const keys = await area.keys();
  const parts: string[] = [];
  for (const key of keys) parts.push(key, JSON.stringify((await area.get(key)) ?? null));
  return parts.join('\n');
}

beforeEach(() => {
  area = new MemoryStorageArea();
  vault = new TokenVault(area);
  flow = new UnusedFlow();
  statuses = [];
  asked = [];
  vaultWhenAsked = [];
});

describe('the credential is checked before anything is written', () => {
  it('asks the service while the vault is still empty', async () => {
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(asked).toHaveLength(1);
    // The observation the ordering rests on. A non-empty list here means a
    // worker evicted mid-connect leaves an unverified token behind.
    expect(vaultWhenAsked[0]).toEqual([]);
    // And the control: the same probe, after the write, sees the write. An
    // empty answer above is a fact about the ordering and not about the probe.
    expect(await area.keys()).not.toEqual([]);
  });

  it('stores nothing at all when the service refuses the token', async () => {
    const session = build({ introspect: () => Promise.reject(new TokenRejected()) });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('NEEDS_AUTH');
    expect(outcome.status.reason).toBe('token_rejected');
    expect(await area.keys()).toEqual([]);
    expect(await vault.isUsable('github', NOW)).toBe(false);
  });

  it('stores nothing when the service could not be asked, and says which', async () => {
    // A different sentence for the user, because it sends them somewhere
    // else: a refused token needs another token, an unreachable service needs
    // trying again.
    const session = build({ introspect: () => Promise.reject(new Error('network down')) });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('NEEDS_AUTH');
    expect(outcome.status.reason).toBe('token_unverified');
    expect(await area.keys()).toEqual([]);
  });

  it('never runs an authorization flow', async () => {
    // There is no flow to run. One starting here would mean a redirect, a
    // client id this build does not have, and a code exchange needing a
    // secret it must not hold.
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    expect(flow.ran).toBe(0);
  });
});

describe('what a successful connection records', () => {
  it('reaches READY only through AUTHENTICATING, like every other route', async () => {
    const session = build({});
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('READY');
    expect(outcome.status.reason).toBe('authenticated');
    expect(statuses.map((status) => status.state)).toEqual([
      'NEEDS_AUTH',
      'AUTHENTICATING',
      'READY',
    ]);
  });

  it('stores the token under the scheme it was given', async () => {
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    // Read through the vault's own accessor, because the header is what the
    // transport will actually attach.
    expect(await vault.authorizationHeader('github', NOW)).toBe(`Bearer ${SUPPLIED}`);
  });

  it('stores the scheme it was given rather than assuming one', async () => {
    // `Bearer` for GitHub, and `Basic` for a service that wants
    // base64(email:token) — Jira is the one on the roadmap that does. A
    // hard-coded scheme would send the wrong header and the connector would
    // fail at the service with nothing in this build to explain why. The
    // mutation that pins this is `tokenType: 'Bearer'`, which every other
    // case here passes.
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Basic' });
    expect(await vault.authorizationHeader('github', NOW)).toBe(`Basic ${SUPPLIED}`);
  });

  it('records the scopes the service confirmed, and no others', async () => {
    const session = build({ introspect: () => Promise.resolve({ scopes: ['public_repo'] }) });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.scopesEstablished).toBe(true);
    expect(outcome.status.scopes).toEqual(['public_repo']);
    expect(session.hasScopes(['public_repo'])).toBe(true);
  });

  it('keeps the account label, which is a name and not a credential', async () => {
    const session = build({
      introspect: () => Promise.resolve({ scopes: [], accountLabel: 'someone' }),
    });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    expect(outcome.status.accountLabel).toBe('someone');
  });

  it('sets no expiry, because a token the user made does not expire on a schedule', async () => {
    // Inventing one would make a working connector stop working for no reason.
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    const summary = await vault.summary('github', NOW + 400 * 24 * 60 * 60 * 1000);
    expect(summary.connected).toBe(true);
  });
});

describe('a token whose reach the service would not state', () => {
  it('records no scopes and says they were not established', async () => {
    const session = build({ introspect: () => Promise.resolve({ scopes: null }) });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('READY');
    expect(outcome.scopesEstablished).toBe(false);
    expect(outcome.status.scopes).toEqual([]);
  });

  it('refuses every operation that needs a scope', async () => {
    // The point of recording nothing. The alternative — claiming the scopes
    // the descriptor wanted — buys a write that fails at the service after
    // the user has already approved it.
    const session = build({ introspect: () => Promise.resolve({ scopes: null }) });
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    expect(session.hasScopes(['public_repo'])).toBe(false);
    // And still permits the ones that need none, which is what makes an
    // unknown-scope token useful rather than useless.
    expect(session.hasScopes([])).toBe(true);
  });

  it('is distinguishable from a token the service said has no scopes', async () => {
    const unknown = build({ introspect: () => Promise.resolve({ scopes: null }) });
    const none = build({ introspect: () => Promise.resolve({ scopes: [] }) });

    const unknownOutcome = await unknown.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    const noneOutcome = await none.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    // Identical scope lists, different facts. Only the flag separates them,
    // which is why it is reported rather than derived from the list.
    expect(unknownOutcome.status.scopes).toEqual(noneOutcome.status.scopes);
    expect(unknownOutcome.scopesEstablished).toBe(false);
    expect(noneOutcome.scopesEstablished).toBe(true);
  });
});

describe('a connector that has no token path cannot be talked onto one', () => {
  it('refuses when the descriptor says oauth2', async () => {
    const session = build({ descriptor: flowDescriptor });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('UNAVAILABLE');
    expect(await area.keys()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('refuses when no introspector was wired, rather than storing unchecked', async () => {
    // A session built without one has no way to check a credential. Storing
    // it anyway would be a connector that reports READY on anything pasted.
    const session = build({ omitIntrospect: true });
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('UNAVAILABLE');
    expect(await area.keys()).toEqual([]);
  });

  it('refuses an empty token without asking the service', async () => {
    const session = build({});
    const outcome = await session.connectWithToken({ token: '', tokenType: 'Bearer' });

    expect(outcome.status.reason).toBe('token_rejected');
    expect(asked).toEqual([]);
  });
});

describe('replacing and discarding a token', () => {
  it('accepts a new token while one is already held', async () => {
    // The ordinary case after the user rotates or revokes one. There is no
    // READY -> AUTHENTICATING edge, so this has to step back through
    // NEEDS_AUTH — which is also the truth: in between, nothing is connected.
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    statuses.length = 0;

    const outcome = await session.connectWithToken({
      token: 'a-second-token',
      tokenType: 'Bearer',
    });
    expect(outcome.status.state).toBe('READY');
    expect(statuses.map((status) => status.state)).toEqual([
      'NEEDS_AUTH',
      'AUTHENTICATING',
      'READY',
    ]);
    expect(await vault.authorizationHeader('github', NOW)).toBe('Bearer a-second-token');
  });

  it('leaves the old token in place when the new one is refused', async () => {
    // A rejected replacement must not disconnect a connector that was
    // working: the user would have lost a connection by typing a typo.
    let refuse = false;
    const session = build({
      introspect: () =>
        refuse ? Promise.reject(new TokenRejected()) : Promise.resolve({ scopes: ['public_repo'] }),
    });
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    refuse = true;
    const outcome = await session.connectWithToken({ token: 'wrong', tokenType: 'Bearer' });
    expect(outcome.status.state).toBe('NEEDS_AUTH');
    expect(await vault.authorizationHeader('github', NOW)).toBe(`Bearer ${SUPPLIED}`);
  });

  it('cannot be reconnected while the service has refused access', async () => {
    // DENIED is terminal until the connector is reset, and that rule is not
    // suspended for this path.
    const session = build({});
    session.markAccessRefused();
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    expect(outcome.status.state).toBe('DENIED');
    expect(asked).toEqual([]);

    await session.disconnect();
    const after = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    expect(after.status.state).toBe('READY');
  });

  it('forgets the token on disconnect', async () => {
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });
    await session.disconnect();

    expect(await vault.authorizationHeader('github', NOW)).toBeNull();
    expect(await storedText()).not.toContain(SUPPLIED);
  });
});

describe('the token stays inside the vault', () => {
  it('is in no status the session ever published', async () => {
    const session = build({});
    const outcome = await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    // Every status change, not just the last: a credential that appeared in
    // an intermediate one would reach every `onStatusChange` listener,
    // including the audit record the worker writes from it.
    expect(JSON.stringify(statuses)).not.toContain(SUPPLIED);
    expect(JSON.stringify(outcome)).not.toContain(SUPPLIED);
  });

  it('is never handed back out of the vault except as a header', async () => {
    const session = build({});
    await session.connectWithToken({ token: SUPPLIED, tokenType: 'Bearer' });

    // The summary is what the panel is allowed to know.
    const summary = await vault.summary('github', NOW);
    expect(JSON.stringify(summary)).not.toContain(SUPPLIED);
  });
});

describe('reading what GitHub says about a supplied token', () => {
  const headers = (values: Record<string, string>): { get(name: string): string | null } => ({
    get: (name) => values[name.toLowerCase()] ?? null,
  });

  it('treats 401 and 403 as a refusal of the token itself', () => {
    for (const status of [401, 403]) {
      expect(() => readGitHubTokenProbe({ status, headers: headers({}) }), String(status)).toThrow(
        TokenRejected,
      );
    }
  });

  it('treats any other failure as a failure to ask, not as a refusal', () => {
    // Classified differently on purpose: a 500 is not evidence about the
    // token, and reporting it as "that token was refused" sends the user to
    // make a new one for no reason.
    let thrown: unknown;
    try {
      readGitHubTokenProbe({ status: 500, headers: headers({}) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TokenRejected);
  });

  it('reads a classic token’s scopes exactly, trimmed', () => {
    const result = readGitHubTokenProbe({
      status: 200,
      headers: headers({ 'x-oauth-scopes': 'public_repo, read:org' }),
      login: 'someone',
    });
    expect(result.scopes).toEqual(['public_repo', 'read:org']);
    expect(result.accountLabel).toBe('someone');
  });

  it('reports an absent header as unknown, not as none', () => {
    // What a fine-grained token produces. The whole three-state discipline
    // hangs off this one distinction.
    const result = readGitHubTokenProbe({ status: 200, headers: headers({}), login: 'someone' });
    expect(result.scopes).toBeNull();
  });

  it('reports an empty header as none, because that is an answer', () => {
    const result = readGitHubTokenProbe({
      status: 200,
      headers: headers({ 'x-oauth-scopes': '' }),
    });
    expect(result.scopes).toEqual([]);
  });

  it('caps the account label, which arrives from the service', () => {
    const result = readGitHubTokenProbe({
      status: 200,
      headers: headers({}),
      login: 'x'.repeat(500),
    });
    expect(result.accountLabel?.length).toBe(64);
  });

  it('omits the label rather than inventing one when the body had none', () => {
    const result = readGitHubTokenProbe({ status: 200, headers: headers({}) });
    expect(result.accountLabel).toBeUndefined();
  });
});
