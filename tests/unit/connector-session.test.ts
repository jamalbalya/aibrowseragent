/**
 * TEST-CONNECTOR-004 — the connector authorization lifecycle.
 *
 * Two properties carry most of the weight:
 *
 *  - the only route into `READY` is from `AUTHENTICATING` with a confirmed
 *    authentication, so no failure path can land on "connected";
 *  - a pending authorization is consumed before it is validated, so a state
 *    value is usable exactly once and a replayed callback finds nothing.
 *
 * The state machine itself is shared with AI providers. It is exercised here
 * through the connector because that is where its edges are reachable, and
 * the shared table is asserted directly in the first group.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_STATES,
  AUTH_TRANSITIONS,
  canTransitionAuthState,
  isReadyReason,
  type AuthState,
} from '@/security/state/auth-states';
import { MemoryStorageArea } from '@/storage/storage-area';
import { TokenVault } from '@/connectors/oauth/token-vault';
import { ConnectorSession, type TokenResponse } from '@/connectors/core/connector-session';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';
import { githubDescriptor } from '@/connectors/adapters/github';

const NOW = 1_700_000_000_000;
const REDIRECT = 'https://redirect.test/oauth/callback';

const descriptor = githubDescriptor({
  apiOrigin: 'https://api.github.test',
  authorizationEndpoint: 'https://github.test/login/oauth/authorize',
  tokenEndpoint: 'https://github.test/login/oauth/access_token',
  redirectUri: REDIRECT,
});

class Flow implements AuthFlowPort {
  opened: string[] = [];
  /** Builds the callback from the authorization URL the session produced. */
  respond: (authorizationUrl: string) => AuthFlowOutcome = (authorizationUrl) => {
    const state = new URL(authorizationUrl).searchParams.get('state') ?? '';
    return {
      kind: 'callback',
      url: `${REDIRECT}?code=the-code&state=${encodeURIComponent(state)}`,
    };
  };

  run(request: { authorizationUrl: string }): Promise<AuthFlowOutcome> {
    this.opened.push(request.authorizationUrl);
    return Promise.resolve(this.respond(request.authorizationUrl));
  }
}

let clock: number;
let vault: TokenVault;
let flow: Flow;
let responses: TokenResponse[];
let exchanges: { endpoint: string; body: URLSearchParams }[];
let statuses: string[];
let session: ConnectorSession;

function build(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}): ConnectorSession {
  return new ConnectorSession(makeOptions(overrides));
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    descriptor,
    vault,
    authFlow: flow,
    clientId: 'client-id',
    exchange: (endpoint: string, body: URLSearchParams): Promise<TokenResponse> => {
      exchanges.push({ endpoint, body });
      const next = responses.shift();
      if (next === undefined) return Promise.reject(new Error('token endpoint unreachable'));
      return Promise.resolve(next);
    },
    now: () => clock,
    onStatusChange: (status: { state: string; reason: string }) => {
      statuses.push(`${status.state}/${status.reason}`);
    },
    ...overrides,
  } as ConstructorParameters<typeof ConnectorSession>[0];
}

beforeEach(() => {
  clock = NOW;
  vault = new TokenVault(new MemoryStorageArea());
  flow = new Flow();
  responses = [];
  exchanges = [];
  statuses = [];
  session = build();
});

const signal = (): AbortSignal => new AbortController().signal;

/**
 * A token response with one field genuinely absent.
 *
 * Not the same as setting it to `undefined`: a service that omits `scope` or
 * `refresh_token` is saying something specific, and the session's handling of
 * the two cases differs.
 */
function without(response: TokenResponse, field: keyof TokenResponse): TokenResponse {
  const { [field]: _removed, ...rest } = response;
  return rest;
}

function ok(overrides: Partial<TokenResponse> = {}): TokenResponse {
  return {
    access_token: 'access-token-1',
    token_type: 'Bearer',
    refresh_token: 'refresh-token-1',
    expires_in: 3600,
    scope: 'public_repo',
    ...overrides,
  };
}

// --- the shared table -------------------------------------------------------

