/**
 * TEST-SECURITY-042 — the authentication transport and its egress channel.
 *
 * The identity channel is a new way for the extension to reach the network,
 * so the questions worth asking are the ones that apply to any such addition:
 * where can it reach, what can it carry, who can start it, and does it hold a
 * network primitive of its own.
 *
 * The pinning tests matter most. An authentication request carries a bearer
 * token, so a transport that could be pointed at another origin would be a
 * token-exfiltration route with a friendly name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EGRESS_CHANNELS, identityDestination } from '@/security/egress/destination';
import { authorizeEgress } from '@/security/egress/egress-gate';
import { ConsentStore } from '@/security/egress/consent';
import { freshTaint, unknownTaint } from '@/security/taint/taint-state';
import { IdentityTransport, IdentityTransportError } from '@/identity/identity-transport';
import { parseCallback, CALLBACK_PATH } from '@/identity/google-sign-in';

const ORIGIN = 'https://api.example.test';

/**
 * Records every transfer, by replacing the global the egress module falls
 * back to.
 *
 * `IdentityTransport` supplies no transport implementation of its own — by
 * design, so that it names no network primitive and the three holders of one
 * stay three. A test may replace the global; the module may not.
 */
/**
 * The URL of a fetch call, without stringifying a `Request`.
 *
 * `String(input)` looks harmless and yields `[object Request]` for the one
 * case that matters, so the union is narrowed rather than coerced.
 */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** A request body, which this transport always sets as a string. */
function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

function recordingFetch(
  responder: (url: string) => Response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const stub: typeof fetch = (input, init) => {
    const url = urlOf(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(responder(url));
  };
  globalThis.fetch = stub;
  return { calls };
}

describe('the identity egress channel', () => {
  it('exists and is treated as leaving the device', () => {
    expect(EGRESS_CHANNELS).toContain('identity');

    const decision = authorizeEgress(
      {
        taskId: 'identity',
        taintState: freshTaint(),
        taintSalt: 'identity',
        taintSignature: 'identity',
        destination: identityDestination(ORIGIN, `${ORIGIN}/v1/auth/start`),
        payload: '[authentication]',
        now: 0,
      },
      { consent: new ConsentStore() },
    );
    // Allowed, but as an egress that was authorised — never as "not an egress".
    expect(decision.verdict).toBe('allow');
    expect(decision.code).not.toBe('NOT_AN_EGRESS');
  });

  it('gives an off-origin URL no identity, so the gate denies it', () => {
    for (const hostile of [
      'https://api.example.test.attacker.test/v1/auth/start',
      'https://attacker.test/v1/auth/start',
      'http://api.example.test/v1/auth/start',
    ]) {
      const destination = identityDestination(ORIGIN, hostile);
      expect(destination.identity, hostile).toBeNull();

      const decision = authorizeEgress(
        {
          taskId: 'identity',
          taintState: freshTaint(),
          taintSalt: 'identity',
          taintSignature: 'identity',
          destination,
          payload: '[authentication]',
          now: 0,
        },
        { consent: new ConsentStore() },
      );
      expect(decision.verdict, hostile).toBe('deny');
      expect(decision.code).toBe('DESTINATION_UNKNOWN');
    }
  });

  it('still denies when the security context is unknown', () => {
    // The channel gets no exemption from the gate's first rule.
    const decision = authorizeEgress(
      {
        taskId: 'identity',
        taintState: unknownTaint('malformed'),
        taintSalt: 'identity',
        taintSignature: 'identity',
        destination: identityDestination(ORIGIN, `${ORIGIN}/v1/auth/start`),
        payload: '[authentication]',
        now: 0,
      },
      { consent: new ConsentStore() },
    );
    expect(decision.verdict).toBe('deny');
  });
});

describe('IdentityTransport', () => {
  const original = globalThis.fetch;
  const transport = (): IdentityTransport => new IdentityTransport({ backendOrigin: ORIGIN });

  beforeEach(() => {
    globalThis.fetch = original;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('sends to the configured origin', async () => {
    const recorder = recordingFetch();
    await transport().send({ path: '/v1/auth/start', body: { method: 'google' } });

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.url).toBe(`${ORIGIN}/v1/auth/start`);
  });

  it('refuses a path that tries to escape the origin', async () => {
    const recorder = recordingFetch();

    for (const path of [
      'https://attacker.test/steal',
      '//attacker.test/steal',
      'http://api.example.test/v1/auth/start',
    ]) {
      await expect(transport().send({ path, body: {} })).rejects.toBeInstanceOf(
        IdentityTransportError,
      );
    }
    // Nothing was sent for any of them.
    expect(recorder.calls).toHaveLength(0);
  });

  it('never follows a redirect', async () => {
    recordingFetch(() => new Response(null, { status: 302 }));
    await expect(transport().send({ path: '/v1/auth/start', body: {} })).rejects.toMatchObject({
      code: 'REFUSED',
    });
  });

  it('sets redirect: manual on every request', async () => {
    const recorder = recordingFetch();
    await transport().send({ path: '/v1/auth/start', body: {} });
    expect(recorder.calls[0]?.init.redirect).toBe('manual');
  });

  it('puts the bearer token in a header, never in the URL', async () => {
    const recorder = recordingFetch();
    await transport().send({ path: '/v1/auth/refresh', body: {}, bearer: 'the-token' });

    expect(recorder.calls[0]?.url).not.toContain('the-token');
    const headers = recorder.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer the-token');
  });

  it('puts the request body in the body, never in the query string', async () => {
    const recorder = recordingFetch();
    await transport().send({
      path: '/v1/auth/exchange',
      body: { challengeId: 'chl_1', code: 'the-exchange-code' },
    });

    expect(recorder.calls[0]?.url).not.toContain('the-exchange-code');
    expect(recorder.calls[0]?.url).not.toContain('?');
    expect(bodyOf(recorder.calls[0]?.init)).toContain('the-exchange-code');
  });
});

describe('callback parsing', () => {
  it('accepts the exact origin and path', () => {
    const parsed = parseCallback(ORIGIN, `${ORIGIN}${CALLBACK_PATH}?challenge=chl_1&code=abc`);
    expect(parsed).toEqual({ challengeId: 'chl_1', exchangeCode: 'abc' });
  });

  it('refuses a prefix match — the open-redirect shape', () => {
    for (const hostile of [
      `https://api.example.test.attacker.test${CALLBACK_PATH}?challenge=c&code=a`,
      `https://attacker.test${CALLBACK_PATH}?challenge=c&code=a`,
      `${ORIGIN}${CALLBACK_PATH}x?challenge=c&code=a`,
      `${ORIGIN}/v1/auth/google/callback/../../evil?challenge=c&code=a`,
      `http://api.example.test${CALLBACK_PATH}?challenge=c&code=a`,
    ]) {
      expect(parseCallback(ORIGIN, hostile), hostile).toBeNull();
    }
  });

  it('refuses a callback missing either half', () => {
    expect(parseCallback(ORIGIN, `${ORIGIN}${CALLBACK_PATH}?code=a`)).toBeNull();
    expect(parseCallback(ORIGIN, `${ORIGIN}${CALLBACK_PATH}?challenge=c`)).toBeNull();
    expect(parseCallback(ORIGIN, `${ORIGIN}${CALLBACK_PATH}`)).toBeNull();
  });

  it('refuses anything that is not a URL', () => {
    for (const junk of ['', 'not a url', 'javascript:alert(1)']) {
      expect(parseCallback(ORIGIN, junk), junk).toBeNull();
    }
  });
});
