/**
 * TEST-SECURITY-064 — account linking, attacked over HTTP.
 *
 * Linking is the one authenticated operation that takes a second identity and
 * joins it to an account, so it is where two mistakes would be catastrophic
 * and quiet: attaching to the wrong account, and accepting a claim instead of
 * a proof. Every case here drives the real router over the real services,
 * because a transport is exactly where a correct service gets undone.
 *
 * The two properties the whole suite exists for:
 *
 *  - **There is no identity field on the attach route.** No email, no
 *    subject, no kind. A caller may present proof material for a flow the
 *    server started and the server verifies; it may not describe who it is.
 *  - **The account is the session's.** Every route takes a `Principal`, which
 *    only a verified session produces, and a link challenge records its
 *    target at `start` in a `writeOnce` column.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccessTokenIssuer,
  createAuthRouter,
  createIdentityBackend,
  createLogger,
  DEFAULT_PATHS,
  FixedClock,
  RecordingLogSink,
  type AccessTokenIssuer,
  type AuthRouter,
  type GoogleTokenEndpoint,
  type IdentityBackend,
} from '@server/index';
import { GoogleFixture } from '../fixtures/google-oidc-fixture';
import { censusStore, type CensusStore } from '../fixtures/census-store';
import { RecordingEmailDelivery } from '../fixtures/recording-email-delivery';

const NOW = 1_800_000_000_000;
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const ORIGIN = 'https://api.example.test';
const REDIRECT = `${ORIGIN}${DEFAULT_PATHS.redirectPath}`;

let clock: FixedClock;
let googleFixture: GoogleFixture;
let recorder: RecordingLogSink;
let shared: { nonce: string; now: number; claims: Record<string, unknown> };
let backend: IdentityBackend;
let router: AuthRouter;
let issuer: AccessTokenIssuer;
let mail: RecordingEmailDelivery;
let store: CensusStore;
let source: string;

beforeEach(async () => {
  clock = new FixedClock(NOW);
  googleFixture = await GoogleFixture.create();
  recorder = new RecordingLogSink();
  shared = { nonce: '', now: NOW, claims: {} };
  issuer = await createAccessTokenIssuer('k'.repeat(64));
  mail = new RecordingEmailDelivery();
  store = censusStore();
  source = 'ip-1';

  const tokens: GoogleTokenEndpoint = {
    async redeem() {
      return {
        idToken: await googleFixture.idToken(
          { audience: CLIENT_ID, nonce: shared.nonce, now: shared.now },
          shared.claims,
        ),
      };
    },
  };

  backend = createIdentityBackend({
    store: store.store,
    clock,
    log: createLogger(recorder.sink),
    email: { delivery: mail },
    google: {
      config: {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      },
      jwks: googleFixture.jwks(),
      tokens,
    },
  });
  router = createAuthRouter({
    backend,
    log: createLogger(recorder.sink),
    accessTokens: issuer,
    sourceOf: () => source,
  });
});

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return router(
    new Request(`${ORIGIN}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    }),
  );
}
const post = (path: string, body: unknown, bearer?: string): Promise<Response> =>
  request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(bearer === undefined
      ? {}
      : { headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` } }),
  });
const get = (path: string, bearer?: string): Promise<Response> =>
  request(path, {
    method: 'GET',
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
  });

interface Signed {
  readonly abaUserId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** Signs a brand-new account in by email, and returns its credentials. */
async function signInByEmail(address: string): Promise<Signed> {
  source = `src-${address}`;
  const started = (await (await post(DEFAULT_PATHS.emailStartPath, { email: address })).json()) as {
    challengeId: string;
  };
  const body = (await (
    await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: started.challengeId,
      code: mail.lastCode(),
    })
  ).json()) as Record<string, unknown>;
  return {
    abaUserId: body.abaUserId as string,
    accessToken: body.accessToken as string,
    refreshToken: body.refreshToken as string,
  };
}