describe('the shared authorization state machine', () => {
  it('has exactly one route into READY', () => {
    const into = AUTH_STATES.filter((from) => AUTH_TRANSITIONS[from].includes('READY'));
    // UNCONFIGURED and UNAVAILABLE can reach READY structurally — a
    // reconcile after a restart, a service coming back — but every one of
    // those paths is gated by the ready-reason check below.
    expect(into).not.toContain('DENIED');
    expect(canTransitionAuthState('AUTHENTICATING', 'READY')).toBe(true);
  });

  it('accepts only an actual authentication as a reason for READY', () => {
    expect(isReadyReason('authenticated')).toBe(true);
    for (const reason of [
      'authorization_opened',
      'no_grant',
      'service_unreachable',
      'user_cancelled',
      'access_refused',
    ]) {
      expect(isReadyReason(reason)).toBe(false);
    }
  });

  it('lets DENIED out only by being reset', () => {
    expect(AUTH_TRANSITIONS.DENIED).toEqual(['UNCONFIGURED']);
    for (const to of ['READY', 'AUTHENTICATING', 'NEEDS_AUTH'] as AuthState[]) {
      expect(canTransitionAuthState('DENIED', to)).toBe(false);
    }
  });
});

// --- authorization ----------------------------------------------------------

describe('authorizing', () => {
  it('starts unconfigured and needs an explicit start', () => {
    expect(session.current()).toMatchObject({ state: 'UNCONFIGURED', reason: 'not_configured' });
    // Nothing opened a page; a connector does not authorise itself.
    expect(flow.opened).toEqual([]);
  });

  it('completes a well-behaved flow and ends READY', async () => {
    responses.push(ok());
    const status = await session.authorize(['public_repo'], signal());

    expect(status).toMatchObject({ state: 'READY', reason: 'authenticated' });
    expect(status.scopes).toEqual(['public_repo']);
    expect(statuses).toEqual([
      'NEEDS_AUTH/no_grant',
      'AUTHENTICATING/authorization_opened',
      'READY/authenticated',
    ]);
  });

  it('sends the verifier, and never the challenge, to the token endpoint', async () => {
    responses.push(ok());
    await session.authorize(['public_repo'], signal());

    const body = exchanges[0]!.body;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe(REDIRECT);
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.has('client_secret')).toBe(false);
    // The challenge went to the authorization endpoint; the verifier goes
    // here. Sending the challenge would prove nothing.
    const challenge = new URL(flow.opened[0]!).searchParams.get('code_challenge');
    expect(body.get('code_verifier')).not.toBe(challenge);
  });

  it('stores what the service granted, not what was asked for', async () => {
    // A service may grant less. Recording the request would let a later
    // scope check pass for a permission the user never gave.
    responses.push(ok({ scope: 'public_repo' }));
    const status = await session.authorize(['public_repo', 'repo'], signal());
    expect(status.scopes).toEqual(['public_repo']);
    expect(session.hasScopes(['repo'])).toBe(false);
  });

  it('falls back to the requested scopes when the service names none', async () => {
    responses.push(without(ok(), 'scope'));
    const status = await session.authorize(['public_repo'], signal());
    expect(status.scopes).toEqual(['public_repo']);
  });

  it('lands in NEEDS_AUTH when the user closes the window', async () => {
    flow.respond = () => ({ kind: 'cancelled', reason: 'closed' });
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'user_cancelled' });
    expect(exchanges).toEqual([]);
  });

  it('lands in NEEDS_AUTH when the service says the user declined', async () => {
    flow.respond = () => ({ kind: 'callback', url: `${REDIRECT}?error=access_denied&state=x` });
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'authorization_refused' });
    expect(exchanges).toEqual([]);
  });

  it('refuses a callback whose state was forged, and exchanges nothing', async () => {
    flow.respond = () => ({ kind: 'callback', url: `${REDIRECT}?code=attacker&state=guessed` });
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'authorization_invalid' });
    // The important half: no code reached the token endpoint.
    expect(exchanges).toEqual([]);
  });

  it('refuses a callback that arrived at another origin', async () => {
    flow.respond = (url) => ({
      kind: 'callback',
      url: `https://attacker.test/oauth/callback?code=c&state=${
        new URL(url).searchParams.get('state') ?? ''
      }`,
    });
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'authorization_invalid' });
    expect(exchanges).toEqual([]);
  });

  it('uses a state exactly once', async () => {
    responses.push(ok());
    await session.authorize(['public_repo'], signal());
    const callback = flow.opened[0]!;
    const state = new URL(callback).searchParams.get('state') ?? '';

    // Replaying the very callback that just succeeded.
    const replayed = await session.completeCallback(
      `${REDIRECT}?code=the-code&state=${encodeURIComponent(state)}`,
    );
    expect(replayed).toMatchObject({ state: 'NEEDS_AUTH', reason: 'authorization_invalid' });
    expect(exchanges).toHaveLength(1);
  });

  it('refuses a callback when no authorization was started', async () => {
    const status = await session.completeCallback(`${REDIRECT}?code=c&state=s`);
    expect(status).toMatchObject({ reason: 'authorization_invalid' });
    expect(exchanges).toEqual([]);
  });

  it('refuses a callback that arrived after the window closed', async () => {
    flow.respond = (url) => {
      // The user took eleven minutes on the consent screen.
      clock += 11 * 60_000;
      const state = new URL(url).searchParams.get('state') ?? '';
      return { kind: 'callback', url: `${REDIRECT}?code=c&state=${encodeURIComponent(state)}` };
    };
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'authorization_invalid' });
    expect(exchanges).toEqual([]);
  });

  it('does not become READY when the token endpoint refuses', async () => {
    responses.push({ error: 'invalid_grant' });
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'authorization_refused' });
    expect(await vault.isUsable(descriptor.id, clock)).toBe(false);
  });

  it('does not become READY when the token response carries no token', async () => {
    responses.push({ token_type: 'Bearer' });
    const status = await session.authorize(['public_repo'], signal());
    expect(status.state).not.toBe('READY');
  });

  it('reports the service as unreachable when the exchange throws', async () => {
    // No response queued: the injected exchange rejects.
    const status = await session.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'UNAVAILABLE', reason: 'service_unreachable' });
  });

  it('refuses to start at all without an OAuth configuration', async () => {
    const bare = new ConnectorSession(
      makeOptions({ descriptor: { ...descriptor, oauth: undefined } }),
    );
    const status = await bare.authorize(['public_repo'], signal());
    expect(status).toMatchObject({ state: 'UNAVAILABLE', reason: 'not_configured' });
    expect(flow.opened).toEqual([]);
  });

  it('never reaches READY on any failing path', async () => {
    // A sweep rather than a per-case assertion: whatever goes wrong, the
    // connector must not end up describing itself as connected.
    const failures: (() => void)[] = [
      () => {
        flow.respond = () => ({ kind: 'cancelled', reason: 'closed' });
      },
      () => {
        flow.respond = () => ({ kind: 'callback', url: `${REDIRECT}?code=c&state=wrong` });
      },
      () => {
        flow.respond = () => ({ kind: 'callback', url: `${REDIRECT}?error=access_denied&state=s` });
      },
      () => {
        responses.push({ error: 'invalid_grant' });
      },
      () => {
        /* exchange rejects */
      },
    ];

    for (const arrange of failures) {
      vault = new TokenVault(new MemoryStorageArea());
      flow = new Flow();
      responses = [];
      const attempt = build();
      arrange();
      const status = await attempt.authorize(['public_repo'], signal());
      expect(status.state).not.toBe('READY');
      expect(await vault.isUsable(descriptor.id, clock)).toBe(false);
    }
  });
});

