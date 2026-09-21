/**
 * TEST-SECURITY-016 — provider kind, state machine and human authentication
 * (Stage 3 D1–D3).
 *
 * The property under test throughout is that a provider cannot become usable
 * without a confirmed authentication signal, and that every ambiguous
 * observation leaves it unusable rather than resolving in its favour.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_KINDS,
  PROVIDER_STATES,
  canTransition,
  initialStatus,
  isUsable,
  awaitsHuman,
  transitionProvider,
  type ProviderState,
} from '@/providers/core/provider-kind';
import { WebAuthSession, deadlineFor, taskStateFor } from '@/providers/web/auth-session';
import {
  WebProviderRegistry,
  assessAuthentication,
  canonicalOrigin,
  corroborateOrigin,
  validateWebProvider,
  type WebProviderDefinition,
} from '@/providers/web/web-provider';
import { openAICompatibleFactory } from '@/providers/adapters/openai-compatible';

const NOW = 1_700_000_000_000;

const provider: WebProviderDefinition = {
  id: 'example-web',
  displayName: 'Example Web',
  kind: 'web',
  origins: ['https://chat.example.com'],
  loginUrl: 'https://chat.example.com/login',
  signedInLandmarks: ['[data-testid="composer"]'],
  signedOutLandmarks: ['[data-testid="login-button"]'],
};

function session(): WebAuthSession {
  return new WebAuthSession('task_1', provider, { now: () => NOW });
}

describe('provider kind is orthogonal to auth kind', () => {
  it('offers exactly two kinds', () => {
    expect([...PROVIDER_KINDS]).toEqual(['api', 'web']);
  });

  it('declares the shipping adapter as an API provider', () => {
    expect(openAICompatibleFactory.kind).toBe('api');
    expect(openAICompatibleFactory.authKind).toBe('api_key');
  });

  it('does not encode kind inside auth kind', () => {
    // The two axes must stay independent: an api-key-authenticated web app and
    // an api-key-authenticated endpoint are the same authKind and entirely
    // different things.
    const web: WebProviderDefinition = { ...provider };
    expect(web.kind).toBe('web');
    expect(openAICompatibleFactory.authKind).toBe(web.kind === 'web' ? 'api_key' : 'api_key');
  });
});

describe('state machine', () => {
  it('has six states and no UNKNOWN', () => {
    expect([...PROVIDER_STATES]).toEqual([
      'UNCONFIGURED',
      'NEEDS_AUTH',
      'AUTHENTICATING',
      'READY',
      'UNAVAILABLE',
      'DENIED',
    ]);
    expect(PROVIDER_STATES as readonly string[]).not.toContain('UNKNOWN');
  });

  it('refuses NEEDS_AUTH -> READY, the edge that would skip authentication', () => {
    expect(canTransition('NEEDS_AUTH', 'READY')).toBe(false);
  });

  it('only reaches READY from AUTHENTICATING', () => {
    const sources = PROVIDER_STATES.filter((from) => canTransition(from, 'READY'));
    expect(sources).toEqual(['UNCONFIGURED', 'AUTHENTICATING', 'UNAVAILABLE']);
    // UNCONFIGURED -> READY exists for API providers, which have no login step.
    // A web provider never takes it: `WebAuthSession` moves to NEEDS_AUTH first.
  });

  it('will not enter READY with a reason other than authentication', () => {
    // The table also enforces the ordering: a provider reaches AUTHENTICATING
    // through NEEDS_AUTH, never straight from UNCONFIGURED.
    const at = initialStatus('p', 'web', NOW);
    const needsAuth = transitionProvider(at, 'NEEDS_AUTH', 'no_session', NOW).status;
    expect(transitionProvider(at, 'AUTHENTICATING', 'login_opened', NOW).changed).toBe(false);
    const authenticating = transitionProvider(
      needsAuth,
      'AUTHENTICATING',
      'login_opened',
      NOW,
    ).status;

    const forged = transitionProvider(authenticating, 'READY', 'ambiguous_signal', NOW);
    expect(forged.changed).toBe(false);
    expect(forged.status.state).toBe('AUTHENTICATING');

    const real = transitionProvider(authenticating, 'READY', 'authenticated', NOW);
    expect(real.changed).toBe(true);
    expect(real.status.state).toBe('READY');
  });

  it('treats DENIED as terminal apart from reconfiguration', () => {
    const allowed = PROVIDER_STATES.filter((to) => canTransition('DENIED', to));
    expect(allowed).toEqual(['UNCONFIGURED']);
  });

  it('leaves state unchanged on an impossible transition rather than throwing', () => {
    // A stale signal arriving late is normal and must not crash the task.
    const needsAuth = transitionProvider(
      initialStatus('p', 'web', NOW),
      'NEEDS_AUTH',
      'no_session',
      NOW,
    ).status;
    const ready = transitionProvider(
      transitionProvider(needsAuth, 'AUTHENTICATING', 'login_opened', NOW).status,
      'READY',
      'authenticated',
      NOW,
    ).status;
    const result = transitionProvider(ready, 'AUTHENTICATING', 'login_opened', NOW);
    expect(result.changed).toBe(false);
    expect(result.status.state).toBe('READY');
  });

  it.each(PROVIDER_STATES.filter((s) => s !== 'READY'))('%s is not usable', (state) => {
    const status = { ...initialStatus('p', 'web', NOW), state: state as ProviderState };
    expect(isUsable(status)).toBe(false);
  });
});

describe('human authentication has no deadline', () => {
  it('returns no deadline while a person is signing in', () => {
    const s = session();
    s.requireAuth();
    const { status } = s.beginAuthentication();
    expect(awaitsHuman(status)).toBe(true);
    // The whole point: a person reading a verification email is not a stalled
    // tool call, and a number here would eventually cancel their task.
    expect(deadlineFor(status, 25_000)).toBeNull();
  });

  it('keeps the ordinary deadline in every other state', () => {
    const s = session();
    expect(deadlineFor(s.current(), 25_000)).toBe(25_000);
    expect(deadlineFor(s.requireAuth(), 25_000)).toBe(25_000);
  });

  it('maps authentication onto the existing waiting state', () => {
    const s = session();
    s.requireAuth();
    expect(taskStateFor(s.beginAuthentication().status)).toBe('WAITING_FOR_USER');
  });

  it('pauses rather than failing when a session is missing', () => {
    expect(taskStateFor(session().requireAuth())).toBe('PAUSED');
  });

  it('blocks the task when access is refused', () => {
    const s = session();
    s.requireAuth();
    expect(taskStateFor(s.markDenied())).toBe('BLOCKED');
  });
});

describe('authentication detection never guesses', () => {
  const cases: {
    label: string;
    signal: Parameters<typeof assessAuthentication>[1];
    authenticated: boolean;
  }[] = [
    {
      label: 'a settled page showing the signed-in landmark',
      signal: {
        settled: true,
        tabUrl: 'https://chat.example.com/app',
        signedInLandmarkFound: true,
      },
      authenticated: true,
    },
    {
      label: 'a page that has not settled',
      signal: {
        settled: false,
        tabUrl: 'https://chat.example.com/app',
        signedInLandmarkFound: true,
      },
      authenticated: false,
    },
    {
      label: 'both landmarks present at once',
      signal: {
        settled: true,
        tabUrl: 'https://chat.example.com/app',
        signedInLandmarkFound: true,
        signedOutLandmarkFound: true,
      },
      authenticated: false,
    },
    {
      label: 'neither landmark present',
      signal: { settled: true, tabUrl: 'https://chat.example.com/app' },
      authenticated: false,
    },
    {
      label: 'the signed-out landmark',
      signal: {
        settled: true,
        tabUrl: 'https://chat.example.com/app',
        signedOutLandmarkFound: true,
      },
      authenticated: false,
    },
    {
      label: 'a different origin',
      signal: {
        settled: true,
        tabUrl: 'https://not-the-provider.example/app',
        signedInLandmarkFound: true,
      },
      authenticated: false,
    },
    {
      label: 'a closed tab',
      signal: { settled: true, tabClosed: true, signedInLandmarkFound: true },
      authenticated: false,
    },
    {
      label: 'no URL at all',
      signal: { settled: true, signedInLandmarkFound: true },
      authenticated: false,
    },
  ];

  it.each(cases)('$label -> authenticated=$authenticated', ({ signal, authenticated }) => {
    expect(assessAuthentication(provider, signal).authenticated).toBe(authenticated);
  });

  it('stays in AUTHENTICATING while the signal is still ambiguous', () => {
    const s = session();
    s.requireAuth();
    s.beginAuthentication();
    // Mid-login: the page has not settled. Dropping back to NEEDS_AUTH here
    // would restart the flow under the user while they were typing.
    const status = s.observe({ settled: false, tabUrl: 'https://chat.example.com/login' });
    expect(status.state).toBe('AUTHENTICATING');
  });

  it('returns to NEEDS_AUTH when the tab leaves the provider origin', () => {
    const s = session();
    s.requireAuth();
    s.beginAuthentication();
    const status = s.observe({
      settled: true,
      tabUrl: 'https://attacker.example/looks-like-a-login',
      signedInLandmarkFound: true,
    });
    expect(status.state).toBe('NEEDS_AUTH');
    expect(status.reason).toBe('origin_changed');
  });

  it('returns to NEEDS_AUTH when the tab is closed', () => {
    const s = session();
    s.requireAuth();
    s.beginAuthentication();
    const status = s.observe({ settled: true, tabClosed: true });
    expect(status.state).toBe('NEEDS_AUTH');
    expect(status.reason).toBe('tab_closed');
  });

  it('completes the whole flow only on a confirmed signal', () => {
    const s = session();
    expect(s.requireAuth().state).toBe('NEEDS_AUTH');
    const { loginUrl, status } = s.beginAuthentication();
    expect(loginUrl).toBe(provider.loginUrl);
    expect(status.state).toBe('AUTHENTICATING');

    const ready = s.observe({
      settled: true,
      tabUrl: 'https://chat.example.com/app',
      signedInLandmarkFound: true,
    });
    expect(ready.state).toBe('READY');
    expect(isUsable(ready)).toBe(true);
  });

  it('loses READY when the origin later changes', () => {
    const s = session();
    s.requireAuth();
    s.beginAuthentication();
    s.observe({
      settled: true,
      tabUrl: 'https://chat.example.com/app',
      signedInLandmarkFound: true,
    });
    const after = s.observe({ settled: true, tabUrl: 'https://elsewhere.example/app' });
    expect(after.state).toBe('NEEDS_AUTH');
  });
});

describe('provider identity is selected, not inferred', () => {
  it('resolves only from an explicit selection', () => {
    const registry = new WebProviderRegistry();
    registry.register(provider);
    expect(registry.resolveSelected('example-web')?.id).toBe('example-web');
    expect(registry.resolveSelected(undefined)).toBeUndefined();
    expect(registry.resolveSelected('not-registered')).toBeUndefined();
  });

  it('corroborates a matching origin', () => {
    expect(corroborateOrigin(provider, 'https://chat.example.com/app')).toBe('match');
  });

  it('reports a mismatch rather than searching for the real provider', () => {
    // A page that looks like the provider is still not the provider. There is
    // deliberately no lookup that could answer "which provider is this?".
    expect(corroborateOrigin(provider, 'https://chat-example.com.evil.test/app')).toBe('mismatch');
  });

  it('treats a port difference as a different origin', () => {
    expect(corroborateOrigin(provider, 'https://chat.example.com:8443/app')).toBe('mismatch');
  });

  it('treats an unparseable URL as unknown, not as a match', () => {
    expect(corroborateOrigin(provider, 'not a url')).toBe('unknown');
    expect(corroborateOrigin(provider, undefined)).toBe('unknown');
  });

  it('canonicalises origins case-insensitively', () => {
    expect(canonicalOrigin('HTTPS://Chat.Example.COM/app')).toBe('https://chat.example.com');
  });
});

describe('a provider definition cannot observe credentials', () => {
  it.each([
    ['a password field', 'input[type="password"]'],
    ['a named password input', '#password'],
    ['a one-time code field', 'input[name="otp"]'],
    ['an MFA field', '.mfa-code'],
    ['a TOTP field', '#totp'],
    ['a verification code field', '[data-test="verification-code"]'],
    ['a token field', '#session-token'],
    ['an autocomplete password hint', 'input[autocomplete="current-password"]'],
  ])('refuses %s as a landmark', (_label, selector) => {
    const problems = validateWebProvider({ ...provider, signedOutLandmarks: [selector] });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]!.detail).toMatch(/credential input/i);
  });

  it('refuses a non-https origin', () => {
    const problems = validateWebProvider({ ...provider, origins: ['http://chat.example.com'] });
    expect(problems.some((p) => p.detail.includes('not https'))).toBe(true);
  });

  it('refuses a login URL outside the provider origins', () => {
    // A registry entry whose login page is elsewhere is a phishing redirect
    // with the extension's endorsement on it.
    const problems = validateWebProvider({
      ...provider,
      loginUrl: 'https://accounts.evil.test/login',
    });
    expect(problems.some((p) => p.field === 'loginUrl')).toBe(true);
  });

  it('accepts a well-formed definition', () => {
    expect(validateWebProvider(provider)).toEqual([]);
  });

  it('refuses to register an invalid definition at all', () => {
    const registry = new WebProviderRegistry();
    expect(() =>
      registry.register({ ...provider, signedInLandmarks: ['input[type=password]'] }),
    ).toThrow(/not registrable/i);
    expect(registry.list()).toEqual([]);
  });

  it('ships with no web provider registered, because D5 is gated', () => {
    expect(new WebProviderRegistry().list()).toEqual([]);
  });
});