/** Drives a whole Google link for a signed-in caller. Returns the attach response. */
async function linkGoogle(me: Signed, subject: string, email: string | null): Promise<Response> {
  shared.claims = email === null ? { sub: subject } : { sub: subject, email, email_verified: true };
  const started = (await (
    await post(DEFAULT_PATHS.identityLinkStartPath, { method: 'google' }, me.accessToken)
  ).json()) as { challengeId: string; authorizationUrl: string };
  shared.nonce = new URL(started.authorizationUrl).searchParams.get('nonce') ?? '';
  const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';

  const redirected = await get(`${DEFAULT_PATHS.redirectPath}?code=auth-code&state=${state}`);
  const location = new URL(redirected.headers.get('location') ?? '', ORIGIN);
  const exchangeCode = location.searchParams.get('code');
  expect(exchangeCode, 'the callback minted an exchange code').not.toBeNull();

  return post(
    DEFAULT_PATHS.identityAttachPath,
    { challengeId: started.challengeId, exchangeCode },
    me.accessToken,
  );
}

/** Drives a whole email link for a signed-in caller. Returns the attach response. */
async function linkEmail(me: Signed, address: string): Promise<Response> {
  source = `link-${address}`;
  const started = (await (
    await post(
      DEFAULT_PATHS.identityLinkStartPath,
      { method: 'email', email: address },
      me.accessToken,
    )
  ).json()) as { challengeId: string };
  return post(
    DEFAULT_PATHS.identityAttachPath,
    { challengeId: started.challengeId, code: mail.lastCode() },
    me.accessToken,
  );
}

interface IdentityView {
  readonly id: string;
  readonly kind: string;
  readonly email: string | null;
  readonly removable: boolean;
}

async function identities(me: Signed): Promise<IdentityView[]> {
  const body = (await (await get(DEFAULT_PATHS.identitiesPath, me.accessToken)).json()) as {
    identities: IdentityView[];
  };
  return body.identities;
}

/**
 * The identity carrying a given address.
 *
 * By address rather than by `removable`, and the difference is not cosmetic:
 * once an account holds two verified identities **both** are removable, so
 * picking "the first removable one" picks whichever the listing happens to
 * return first. Two cases below were written that way and detached the
 * identity that had established the caller's own session — which revoked it,
 * and made the next request 401. Correct behaviour, wrong target.
 */
function withEmail(rows: readonly IdentityView[], address: string): IdentityView {
  const found = rows.find((row) => row.email === address);
  if (found === undefined) throw new Error(`no identity for ${address}`);
  return found;
}

/* ------------------------------ listing ------------------------------- */

describe('TEST-SECURITY-064 — listing', () => {
  it('01 — an authenticated caller sees its own identities', async () => {
    const me = await signInByEmail('me@example.test');
    const rows = await identities(me);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('email');
    // The only verified identity, so it cannot be removed — and the route
    // says so rather than leaving the panel to re-derive the rule.
    expect(rows[0]?.removable).toBe(false);
  });

  it('02 — an unauthenticated caller is refused', async () => {
    const response = await get(DEFAULT_PATHS.identitiesPath);
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain('example.test');
  });

  it('03 — one account cannot list another account’s identities', async () => {
    const me = await signInByEmail('me@example.test');
    const other = await signInByEmail('other@example.test');

    const mine = await identities(me);
    const theirs = await identities(other);

    // There is no parameter in which an account could be named, so this is
    // the observable consequence rather than the enforcement: each caller
    // sees exactly one row, its own.
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.id).not.toBe(theirs[0]?.id);

    // And a forged token for the other account does not help: the signature
    // is checked and the session is re-read.
    const forged = await createAccessTokenIssuer('x'.repeat(64));
    const stolen = await forged.sign({
      sub: other.abaUserId,
      sid: 'ses_00000000000000000000000000000000',
      iat: NOW,
      exp: NOW + 60_000,
    });
    expect((await get(DEFAULT_PATHS.identitiesPath, stolen)).status).toBe(401);
  });

  it('04 — the listing carries no Google subject and no token', async () => {
    const me = await signInByEmail('me@example.test');
    await linkGoogle(me, 'google-sub-secret', 'me@example.test');

    const body = await (await get(DEFAULT_PATHS.identitiesPath, me.accessToken)).text();
    expect(body).not.toContain('google-sub-secret');
    for (const term of ['token', 'refresh', 'bearer', 'secret', 'digest']) {
      expect(body.toLowerCase(), term).not.toContain(term);
    }
  });
});