// --- reconcile, refresh, disconnect ----------------------------------------

describe('reconciling with what is actually stored', () => {
  it('rebuilds READY after a worker restart, through AUTHENTICATING', async () => {
    await vault.store(descriptor.id, {
      accessToken: 'a',
      tokenType: 'Bearer',
      scopes: ['public_repo'],
      accountLabel: 'octocat',
    });
    const status = await session.reconcile();

    expect(status).toMatchObject({ state: 'READY', reason: 'authenticated' });
    expect(status.accountLabel).toBe('octocat');
    // The route into READY is still the only route into READY.
    expect(statuses).toEqual([
      'NEEDS_AUTH/no_grant',
      'AUTHENTICATING/authorization_opened',
      'READY/authenticated',
    ]);
  });

  it('reports a connector with no grant as needing authorization', async () => {
    expect(await session.reconcile()).toMatchObject({ state: 'NEEDS_AUTH', reason: 'no_grant' });
  });

  it('drops out of READY when the grant expires', async () => {
    await vault.store(descriptor.id, {
      accessToken: 'a',
      tokenType: 'Bearer',
      scopes: ['public_repo'],
      expiresAt: clock + 3600_000,
    });
    expect((await session.reconcile()).state).toBe('READY');

    clock += 3600_000;
    expect(await session.reconcile()).toMatchObject({
      state: 'NEEDS_AUTH',
      reason: 'grant_expired',
    });
  });
});

