/**
 * TEST-SERVER-030 — the two email routes, over the real handler.
 *
 * The router is a `(Request) => Promise<Response>`, so these drive it exactly
 * as a deployment would, with real `Request` objects and real status codes.
 * What that adds over the service suite is the transport's own decisions:
 * which status a refusal gets, what reaches a body, and what a route refuses
 * to read at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccessTokenIssuer,
  createAuthRouter,
  createIdentityBackend,
  createLogger,
  DEFAULT_PATHS,
  FixedClock,
  MAX_OTP_ATTEMPTS,
  OTP_LIMITS,
  OTP_TTL_MS,
  RecordingLogSink,
  type AuthRouter,
} from '../../server/index';
import { censusStore, type CensusStore } from '../fixtures/census-store';
import { RecordingEmailDelivery } from '../fixtures/recording-email-delivery';

const ORIGIN = 'https://backend.test';
const ADDRESS = 'person@example.test';

let router: AuthRouter;
let mail: RecordingEmailDelivery;
let clock: FixedClock;
let store: CensusStore;
let logs: RecordingLogSink;
let source: string;

beforeEach(async () => {
  clock = new FixedClock(1_700_000_000_000);
  store = censusStore();
  mail = new RecordingEmailDelivery();
  logs = new RecordingLogSink();
  source = '198.51.100.4';
  const backend = createIdentityBackend({
    store: store.store,
    clock,
    log: createLogger(logs.sink),
    email: { delivery: mail },
  });
  router = createAuthRouter({
    backend,
    log: createLogger(logs.sink),
    accessTokens: await createAccessTokenIssuer('integration-signing-key-'.padEnd(64, 'x')),
    // A real deployment reads this from the connection. The test drives it so
    // one case's limit is not spent by another's.
    sourceOf: () => source,
  });
});

function post(path: string, body?: unknown, method = 'POST'): Promise<Response> {
  return router(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function start(email = ADDRESS): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await post(DEFAULT_PATHS.emailStartPath, { email });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('TEST-SERVER-030', () => {
  it('01 — start answers 200 with a challenge id and no code', async () => {
    const { status, body } = await start();
    expect(status).toBe(200);
    expect(typeof body.challengeId).toBe('string');
    expect(typeof body.expiresAt).toBe('number');
    expect(typeof body.resendAvailableAt).toBe('number');
    expect(JSON.stringify(body)).not.toContain(mail.lastCode());
    // And nothing else. A field nobody needs is a field something can leak in.
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresAt', 'resendAvailableAt']);
  });

  it('02 — verify answers 200 with a session, and no code anywhere in it', async () => {
    const started = await start();
    const code = mail.lastCode();
    const response = await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: started.body.challengeId,
      code,
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    expect(body.email).toBe(ADDRESS);
    expect(JSON.stringify(body)).not.toContain(code);
  });

  it('03 — a wrong code is 401 and names the challenge state, never an account', async () => {
    const started = await start();
    const response = await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: started.body.challengeId,
      code: '000000',
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.reason).toBe('INVALID_CODE');
    expect(body.remainingAttempts).toBe(MAX_OTP_ATTEMPTS - 1);
    // Nothing about whether an account exists.
    for (const term of ['abaUserId', 'account', 'exists', 'unknown_user']) {
      expect(JSON.stringify(body).toLowerCase(), term).not.toContain(term.toLowerCase());
    }
  });

  it('04 — an unknown challenge id is answered exactly as an expired one', async () => {
    const started = await start();
    clock.advance(OTP_TTL_MS + 1);
    const expired = await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: started.body.challengeId,
      code: '000000',
    });
    const unknown = await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: 'otp_00000000000000000000000000000000',
      code: '000000',
    });

    expect(expired.status).toBe(unknown.status);
    expect(await expired.json()).toEqual(await unknown.json());
  });

  it('05 — a malformed address is 400 and sends nothing', async () => {
    const response = await post(DEFAULT_PATHS.emailStartPath, { email: 'nobody' });
    expect(response.status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });

  it('06 — rate limiting answers 429 with a Retry-After header', async () => {
    await start();
    const response = await post(DEFAULT_PATHS.emailStartPath, { email: ADDRESS });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(typeof body.retryAfterMs).toBe('number');
    // Whole seconds, rounded up, so a client that honours it never retries
    // early.
    const header = Number(response.headers.get('retry-after'));
    expect(Number.isInteger(header)).toBe(true);
    expect(header * 1000).toBeGreaterThanOrEqual(body.retryAfterMs as number);
  });

  it('07 — a delivery failure is 502 and never a 200 with nothing sent', async () => {
    mail.failing = true;
    const response = await post(DEFAULT_PATHS.emailStartPath, { email: ADDRESS });
    expect(response.status).toBe(502);
    expect(((await response.json()) as Record<string, unknown>).error).toBe('unavailable');
  });

  it('08 — both routes refuse anything but POST', async () => {
    for (const path of [DEFAULT_PATHS.emailStartPath, DEFAULT_PATHS.emailVerifyPath]) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await post(path, undefined, method);
        expect(response.status, `${method} ${path}`).toBe(405);
      }
    }
  });

  it('09 — no secret reaches a URL on either route', async () => {
    const started = await start();
    const code = mail.lastCode();
    const response = await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: started.body.challengeId,
      code,
    });
    // No redirect, so no Location, so nothing of this flow is ever in a URL.
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });

  it('10 — every response carries the no-store, no-referrer headers', async () => {
    const responses = [
      await post(DEFAULT_PATHS.emailStartPath, { email: ADDRESS }),
      await post(DEFAULT_PATHS.emailStartPath, { email: ADDRESS }),
      await post(DEFAULT_PATHS.emailVerifyPath, { challengeId: 'x', code: '000000' }),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('11 — an oversized body is refused before it is parsed', async () => {
    const response = await post(DEFAULT_PATHS.emailStartPath, {
      email: `${'x'.repeat(20_000)}@example.test`,
    });
    expect(response.status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });

  it('12 — a deployment with no mail transport has no email routes', async () => {
    const backend = createIdentityBackend({ store: censusStore().store, clock });
    const bare = createAuthRouter({
      backend,
      log: createLogger(logs.sink),
      accessTokens: await createAccessTokenIssuer('integration-signing-key-'.padEnd(64, 'x')),
      sourceOf: () => source,
    });
    for (const path of [DEFAULT_PATHS.emailStartPath, DEFAULT_PATHS.emailVerifyPath]) {
      const response = await bare(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it('13 — the rate-limit source is the deployment’s, not the caller’s to choose', async () => {
    // There is no header, field or parameter a caller can set to change which
    // bucket they are counted in: `sourceOf` reads the `Request`, and the
    // deployment decides what it reads. Spending one source's budget and then
    // moving to another is a thing only the deployment can do.
    for (let index = 0; index < OTP_LIMITS.startPerSource.limit; index += 1) {
      clock.advance(OTP_LIMITS.resendCooldown.windowMs);
      await post(DEFAULT_PATHS.emailStartPath, { email: `p${index}@example.test` });
    }
    clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    const blocked = await post(DEFAULT_PATHS.emailStartPath, { email: 'next@example.test' });
    expect(blocked.status).toBe(429);

    source = '203.0.113.77';
    const other = await post(DEFAULT_PATHS.emailStartPath, { email: 'next@example.test' });
    expect(other.status).toBe(200);
  });

  it('14 — no log record from either route contains the code or the address', async () => {
    const started = await start();
    const code = mail.lastCode();
    await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: started.body.challengeId,
      code: '000000',
    });
    await post(DEFAULT_PATHS.emailVerifyPath, { challengeId: started.body.challengeId, code });

    const written = logs.serialised();
    expect(written).not.toContain(code);
    expect(written).not.toContain(ADDRESS);
    expect(written).not.toContain(source);
  });
});