/* ------------------------------ attaching ----------------------------- */

describe('TEST-SECURITY-064 — attaching', () => {
  it('05 — a fresh Google proof attaches, and the account does not change', async () => {
    const me = await signInByEmail('me@example.test');
    const before = store.census();

    const response = await linkGoogle(me, 'google-sub-A', 'me@example.test');
    expect(response.status).toBe(200);

    const rows = await identities(me);
    expect(rows.map((row) => row.kind).sort()).toEqual(['email', 'google']);
    // One account throughout. Linking joined an identity; it did not create,
    // move or switch anything.
    expect(store.census().accounts).toBe(before.accounts);
    expect(store.census().identities).toBe(before.identities + 1);
  });

  it('06 — a stale Google proof is refused', async () => {
    const me = await signInByEmail('me@example.test');
    shared.claims = { sub: 'google-sub-A', email: 'me@example.test', email_verified: true };
    const started = (await (
      await post(DEFAULT_PATHS.identityLinkStartPath, { method: 'google' }, me.accessToken)
    ).json()) as { challengeId: string; authorizationUrl: string };
    const url = new URL(started.authorizationUrl);
    shared.nonce = url.searchParams.get('nonce') ?? '';
    const redirected = await get(
      `${DEFAULT_PATHS.redirectPath}?code=auth-code&state=${url.searchParams.get('state')}`,
    );
    const exchangeCode = new URL(redirected.headers.get('location') ?? '', ORIGIN).searchParams.get(
      'code',
    );

    // Past the challenge's life. Freshness is the existing expiry, not a new
    // mechanism.
    clock.advance(11 * 60 * 1000);
    const response = await post(
      DEFAULT_PATHS.identityAttachPath,
      { challengeId: started.challengeId, exchangeCode },
      me.accessToken,
    );

    expect(response.status).toBe(401);
    expect(await identities(me)).toHaveLength(1);
  });

  it('07 — an email address alone is not proof, because there is nowhere to put one', async () => {
    const me = await signInByEmail('me@example.test');

    // Every shape a caller might try to describe an identity with.
    for (const body of [
      { challengeId: 'otp_1', email: 'victim@example.test' },
      { challengeId: 'otp_1', email: 'victim@example.test', emailVerified: true },
      { challengeId: 'otp_1', kind: 'email', subject: null, email: 'victim@example.test' },
      { challengeId: 'otp_1', abaUserId: me.abaUserId, email: 'victim@example.test' },
    ]) {
      const response = await post(DEFAULT_PATHS.identityAttachPath, body, me.accessToken);
      // 400: neither `code` nor `exchangeCode` was supplied, so there is no
      // proof at all — the identity fields are simply not read.
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await identities(me)).toHaveLength(1);

    // And the route source holds no reader for any of them.
    const routerSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/http/router.ts', import.meta.url), 'utf8'),
    );
    const block = routerSource.slice(
      routerSource.indexOf('if (path === paths.identityAttachPath) {'),
      routerSource.indexOf('if (path === paths.identityDetachPath) {'),
    );
    for (const field of ["'email'", "'subject'", "'kind'", "'abaUserId'", "'emailVerified'"]) {
      expect(block, field).not.toContain(`requiredString(body, ${field}`);
      expect(block, field).not.toContain(`optionalString(body, ${field}`);
    }
  });

  it('08 — a verified email OTP proof attaches', async () => {
    const me = await signInByEmail('me@example.test');
    const response = await linkEmail(me, 'second@example.test');

    expect(response.status).toBe(200);
    const rows = await identities(me);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'email')).toBe(true);
  });

  it('09 — a Google assertion with an unverified address attaches no address', async () => {
    const me = await signInByEmail('me@example.test');
    shared.claims = { sub: 'google-sub-A', email: 'claimed@example.test', email_verified: false };
    const started = (await (
      await post(DEFAULT_PATHS.identityLinkStartPath, { method: 'google' }, me.accessToken)
    ).json()) as { challengeId: string; authorizationUrl: string };
    const url = new URL(started.authorizationUrl);
    shared.nonce = url.searchParams.get('nonce') ?? '';
    const redirected = await get(
      `${DEFAULT_PATHS.redirectPath}?code=auth-code&state=${url.searchParams.get('state')}`,
    );
    const exchangeCode = new URL(redirected.headers.get('location') ?? '', ORIGIN).searchParams.get(
      'code',
    );
    await post(
      DEFAULT_PATHS.identityAttachPath,
      { challengeId: started.challengeId, exchangeCode },
      me.accessToken,
    );

    const rows = await backend.store.listIdentities(me.abaUserId);
    const google = rows.find((row) => row.kind === 'google');
    // The subject is the authority and is attached; the unverified claim is
    // not written, so it can never occupy the uniqueness key (AUTH-18).
    expect(google?.subject).toBe('google-sub-A');
    expect(google?.email).toBeNull();
  });

  it('10 — an identity held by another account is refused without naming it', async () => {
    const owner = await signInByEmail('owner@example.test');
    await linkGoogle(owner, 'contested-sub', 'owner@example.test');

    const me = await signInByEmail('me@example.test');
    const response = await linkGoogle(me, 'contested-sub', 'owner@example.test');
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(body).reason).toBe('IDENTITY_IN_USE');
    // Nothing about who holds it, and nothing about that account existing.
    expect(body).not.toContain(owner.abaUserId);
    expect(body).not.toContain('owner@example.test');
    expect(await identities(me)).toHaveLength(1);
  });

  it('11 — re-attaching an identity this account already holds is a no-op success', async () => {
    const me = await signInByEmail('me@example.test');
    expect((await linkGoogle(me, 'google-sub-A', 'me@example.test')).status).toBe(200);
    const before = store.census();

    expect((await linkGoogle(me, 'google-sub-A', 'me@example.test')).status).toBe(200);
    expect(store.census()).toEqual(before);
    expect(await identities(me)).toHaveLength(2);
  });

  it('12 — a link challenge started by one account cannot be redeemed by another', async () => {
    const victim = await signInByEmail('victim@example.test');
    const attacker = await signInByEmail('attacker@example.test');

    shared.claims = { sub: 'google-sub-A', email: 'victim@example.test', email_verified: true };
    const started = (await (
      await post(DEFAULT_PATHS.identityLinkStartPath, { method: 'google' }, victim.accessToken)
    ).json()) as { challengeId: string; authorizationUrl: string };
    const url = new URL(started.authorizationUrl);
    shared.nonce = url.searchParams.get('nonce') ?? '';
    const redirected = await get(
      `${DEFAULT_PATHS.redirectPath}?code=auth-code&state=${url.searchParams.get('state')}`,
    );
    const exchangeCode = new URL(redirected.headers.get('location') ?? '', ORIGIN).searchParams.get(
      'code',
    );

    // The attacker holds the challenge id and the code, and is authenticated
    // as itself. The challenge's recorded account is the victim's.
    const response = await post(
      DEFAULT_PATHS.identityAttachPath,
      { challengeId: started.challengeId, exchangeCode },
      attacker.accessToken,
    );

    expect(response.status).toBe(401);
    expect(await identities(attacker)).toHaveLength(1);
    expect(await identities(victim)).toHaveLength(1);
  });

  it('13a — a sign-in proof cannot be spent as a link', async () => {
    const me = await signInByEmail('me@example.test');

    source = 'cross-1';
    const signIn = (await (
      await post(DEFAULT_PATHS.emailStartPath, { email: 'cross@example.test' })
    ).json()) as { challengeId: string };
    const asLink = await post(
      DEFAULT_PATHS.identityAttachPath,
      { challengeId: signIn.challengeId, code: mail.lastCode() },
      me.accessToken,
    );

    expect(asLink.status).toBe(401);
    expect(await identities(me)).toHaveLength(1);

    // **Two checks refuse this, and the test says which one is load-bearing.**
    // A sign-in challenge carries no target account, so the account binding
    // refuses it before the purpose check is reached — removing the purpose
    // check alone leaves this case passing, which a negative control proved.
    // The purpose check is kept as defence in depth and is exercised in the
    // other direction by 13b, where it *is* what refuses.
    const serviceSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/app/email-auth-service.ts', import.meta.url), 'utf8'),
    );
    expect(serviceSource).toContain("attempt.challenge.purpose !== 'link'");
    expect(serviceSource).toContain('attempt.challenge.abaUserId !== principal.abaUserId');
  });

  it('13b — a link proof cannot sign anybody in', async () => {
    const me = await signInByEmail('me@example.test');

    // A challenge the caller obtained in order to *attach* an address to the
    // account they are already using. Spending it at the sign-in route would
    // create — or sign into — a different account entirely.
    const link = (await (
      await post(
        DEFAULT_PATHS.identityLinkStartPath,
        { method: 'email', email: 'cross2@example.test' },
        me.accessToken,
      )
    ).json()) as { challengeId: string };

    const before = store.census();
    const asSignIn = await post(DEFAULT_PATHS.emailVerifyPath, {
      challengeId: link.challengeId,
      code: mail.lastCode(),
    });

    expect(asSignIn.status).toBe(401);
    // Nothing came into existence: no account, no identity.
    expect(store.census()).toEqual(before);
    expect(await identities(me)).toHaveLength(1);
  });

  it('14 — a client-supplied account id authorises nothing', async () => {
    const victim = await signInByEmail('victim@example.test');
    const me = await signInByEmail('me@example.test');

    // Every route, each handed the victim's account id in the body.
    const started = (await (
      await post(
        DEFAULT_PATHS.identityLinkStartPath,
        { method: 'email', email: 'extra@example.test', abaUserId: victim.abaUserId },
        me.accessToken,
      )
    ).json()) as { challengeId: string };
    await post(
      DEFAULT_PATHS.identityAttachPath,
      { challengeId: started.challengeId, code: mail.lastCode(), abaUserId: victim.abaUserId },
      me.accessToken,
    );

    // The identity landed on the caller's own account, not the one it named.
    expect(await identities(me)).toHaveLength(2);
    expect(await identities(victim)).toHaveLength(1);
  });

  it('15 — the attach route refuses both proofs at once, and neither', async () => {
    const me = await signInByEmail('me@example.test');
    for (const body of [
      { challengeId: 'x' },
      { challengeId: 'x', code: '123456', exchangeCode: 'abc' },
    ]) {
      expect((await post(DEFAULT_PATHS.identityAttachPath, body, me.accessToken)).status).toBe(400);
    }
  });

  it('16 — an unauthenticated caller can neither start nor attach', async () => {
    for (const [path, body] of [
      [DEFAULT_PATHS.identityLinkStartPath, { method: 'email', email: 'x@example.test' }],
      [DEFAULT_PATHS.identityAttachPath, { challengeId: 'x', code: '123456' }],
      [DEFAULT_PATHS.identityDetachPath, { identityId: 'aid_1' }],
    ] as const) {
      expect((await post(path, body)).status, path).toBe(401);
    }
    expect(mail.sent).toHaveLength(0);
  });
});