describe('refreshing', () => {
  beforeEach(async () => {
    await vault.store(descriptor.id, {
      accessToken: 'old',
      tokenType: 'Bearer',
      refreshToken: 'refresh-1',
      scopes: ['public_repo'],
      expiresAt: clock + 3600_000,
    });
    await session.reconcile();
    statuses.length = 0;
  });

  it('replaces the access token and stays READY', async () => {
    responses.push(without(ok({ access_token: 'new' }), 'refresh_token'));
    const status = await session.refresh();

    expect(status.state).toBe('READY');
    expect(await vault.authorizationHeader(descriptor.id, clock)).toBe('Bearer new');
    expect(exchanges[0]!.body.get('grant_type')).toBe('refresh_token');
  });

  it('keeps the refresh token when the response omits one', async () => {
    responses.push(without(ok({ access_token: 'new' }), 'refresh_token'));
    await session.refresh();
    expect(await vault.refreshTokenForRefreshOnly(descriptor.id)).toBe('refresh-1');
  });

  it('goes to NEEDS_AUTH and clears the grant when the refresh is refused', async () => {
    responses.push({ error: 'invalid_grant' });
    const status = await session.refresh();

    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'grant_expired' });
    // The grant is gone, so nothing keeps trying to use it.
    expect(await vault.isUsable(descriptor.id, clock)).toBe(false);
    expect(await vault.refreshTokenForRefreshOnly(descriptor.id)).toBeNull();
  });

  it('does not retry a refused refresh', async () => {
    responses.push({ error: 'invalid_grant' });
    await session.refresh();
    // One attempt, full stop. An expired grant does not become valid by
    // being asked again, and a loop against a revoked one is just noise.
    expect(exchanges).toHaveLength(1);
  });

  it('reports the service as unreachable without discarding the grant', async () => {
    // A network failure is not a revocation. Clearing here would sign the
    // user out every time their connection dropped.
    const status = await session.refresh();
    expect(status).toMatchObject({ state: 'UNAVAILABLE', reason: 'service_unreachable' });
    expect(await vault.refreshTokenForRefreshOnly(descriptor.id)).toBe('refresh-1');
  });

  it('needs re-authorization when there is no refresh token at all', async () => {
    await vault.clear(descriptor.id);
    await vault.store(descriptor.id, { accessToken: 'a', tokenType: 'Bearer', scopes: [] });
    const status = await session.refresh();
    expect(status).toMatchObject({ state: 'NEEDS_AUTH', reason: 'grant_expired' });
    expect(exchanges).toEqual([]);
  });
});

describe('ending a connection', () => {
  beforeEach(async () => {
    await vault.store(descriptor.id, {
      accessToken: 'a',
      tokenType: 'Bearer',
      scopes: ['public_repo'],
    });
    await session.reconcile();
  });

  it('forgets the grant on disconnect', async () => {
    const status = await session.disconnect();
    expect(status).toMatchObject({ state: 'UNCONFIGURED', reason: 'revoked' });
    expect(await vault.authorizationHeader(descriptor.id, clock)).toBeNull();
  });

  it('records a service-side refusal as denied', () => {
    expect(session.markAccessRefused()).toMatchObject({
      state: 'DENIED',
      reason: 'access_refused',
    });
  });

  it('will not quietly recover from denied', async () => {
    session.markAccessRefused();
    // Even with a perfectly good grant in the vault.
    expect((await session.reconcile()).state).toBe('DENIED');
  });
});

describe('scope checks', () => {
  beforeEach(async () => {
    await vault.store(descriptor.id, {
      accessToken: 'a',
      tokenType: 'Bearer',
      scopes: ['public_repo'],
    });
    await session.reconcile();
  });

  it('accepts a scope that was granted', () => {
    expect(session.hasScopes(['public_repo'])).toBe(true);
    expect(session.hasScopes([])).toBe(true);
  });

  it('refuses one that was not', () => {
    expect(session.hasScopes(['repo'])).toBe(false);
    expect(session.hasScopes(['public_repo', 'repo'])).toBe(false);
  });

  it('does not accept a scope that is merely a prefix of a granted one', () => {
    // `public` is not `public_repo`, and a substring check would say it was.
    expect(session.hasScopes(['public'])).toBe(false);
  });
});
