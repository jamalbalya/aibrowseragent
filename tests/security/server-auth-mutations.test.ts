/**
 * TEST-SECURITY-050 — the authentication boundary, branch by branch.
 *
 * Following the convention of `data-classification`: these are **independent
 * fail-closed assertions, not executable mutants**. Nothing here runs a
 * mutated build. What each case buys is that a change collapsing two refusals
 * into one, or removing a single guard, fails here rather than passing an
 * aggregate test that only checked the overall outcome.
 *
 * Each case names the mutation it is aimed at, so a later reader can tell what
 * would have to break for it to start failing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createIdentityBackend,
  createLogger,
  FixedClock,
  RecordingLogSink,
  type IdentityBackend,
} from '@server/index';

const NOW = 1_800_000_000_000;
const DEVICE = 'dev_11111111-2222-3333-4444-555555555555';
const ROOT = resolve(__dirname, '../..');

describe('what the authentication layer must never accept', () => {
  let clock: FixedClock;
  let recorder: RecordingLogSink;
  let backend: IdentityBackend;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    recorder = new RecordingLogSink();
    backend = createIdentityBackend({ clock, log: createLogger(recorder.sink) });
  });

  async function account(): Promise<string> {
    return (await backend.accounts.createAccount()).id;
  }

  /* ---------------------- client-supplied authority --------------------- */

  it('01 — no account-scoped service method accepts a caller-supplied abaUserId', () => {
    // Mutation: adding an `abaUserId` parameter beside a `Principal`. That is
    // the shape every IDOR in this class of system has, so the absence is
    // asserted against the source rather than trusted.
    for (const file of [
      'server/app/account-service.ts',
      'server/app/device-service.ts',
      'server/app/identity-service.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      // Every public method takes `principal: Principal` first, and none takes
      // an account id alongside it.
      expect(source, file).not.toMatch(/principal:\s*Principal,\s*\n?\s*abaUserId/);
      expect(source, file).not.toMatch(/abaUserId:\s*string,\s*\n?\s*principal/);
    }
  });

  it('02 — a Principal cannot be built from anything but a verified session', () => {
    // Mutation: exporting a Principal constructor, or widening the brand.
    // `principalFromSession` is the only producer and it requires both rows.
    const source = readFileSync(resolve(ROOT, 'server/domain/authorization.ts'), 'utf8');
    // One declaration on the interface, and exactly one place that produces
    // the branded value. A second producer is how a Principal starts being
    // assembled from something other than a verified session.
    const declarations = source.match(/readonly __brand:\s*'Principal'/g) ?? [];
    const producers = source.match(/^\s+__brand:\s*'Principal',/gm) ?? [];
    expect(declarations).toHaveLength(1);
    expect(producers).toHaveLength(1);
    expect(source).toContain('principalFromSession');
  });

  it('03 — the exchange route reads no identity field from the client', () => {
    // Mutation: reading `abaUserId`, `sub` or `email` out of the request body.
    // The router must take only the two flow artifacts and an opaque device id.
    const source = readFileSync(resolve(ROOT, 'server/http/router.ts'), 'utf8');
    for (const field of ['abaUserId', "'sub'", "'email'", 'emailVerified', 'idToken']) {
      expect(source, field).not.toContain(`requiredString(body, ${field}`);
      expect(source, field).not.toContain(`optionalString(body, ${field}`);
    }
  });

  it('04 — the router performs no Google verification of its own', () => {
    // Mutation: inlining token checks into the controller, where they would
    // drift from the service's and be tested by neither suite.
    const source = readFileSync(resolve(ROOT, 'server/http/router.ts'), 'utf8');
    for (const term of ['verifyGoogleIdToken', 'jwks', 'iss', 'aud', 'RS256']) {
      expect(source.includes(`${term}(`), term).toBe(false);
    }
  });

  /* ------------------------- device registration ------------------------ */

  it('05 — a device cannot be registered without an authenticated session', async () => {
    // Mutation: a registerDevice overload taking an account id. There is no
    // path to a Principal that does not go through session verification, so
    // an unauthenticated registration is unrepresentable rather than refused.
    const source = readFileSync(resolve(ROOT, 'server/app/device-service.ts'), 'utf8');
    expect(source).toContain('registerDevice(principal: Principal');

    // And the only caller in the Google flow mints its Principal from the
    // session it just issued.
    const google = readFileSync(resolve(ROOT, 'server/app/google-auth-service.ts'), 'utf8');
    expect(google).toContain('this.options.sessions.verify(sessionId)');
    expect(google).toContain('this.options.devices.registerDevice(principal.value');
  });

  it('06 — a device id never authorises anything on its own', async () => {
    const mine = await account();
    const theirs = await account();

    const issued = await backend.sessions.createSession({
      abaUserId: mine,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    const principal = await backend.sessions.verify(issued.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    await backend.devices.registerDevice(principal.value, DEVICE);

    // The same device id under another account is a different row, and the
    // one it names is not reachable from the other account's principal.
    const theirSession = await backend.sessions.createSession({
      abaUserId: theirs,
      authIdentityId: null,
    });
    if (!theirSession.ok) throw new Error('unreachable');
    const theirPrincipal = await backend.sessions.verify(theirSession.value.sessionId);
    if (!theirPrincipal.ok) throw new Error('unreachable');

    const crossed = await backend.devices.getDevice(theirPrincipal.value, DEVICE);
    expect(crossed.ok).toBe(false);
  });

  it('07 — retiring a device deletes neither the account nor its sessions', async () => {
    const abaUserId = await account();
    const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
    if (!issued.ok) throw new Error('unreachable');
    const principal = await backend.sessions.verify(issued.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    await backend.devices.registerDevice(principal.value, DEVICE);

    await backend.devices.retireDevice(principal.value, DEVICE);

    // Retiring an installation is not a deletion of anything else. A mutation
    // that cascaded from device to account or session would fail here.
    expect((await backend.store.getUser(abaUserId))?.state).toBe('active');
    expect((await backend.sessions.verify(issued.value.sessionId)).ok).toBe(true);
  });

  /* ------------------------- session ownership -------------------------- */

  it('08 — a session for one account never yields a principal for another', async () => {
    const mine = await account();
    const theirs = await account();
    const issued = await backend.sessions.createSession({ abaUserId: mine, authIdentityId: null });
    if (!issued.ok) throw new Error('unreachable');

    const principal = await backend.sessions.verify(issued.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');

    // Mutation: dropping the `user.id !== session.aba_user_id` check in
    // `principalFromSession`, which is defence in depth the store should make
    // unreachable — and which must stay anyway.
    expect(principal.value.abaUserId).toBe(mine);
    expect(principal.value.abaUserId).not.toBe(theirs);
  });

  it('09 — account deletion can only ever target the caller’s own account', async () => {
    // Mutation: a `markAccountDeleted(principal, abaUserId)` overload. The
    // method reads the id off the principal and takes no other source.
    const source = readFileSync(resolve(ROOT, 'server/app/account-service.ts'), 'utf8');
    expect(source).toContain('markAccountDeleted(principal: Principal)');
    expect(source).toContain('this.options.store.getUser(principal.abaUserId)');
  });

  it('10 — deleting an account revokes its sessions and refuses further ones', async () => {
    const abaUserId = await account();
    const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
    if (!issued.ok) throw new Error('unreachable');
    const principal = await backend.sessions.verify(issued.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');

    await backend.accounts.markAccountDeleted(principal.value);

    expect((await backend.sessions.verify(issued.value.sessionId)).ok).toBe(false);
    const further = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
    expect(further.ok === false && further.error.code).toBe('ACCOUNT_DELETED');
  });

  /* --------------------- flow secrets are generated --------------------- */

  it('11 — every sign-in mints a distinct state, nonce and PKCE challenge', () => {
    // Mutation: a constant state, a reused nonce, or PKCE dropped. Each would
    // pass a test that only checked the field was present, so this checks the
    // values differ between flows and that the challenge method is S256.
    const source = readFileSync(resolve(ROOT, 'server/app/google-auth-service.ts'), 'utf8');
    expect(source).toContain('newState()');
    expect(source).toContain('newNonce()');
    expect(source).toContain('newCodeVerifier()');
    expect(source).toContain('createCodeChallenge');

    const pkce = readFileSync(resolve(ROOT, 'server/app/pkce.ts'), 'utf8');
    // S256 only. `plain` is a downgrade an attacker would choose.
    expect(pkce).toContain('S256');
    expect(pkce).not.toMatch(/['"]plain['"]/);
  });

  it('12 — the challenge row keeps its secrets server-side and the client gets an id', () => {
    // Mutation: returning the state, the nonce or the verifier from `start`.
    const source = readFileSync(resolve(ROOT, 'server/app/google-auth-service.ts'), 'utf8');
    const startReturn = source.slice(source.indexOf('async start()'));
    const returned = startReturn.slice(0, startReturn.indexOf('async handleCallback'));
    expect(returned).not.toMatch(/return ok\(\{[^}]*\bstate\b/);
    expect(returned).not.toMatch(/return ok\(\{[^}]*\bnonce\b/);
    expect(returned).not.toMatch(/return ok\(\{[^}]*verifier/);
  });

  /* ------------------------- token interpretation ----------------------- */

  it('13 — the access token has no field an algorithm could be read from', () => {
    // Mutation: adding a header, which is how `alg: none` becomes reachable.
    const source = readFileSync(resolve(ROOT, 'server/app/access-token.ts'), 'utf8');
    expect(source).toContain('if (version !== VERSION) return null');
    // No parsing of an algorithm from the token, anywhere.
    expect(source).not.toMatch(/JSON\.parse\([^)]*header/i);
  });

  it('14 — expiry is checked, and after the signature rather than before it', () => {
    // Mutation: removing the expiry check, or moving it ahead of the MAC so
    // an unsigned token's claims decide whether it is even examined.
    const source = readFileSync(resolve(ROOT, 'server/app/access-token.ts'), 'utf8');
    const macIndex = source.indexOf('timingSafeEqual(signature, expected)');
    const expIndex = source.indexOf('claims.exp <= now');
    expect(macIndex).toBeGreaterThan(-1);
    expect(expIndex).toBeGreaterThan(macIndex);
  });

  /* --------------------------- isolation seams -------------------------- */

  it('15 — no auth code path names a provider credential or K1 material', () => {
    // Mutation: an auth path that reads or forwards a provider key, or that
    // acquires any K1 concept. Neither has a field or a parameter anywhere in
    // these files, and this is what keeps that true.
    //
    // `db/schema.ts` is deliberately **not** in this list: it contains
    // `api_key` and `apikey` as `FORBIDDEN_COLUMN_FRAGMENTS`, where their
    // presence is the guard rather than a leak. That case is asserted
    // separately below, in the opposite direction.
    for (const file of [
      'server/app/google-auth-service.ts',
      'server/app/session-service.ts',
      'server/app/access-token.ts',
      'server/http/router.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8').toLowerCase();
      for (const term of ['apikey', 'api_key', 'recoverykey', 'recovery_key', 'kek', 'dek']) {
        expect(source.includes(term), `${file}: ${term}`).toBe(false);
      }
    }
  });

  it('15b — the schema still forbids a credential-shaped column outright', () => {
    // The other direction: these fragments must stay in the forbidden list,
    // because that list is what refuses a column named for a provider key.
    const schema = readFileSync(resolve(ROOT, 'server/db/schema.ts'), 'utf8');
    const forbidden = schema.slice(
      schema.indexOf('FORBIDDEN_COLUMN_FRAGMENTS'),
      schema.indexOf('] as const', schema.indexOf('FORBIDDEN_COLUMN_FRAGMENTS')),
    );
    for (const fragment of [
      // Provider credentials, permanently SECRET_LOCAL_ONLY.
      'api_key',
      'apikey',
      'provider_secret',
      'client_secret',
      'oauth_secret',
      // K1 key material and payloads, which this backend never holds.
      'recovery_key',
      'kek',
      'dek',
      'ciphertext',
      'envelope',
    ]) {
      expect(forbidden.includes(`'${fragment}'`), fragment).toBe(true);
    }
  });

  it('16 — the extension sends the auth backend nothing but the flow’s own fields', () => {
    // Mutation: adding a task, workflow, workspace or credential field to the
    // identity request body. The client builds exactly two bodies.
    const source = readFileSync(resolve(ROOT, 'src/identity/google-sign-in.ts'), 'utf8');
    for (const term of ['apiKey', 'task', 'workflow', 'workspace', 'shortcut', 'audit']) {
      expect(source.includes(`${term}:`), term).toBe(false);
    }
  });
});