/* ------------------------------ detaching ----------------------------- */

describe('TEST-SECURITY-064 — detaching', () => {
  it('17 — the last verified identity cannot be removed', async () => {
    const me = await signInByEmail('me@example.test');
    const rows = await identities(me);

    const response = await post(
      DEFAULT_PATHS.identityDetachPath,
      { identityId: rows[0]?.id },
      me.accessToken,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { reason: string }).reason).toBe('LAST_IDENTITY');
    expect(await identities(me)).toHaveLength(1);
  });

  it('18 — a second identity can be removed, and the sessions it established are revoked', async () => {
    const me = await signInByEmail('me@example.test');
    await linkEmail(me, 'second@example.test');

    // Sign in *through* the second identity, so there is a session to revoke.
    source = 'second-signin';
    const second = await signInByEmail('second@example.test');
    expect(second.abaUserId).toBe(me.abaUserId);

    const rows = await identities(me);
    const target = withEmail(rows, 'second@example.test');
    expect(target.removable).toBe(true);
    const response = await post(
      DEFAULT_PATHS.identityDetachPath,
      { identityId: target.id },
      me.accessToken,
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { revokedSessions: number }).revokedSessions).toBe(1);

    // The session established through the removed identity is dead; the one
    // established through the remaining identity is not.
    expect(
      (await post(DEFAULT_PATHS.refreshPath, { refreshToken: second.refreshToken })).status,
    ).toBe(401);
    expect((await post(DEFAULT_PATHS.refreshPath, { refreshToken: me.refreshToken })).status).toBe(
      200,
    );
  });

  it('19 — one account cannot detach another account’s identity', async () => {
    const victim = await signInByEmail('victim@example.test');
    await linkEmail(victim, 'victim2@example.test');
    const attacker = await signInByEmail('attacker@example.test');

    const rows = await identities(victim);
    const response = await post(
      DEFAULT_PATHS.identityDetachPath,
      { identityId: rows[0]?.id },
      attacker.accessToken,
    );

    // `NOT_FOUND`, identically to an identity that does not exist, so detach
    // is not an existence oracle (AUTH-8).
    expect(response.status).toBe(404);
    expect(((await response.json()) as { reason: string }).reason).toBe('NOT_FOUND');
    expect(await identities(victim)).toHaveLength(2);
  });

  it('20 — detaching an identity that does not exist answers identically', async () => {
    const attacker = await signInByEmail('attacker@example.test');
    const victim = await signInByEmail('victim@example.test');
    await linkEmail(victim, 'victim2@example.test');
    const real = (await identities(victim))[0]?.id;

    const missing = await post(
      DEFAULT_PATHS.identityDetachPath,
      { identityId: 'aid_00000000000000000000000000000000' },
      attacker.accessToken,
    );
    const somebodyElses = await post(
      DEFAULT_PATHS.identityDetachPath,
      { identityId: real },
      attacker.accessToken,
    );

    expect(missing.status).toBe(somebodyElses.status);
    expect(await missing.json()).toEqual(await somebodyElses.json());
  });
});

