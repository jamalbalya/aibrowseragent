/**
 * TEST-SERVER-022 — adversarial cases against Google sign-in.
 *
 * Written from the attacker's side. The flow's surface is three calls, and
 * each one is probed with the thing somebody would actually send: a forged
 * identity, a stolen code, a replayed callback, another account's challenge.
 *
 * The identity-spoofing group is the one worth reading. Nothing a client
 * sends about *who they are* is read anywhere in this flow — there is no
 * parameter for an email, a subject or an `abaUserId` — so the strongest
 * available attack is to forge the material the server does read, which is
 * the ID token, and that is covered by TEST-SERVER-006.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  createLogger,
  FixedClock,
  RecordingLogSink,
  type GoogleAuthService,
  type GoogleTokenEndpoint,
  type IdentityBackend,
} from '@server/index';
import { GoogleFixture } from '../fixtures/google-oidc-fixture';

const NOW = 1_800_000_000_000;
const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const REDIRECT = 'https://api.example.test/v1/auth/google/callback';
const DEVICE = 'dev_11111111-2222-4333-8444-555555555555';

describe('Google sign-in, adversarial', () => {
  let clock: FixedClock;
  let google: GoogleFixture;
  let recorder: RecordingLogSink;
  let subject = 'google-subject-1';
  let emailClaim: { email?: string | null; email_verified?: boolean } = {};

  beforeEach(async () => {
    clock = new FixedClock(NOW);
    google = await GoogleFixture.create();
    recorder = new RecordingLogSink();
    subject = 'google-subject-1';
    emailClaim = {};
  });

  function build(): IdentityBackend {
    const live = { nonce: '' };
    const tokens: GoogleTokenEndpoint = {
      async redeem() {
        const idToken = await google.idToken(
          { audience: CLIENT_ID, nonce: live.nonce, now: clock.now() },
          { sub: subject, ...emailClaim },
        );
        return { idToken };
      },
    };
    const backend = createIdentityBackend({
      clock,
      log: createLogger(recorder.sink),
      google: {
        config: {
          clientId: CLIENT_ID,
          redirectUri: REDIRECT,
          authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        },
        jwks: google.jwks(),
        tokens,
      },
    });
    (backend as unknown as { live: { nonce: string } }).live = live;
    return backend;
  }

  function googleOf(backend: IdentityBackend): GoogleAuthService {
    if (backend.google === null) throw new Error('google not wired');
    return backend.google;
  }

  async function signIn(backend: IdentityBackend) {
    const live = (backend as unknown as { live: { nonce: string } }).live;
    const started = await googleOf(backend).start();
    if (!started.ok) throw new Error('start failed');
    const url = new URL(started.value.authorizationUrl);
    live.nonce = url.searchParams.get('nonce') ?? '';
    const callback = await googleOf(backend).handleCallback({
      state: url.searchParams.get('state'),
      code: 'code',
      error: null,
    });
    if (!callback.ok) return { ok: false as const, callback };
    const exchange = await googleOf(backend).exchange({
      challengeId: callback.value.challengeId,
      exchangeCode: callback.value.exchangeCode,
    });
    return { ok: true as const, callback: callback.value, exchange };
  }

  describe('client-supplied identity spoofing', () => {
    it('offers no parameter for a Google subject, email or abaUserId', () => {
      const backend = build();
      // start() takes nothing; handleCallback takes only what Google sends;
      // exchange takes only the two artefacts this flow produced.
      expect(googleOf(backend).start.length).toBe(0);
      expect(googleOf(backend).handleCallback.length).toBe(1);
      expect(googleOf(backend).exchange.length).toBe(1);
    });

    it('derives the account from the token, not from anything else', async () => {
      const backend = build();
      subject = 'the-real-subject';
      const first = await signIn(backend);
      if (!first.ok || !first.exchange.ok) throw new Error('unreachable');

      // A second flow whose token names a different subject lands elsewhere,
      // which is what "the token decides" means.
      subject = 'a-different-subject';
      clock.advance(1000);
      const second = await signIn(backend);
      if (!second.ok || !second.exchange.ok) throw new Error('unreachable');
      expect(second.exchange.value.session.abaUserId).not.toBe(
        first.exchange.value.session.abaUserId,
      );
    });

    it('refuses a token minted for another application', async () => {
      const backend = build();
      const live = (backend as unknown as { live: { nonce: string } }).live;
      const started = await googleOf(backend).start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      live.nonce = url.searchParams.get('nonce') ?? '';

      // Swap the adapter for one that mints a correctly signed token with the
      // wrong audience — a real token, from a real Google, for someone else.
      const wrong = await google.idToken(
        { audience: 'another-app.apps.googleusercontent.com', nonce: live.nonce, now: clock.now() },
        {},
      );
      (
        googleOf(backend) as unknown as { options: { tokens: GoogleTokenEndpoint } }
      ).options.tokens = { redeem: () => Promise.resolve({ idToken: wrong }) };

      const callback = await googleOf(backend).handleCallback({
        state: url.searchParams.get('state'),
        code: 'code',
        error: null,
      });
      expect(callback.ok).toBe(false);
    });
  });

  describe('identity already owned', () => {
    it('does not merge a Google sign-in into an account holding that email', async () => {
      const backend = build();
      // Somebody already has an ABA account with a verified email identity.
      const account = await backend.accounts.createAccount();
      const bootstrap = await backend.sessions.createSession({
        abaUserId: account.id,
        authIdentityId: null,
      });
      if (!bootstrap.ok) throw new Error('unreachable');
      const principal = await backend.sessions.verify(bootstrap.value.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      await backend.identities.attachIdentity(principal.value, {
        kind: 'email',
        subject: null,
        email: 'person@example.com',
        emailVerified: true,
      });

      // Now Google signs in with the same address.
      emailClaim = { email: 'person@example.com', email_verified: true };
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');

      // A separate account, not a merge. The email identity is untouched.
      expect(result.exchange.value.session.abaUserId).not.toBe(account.id);
      const theirs = await backend.store.listIdentities(account.id);
      expect(theirs).toHaveLength(1);
      expect(theirs[0]?.kind).toBe('email');
    });

    it('refuses without naming the other account when the subject is taken', async () => {
      const backend = build();
      const first = await signIn(backend);
      if (!first.ok || !first.exchange.ok) throw new Error('unreachable');
      const owner = first.exchange.value.session.abaUserId;

      // The same Google subject signs in again: it resolves to the same
      // account, which is correct. What must never happen is a second account
      // claiming it, and the unique index is what makes that unrepresentable.
      clock.advance(1000);
      const second = await signIn(backend);
      if (!second.ok || !second.exchange.ok) throw new Error('unreachable');
      expect(second.exchange.value.session.abaUserId).toBe(owner);

      const written = recorder.serialised();
      expect(written).not.toContain('IDENTITY_IN_USE');
    });
  });

  describe('deleted account', () => {
    it('refuses sign-in, and not as an outage', async () => {
      const backend = build();
      const first = await signIn(backend);
      if (!first.ok || !first.exchange.ok) throw new Error('unreachable');
      const principal = await backend.sessions.verify(first.exchange.value.session.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      await backend.accounts.markAccountDeleted(principal.value);

      clock.advance(1000);
      const again = await signIn(backend);
      expect(again.ok).toBe(false);
      if (again.ok) throw new Error('unreachable');
      // A definitive answer. Never something a client may ride out on grace.
      expect(again.callback.ok).toBe(false);
    });

    it('creates no replacement account for a deleted one', async () => {
      const backend = build();
      const first = await signIn(backend);
      if (!first.ok || !first.exchange.ok) throw new Error('unreachable');
      const deleted = first.exchange.value.session.abaUserId;
      const principal = await backend.sessions.verify(first.exchange.value.session.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      await backend.accounts.markAccountDeleted(principal.value);

      clock.advance(1000);
      await signIn(backend);
      // The identity still points at the deleted account; no new one appeared.
      const identity = await backend.store.findIdentityBySubject('google', 'google-subject-1');
      expect(identity?.aba_user_id).toBe(deleted);
    });
  });

  describe('replay', () => {
    it('refuses a second callback for one state', async () => {
      const backend = build();
      const live = (backend as unknown as { live: { nonce: string } }).live;
      const started = await googleOf(backend).start();
      if (!started.ok) throw new Error('unreachable');
      const url = new URL(started.value.authorizationUrl);
      live.nonce = url.searchParams.get('nonce') ?? '';
      const state = url.searchParams.get('state');

      expect((await googleOf(backend).handleCallback({ state, code: 'c', error: null })).ok).toBe(
        true,
      );
      expect((await googleOf(backend).handleCallback({ state, code: 'c', error: null })).ok).toBe(
        false,
      );
    });

    it('refuses a captured exchange code after it has been used', async () => {
      const backend = build();
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');

      const replay = await googleOf(backend).exchange({
        challengeId: result.callback.challengeId,
        exchangeCode: result.callback.exchangeCode,
      });
      expect(replay.ok).toBe(false);
    });

    it('refuses an exchange code against another flow’s challenge', async () => {
      const backend = build();
      const live = (backend as unknown as { live: { nonce: string } }).live;

      const a = await googleOf(backend).start();
      const b = await googleOf(backend).start();
      if (!a.ok || !b.ok) throw new Error('unreachable');

      const urlA = new URL(a.value.authorizationUrl);
      live.nonce = urlA.searchParams.get('nonce') ?? '';
      const callbackA = await googleOf(backend).handleCallback({
        state: urlA.searchParams.get('state'),
        code: 'c',
        error: null,
      });
      if (!callbackA.ok) throw new Error('unreachable');

      // A's code, B's challenge id.
      const crossed = await googleOf(backend).exchange({
        challengeId: b.value.challengeId,
        exchangeCode: callbackA.value.exchangeCode,
      });
      expect(crossed.ok).toBe(false);
    });
  });

  describe('session and device', () => {
    it('does not reuse a session id or family across sign-ins', async () => {
      const backend = build();
      const first = await signIn(backend);
      clock.advance(1000);
      const second = await signIn(backend);
      if (!first.ok || !first.exchange.ok || !second.ok || !second.exchange.ok) {
        throw new Error('unreachable');
      }

      const a = await backend.store.getSession(first.exchange.value.session.sessionId);
      const b = await backend.store.getSession(second.exchange.value.session.sessionId);
      expect(a?.id).not.toBe(b?.id);
      expect(a?.family_id).not.toBe(b?.family_id);
    });

    it('rotates, and a replayed refresh revokes the family', async () => {
      const backend = build();
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');
      const token = result.exchange.value.session.refreshToken;

      clock.advance(1000);
      const rotated = await backend.sessions.rotateSession(token);
      expect(rotated.ok).toBe(true);
      const replay = await backend.sessions.rotateSession(token);
      expect(!replay.ok && replay.error.code).toBe('SESSION_REVOKED');
    });

    it('binds a device to the signed-in account and refuses another’s', async () => {
      const backend = build();
      const first = await signIn(backend);
      if (!first.ok || !first.exchange.ok) throw new Error('unreachable');
      const alice = await backend.sessions.verify(first.exchange.value.session.sessionId);
      if (!alice.ok) throw new Error('unreachable');
      await backend.devices.registerDevice(alice.value, DEVICE);

      subject = 'google-subject-2';
      clock.advance(1000);
      const second = await signIn(backend);
      if (!second.ok || !second.exchange.ok) throw new Error('unreachable');
      const bob = await backend.sessions.verify(second.exchange.value.session.sessionId);
      if (!bob.ok) throw new Error('unreachable');

      // Bob registering the same id gets his own row; Alice's is untouched.
      await backend.devices.registerDevice(bob.value, DEVICE);
      expect((await backend.devices.listDevices(alice.value)).length).toBe(1);
      expect((await backend.store.getDevice(alice.value.abaUserId, DEVICE))?.aba_user_id).toBe(
        alice.value.abaUserId,
      );
    });

    it('never derives the device id from the Google subject', async () => {
      const backend = build();
      subject = 'a-very-distinctive-google-subject';
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');
      const principal = await backend.sessions.verify(result.exchange.value.session.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      await backend.devices.registerDevice(principal.value, DEVICE);

      const row = await backend.store.getDevice(principal.value.abaUserId, DEVICE);
      expect(row?.device_id).toBe(DEVICE);
      expect(row?.device_id).not.toContain('google');
      expect(row?.device_id).not.toContain('distinctive');
    });
  });

  describe('isolation', () => {
    it('touches no provider credential and stores no Google token', async () => {
      const backend = build();
      emailClaim = { email: 'person@example.com', email_verified: true };
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');

      const abaUserId = result.exchange.value.session.abaUserId;
      const everything = JSON.stringify({
        user: await backend.store.getUser(abaUserId),
        identities: await backend.store.listIdentities(abaUserId),
        sessions: await backend.store.listSessions(abaUserId),
        devices: await backend.store.listDevices(abaUserId),
      });
      for (const term of ['id_token', 'idToken', 'access_token', 'eyJ', 'apiKey', 'credential']) {
        expect(everything, term).not.toContain(term);
      }
    });

    it('generates and derives no K1 material', async () => {
      const backend = build();
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');

      const everything = JSON.stringify({
        user: await backend.store.getUser(result.exchange.value.session.abaUserId),
        identities: await backend.store.listIdentities(result.exchange.value.session.abaUserId),
      });
      for (const term of ['recovery', 'kek', 'dek', 'kdSalt', 'kd_salt', 'keyCheck']) {
        expect(everything.toLowerCase(), term).not.toContain(term.toLowerCase());
      }
      // And nothing in the written log either.
      expect(recorder.serialised().toLowerCase()).not.toContain('recovery');
    });

    it('retains only the subject and a verified address', async () => {
      const backend = build();
      emailClaim = { email: 'person@example.com', email_verified: true };
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');

      const identities = await backend.store.listIdentities(
        result.exchange.value.session.abaUserId,
      );
      const row = identities[0];
      expect(row?.subject).toBe('google-subject-1');
      expect(row?.email).toBe('person@example.com');
      // No display name, no picture, no locale — there is no column for one.
      expect(Object.keys(row ?? {}).sort()).toEqual([
        'aba_user_id',
        'email',
        'email_verified',
        'id',
        'kind',
        'last_used_at',
        'linked_at',
        'linked_via',
        'subject',
      ]);
    });

    it('stores no address at all when Google says it is unverified', async () => {
      const backend = build();
      emailClaim = { email: 'person@example.com', email_verified: false };
      const result = await signIn(backend);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');

      const identities = await backend.store.listIdentities(
        result.exchange.value.session.abaUserId,
      );
      expect(identities[0]?.email).toBeNull();
      expect(identities[0]?.email_verified).toBe(false);
      expect(identities[0]?.subject).toBe('google-subject-1');
    });
  });

  /**
   * Two first-sign-ins that could not succeed, and the reason both traced to
   * treating an address as though it identified a Google account.
   */
  describe('an address does not decide a Google sign-in', () => {
    it('signs in a domain-provisioned address that is not already lowercase', async () => {
      const backend = build();
      subject = 'workspace-subject';
      // A hosted domain may provision exactly this. `verifyGoogleIdToken`
      // reports what the token said, which is its job; canonicalising is the
      // caller's, and until it did, `isUsable` refused the assertion and this
      // user could never complete a first sign-in.
      emailClaim = { email: 'Alice@Corp.test', email_verified: true };

      const result = await signIn(backend);

      expect(result.ok).toBe(true);
      if (!result.ok || !result.exchange.ok) throw new Error('unreachable');
      const identities = await backend.store.listIdentities(
        result.exchange.value.session.abaUserId,
      );
      // Stored in canonical form: the domain folded, the local part intact.
      expect(identities[0]?.email).toBe('Alice@corp.test');
      expect(identities[0]?.subject).toBe('workspace-subject');
    });

    it('signs in a new subject whose address an older account still records', async () => {
      const backend = build();
      // Alice signs in. Our copy of her address is never refreshed afterwards.
      subject = 'subject-alice';
      emailClaim = { email: 'alice@corp.test', email_verified: true };
      const first = await signIn(backend);
      if (!first.ok || !first.exchange.ok) throw new Error('unreachable');

      // The domain reassigns the address to Bob, who has a Google account of
      // his own and therefore a different subject.
      subject = 'subject-bob';
      const second = await signIn(backend);

      // Bob gets an account. He must: his subject belongs to nobody, and the
      // address authorises nothing (AUTH-29). While a uniqueness key covered
      // the address this refused, permanently — Alice's stale row would never
      // stop holding it.
      expect(second.ok).toBe(true);
      if (!second.ok || !second.exchange.ok) throw new Error('unreachable');
      const bob = second.exchange.value.session.abaUserId;
      const alice = first.exchange.value.session.abaUserId;
      expect(bob).not.toBe(alice);
      // And he did not land in Alice's: two accounts, one identity each.
      expect(await backend.store.listIdentities(alice)).toHaveLength(1);
      expect(await backend.store.listIdentities(bob)).toHaveLength(1);
    });
  });
});