/* -------------------- what linking must never touch ------------------- */

describe('TEST-SECURITY-064 — linking moves nothing', () => {
  it('21 — linking creates no account and moves no identity between accounts', async () => {
    const me = await signInByEmail('me@example.test');
    const other = await signInByEmail('other@example.test');
    const before = store.census();

    await linkGoogle(me, 'google-sub-A', 'me@example.test');
    await linkEmail(other, 'other2@example.test');

    const after = store.census();
    expect(after.accounts).toBe(before.accounts);
    expect(after.identities).toBe(before.identities + 2);

    // Each identity sits on the account that linked it, and `aba_user_id` is
    // `writeOnce`, so none of them could have moved.
    for (const row of await backend.store.listIdentities(me.abaUserId)) {
      expect(row.aba_user_id).toBe(me.abaUserId);
    }
    for (const row of await backend.store.listIdentities(other.abaUserId)) {
      expect(row.aba_user_id).toBe(other.abaUserId);
    }
  });

  it('22 — the caller’s session still names the same account after linking', async () => {
    const me = await signInByEmail('me@example.test');
    await linkGoogle(me, 'google-sub-A', 'me@example.test');

    // The session that was current before the link is still current, and
    // still names the same account. Linking is not a sign-in.
    const rotated = await post(DEFAULT_PATHS.refreshPath, { refreshToken: me.refreshToken });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { abaUserId: string }).abaUserId).toBe(me.abaUserId);
  });

  it('23 — no device is created or retired by linking', async () => {
    const me = await signInByEmail('me@example.test');
    await linkGoogle(me, 'google-sub-A', 'me@example.test');
    await linkEmail(me, 'second@example.test');

    // Linking is an identity operation. It says nothing about installations.
    expect(await backend.store.listDevices(me.abaUserId)).toHaveLength(0);
    expect(store.census().devices).toBe(0);
  });

  it('24 — concurrent attaches of one identity produce exactly one', async () => {
    const me = await signInByEmail('me@example.test');
    source = 'concurrent';
    const started = (await (
      await post(
        DEFAULT_PATHS.identityLinkStartPath,
        { method: 'email', email: 'concurrent@example.test' },
        me.accessToken,
      )
    ).json()) as { challengeId: string };
    const code = mail.lastCode();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        post(
          DEFAULT_PATHS.identityAttachPath,
          { challengeId: started.challengeId, code },
          me.accessToken,
        ),
      ),
    );

    // The challenge is consumed in the store's synchronous critical section,
    // so exactly one presentation can reach the attach.
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(await identities(me)).toHaveLength(2);
  });

  it('25 — concurrent detach of one identity revokes once and leaves the account reachable', async () => {
    const me = await signInByEmail('me@example.test');
    await linkEmail(me, 'second@example.test');
    // The one that did *not* establish this caller's session, so the caller
    // is still authenticated afterwards and can be asked what happened.
    const target = withEmail(await identities(me), 'second@example.test').id;

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        post(DEFAULT_PATHS.identityDetachPath, { identityId: target }, me.accessToken),
      ),
    );

    expect(responses.filter((response) => response.status === 200).length).toBeGreaterThanOrEqual(
      1,
    );
    const rows = await identities(me);
    // One removed, one left, and the account is still signed in to.
    expect(rows).toHaveLength(1);
    expect((await post(DEFAULT_PATHS.refreshPath, { refreshToken: me.refreshToken })).status).toBe(
      200,
    );
  });

  it('26 — no log record from any linking route carries an address or a code', async () => {
    const me = await signInByEmail('me@example.test');
    await linkEmail(me, 'second@example.test');
    await linkGoogle(me, 'google-sub-A', 'me@example.test');

    const written = recorder.serialised();
    expect(written).not.toContain('second@example.test');
    expect(written).not.toContain('google-sub-A');
    expect(written).not.toContain(mail.lastCode());
  });

  it('27 — detaching the identity you signed in through signs you out', async () => {
    // Uncovered while fixing cases 18 and 25, which had detached this
    // identity by accident. It is correct — removing a route in removes the
    // access it granted (AUTH-26) — and it is a real thing a person can do to
    // themselves from the panel, so it is asserted rather than left implicit.
    const me = await signInByEmail('me@example.test');
    await linkEmail(me, 'second@example.test');
    const mine = withEmail(await identities(me), 'me@example.test');

    const response = await post(
      DEFAULT_PATHS.identityDetachPath,
      { identityId: mine.id },
      me.accessToken,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { revokedSessions: number }).revokedSessions).toBe(1);

    // The caller's own session is gone, so its access token no longer works
    // and its refresh token is dead. The account itself is untouched and is
    // still reachable through the identity that remains.
    expect((await get(DEFAULT_PATHS.identitiesPath, me.accessToken)).status).toBe(401);
    expect((await post(DEFAULT_PATHS.refreshPath, { refreshToken: me.refreshToken })).status).toBe(
      401,
    );
    const survivor = await signInByEmail('second@example.test');
    expect(survivor.abaUserId).toBe(me.abaUserId);
    expect(await identities(survivor)).toHaveLength(1);
  });
});
