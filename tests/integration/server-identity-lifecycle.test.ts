/**
 * TEST-SERVER-010 — the identity foundation end to end.
 *
 * Each case is a sequence a real person produces, run through the services in
 * the order the transport would call them. Unit tests prove each rule; these
 * prove the rules compose — which is where a design usually fails, because
 * every individual step is correct and the sequence is not.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  FixedClock,
  normaliseEmail,
  REFRESH_TTL_MS,
  type IdentityBackend,
  type VerifiedIdentity,
} from '@server/index';

const T0 = 1_800_000_000_000;
const DEVICE_1 = 'dev_11111111-2222-4333-8444-555555555555';
const DEVICE_2 = 'dev_66666666-7777-4888-8999-aaaaaaaaaaaa';

const googleIdentity = (sub: string, email: string): VerifiedIdentity => ({
  kind: 'google',
  subject: sub,
  email: normaliseEmail(email),
  emailVerified: true,
});

const emailIdentity = (email: string): VerifiedIdentity => ({
  kind: 'email',
  subject: null,
  email: normaliseEmail(email),
  emailVerified: true,
});

describe('identity foundation, end to end', () => {
  let clock: FixedClock;
  let backend: IdentityBackend;

  beforeEach(() => {
    clock = new FixedClock(T0);
    backend = createIdentityBackend({ clock });
  });

  /**
   * What a completed external flow would do: resolve the identity, create the
   * account when it is unknown, open a session, attach the identity.
   *
   * The external flows themselves — Google's code exchange, the email OTP —
   * are not implemented in this phase. This is the seam they will plug into,
   * and writing it here is what makes the rest of the sequence testable now.
   */
  async function signIn(identity: VerifiedIdentity): Promise<{
    abaUserId: string;
    sessionId: string;
    refreshToken: string;
  }> {
    const resolved = await backend.identities.resolveIdentity(identity);
    if (!resolved.ok) throw new Error(`resolve failed: ${resolved.error.code}`);

    const abaUserId =
      resolved.value.kind === 'existing'
        ? resolved.value.abaUserId
        : (await backend.accounts.createAccount()).id;

    const identityId = resolved.value.kind === 'existing' ? resolved.value.identity.id : null;
    const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: identityId });
    if (!issued.ok) throw new Error(`session failed: ${issued.error.code}`);

    if (resolved.value.kind === 'unknown') {
      const principal = await backend.sessions.verify(issued.value.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      const attached = await backend.identities.attachIdentity(principal.value, identity);
      if (!attached.ok) throw new Error(`attach failed: ${attached.error.code}`);
    }

    return {
      abaUserId,
      sessionId: issued.value.sessionId,
      refreshToken: issued.value.refreshToken,
    };
  }

  it('creates one account on first sign-in and returns to it on the second', async () => {
    const first = await signIn(googleIdentity('sub-1', 'person@example.com'));
    clock.advance(86_400_000);
    const second = await signIn(googleIdentity('sub-1', 'person@example.com'));

    expect(second.abaUserId).toBe(first.abaUserId);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('links an email identity and then signs in through either one', async () => {
    const google = await signIn(googleIdentity('sub-1', 'person@example.com'));
    const principal = await backend.sessions.verify(google.sessionId);
    if (!principal.ok) throw new Error('unreachable');

    const linked = await backend.identities.attachIdentity(
      principal.value,
      emailIdentity('other@example.com'),
    );
    expect(linked.ok).toBe(true);

    const viaEmail = await signIn(emailIdentity('other@example.com'));
    expect(viaEmail.abaUserId).toBe(google.abaUserId);
  });

  it('keeps two people apart when one tries to link the other’s identity', async () => {
    const alice = await signIn(googleIdentity('sub-alice', 'alice@example.com'));
    const bob = await signIn(emailIdentity('bob@example.com'));
    expect(bob.abaUserId).not.toBe(alice.abaUserId);

    const bobPrincipal = await backend.sessions.verify(bob.sessionId);
    if (!bobPrincipal.ok) throw new Error('unreachable');
    const attempt = await backend.identities.attachIdentity(
      bobPrincipal.value,
      googleIdentity('sub-alice', 'alice@example.com'),
    );

    expect(!attempt.ok && attempt.error.code).toBe('IDENTITY_IN_USE');
    // Alice still owns it, and it still resolves to her.
    const resolved = await backend.identities.resolveIdentity(
      googleIdentity('sub-alice', 'alice@example.com'),
    );
    expect(resolved.ok && resolved.value.kind === 'existing' && resolved.value.abaUserId).toBe(
      alice.abaUserId,
    );
  });

  it('survives a reinstall: same account, new device, work-free session', async () => {
    const first = await signIn(googleIdentity('sub-1', 'person@example.com'));
    let principal = await backend.sessions.verify(first.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    await backend.devices.registerDevice(principal.value, DEVICE_1);

    // The extension is reinstalled: local storage is gone, so the session and
    // the deviceId are too. The person signs in again.
    clock.advance(86_400_000);
    const second = await signIn(googleIdentity('sub-1', 'person@example.com'));
    principal = await backend.sessions.verify(second.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    await backend.devices.registerDevice(principal.value, DEVICE_2);

    expect(second.abaUserId).toBe(first.abaUserId);
    const devices = await backend.devices.listDevices(principal.value);
    expect(devices.map((row) => row.device_id).sort()).toEqual([DEVICE_1, DEVICE_2].sort());
  });

  it('keeps a session alive across a month of use through rotation', async () => {
    const signedIn = await signIn(googleIdentity('sub-1', 'person@example.com'));
    let token = signedIn.refreshToken;

    for (let day = 0; day < 40; day += 1) {
      clock.advance(24 * 60 * 60 * 1000);
      const rotated = await backend.sessions.rotateSession(token);
      expect(rotated.ok, `day ${day}`).toBe(true);
      if (!rotated.ok) throw new Error('unreachable');
      token = rotated.value.refreshToken;
      expect(rotated.value.abaUserId).toBe(signedIn.abaUserId);
    }
  });

  it('expires an idle session after the refresh lifetime', async () => {
    const signedIn = await signIn(googleIdentity('sub-1', 'person@example.com'));
    clock.advance(REFRESH_TTL_MS);
    const rotated = await backend.sessions.rotateSession(signedIn.refreshToken);
    expect(!rotated.ok && rotated.error.code).toBe('AUTH_REQUIRED');
  });

  it('signs out without losing the account, the identity or the device', async () => {
    const signedIn = await signIn(googleIdentity('sub-1', 'person@example.com'));
    const principal = await backend.sessions.verify(signedIn.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    await backend.devices.registerDevice(principal.value, DEVICE_1);

    await backend.sessions.revokeSession(principal.value);

    // Everything durable survives (AUTH-9).
    expect((await backend.store.getUser(signedIn.abaUserId))?.state).toBe('active');
    expect(await backend.store.listIdentities(signedIn.abaUserId)).toHaveLength(1);
    expect(await backend.store.listDevices(signedIn.abaUserId)).toHaveLength(1);

    // And signing back in returns the same account with no recovery step.
    const again = await signIn(googleIdentity('sub-1', 'person@example.com'));
    expect(again.abaUserId).toBe(signedIn.abaUserId);
  });

  it('unlinks one identity, revoking only the sessions it established', async () => {
    const viaGoogle = await signIn(googleIdentity('sub-1', 'person@example.com'));
    let principal = await backend.sessions.verify(viaGoogle.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    const emailRow = await backend.identities.attachIdentity(
      principal.value,
      emailIdentity('other@example.com'),
    );
    if (!emailRow.ok) throw new Error('unreachable');

    // A second sign-in, through the email identity this time.
    const viaEmail = await signIn(emailIdentity('other@example.com'));
    expect(viaEmail.abaUserId).toBe(viaGoogle.abaUserId);

    principal = await backend.sessions.verify(viaGoogle.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    const detached = await backend.identities.detachIdentity(principal.value, emailRow.value.id);
    expect(detached.ok && detached.value.revokedSessions).toBe(1);

    // The email session is gone; the Google session is not.
    expect((await backend.sessions.verify(viaEmail.sessionId)).ok).toBe(false);
    expect((await backend.sessions.verify(viaGoogle.sessionId)).ok).toBe(true);
    // And the account is untouched.
    expect((await backend.store.getUser(viaGoogle.abaUserId))?.state).toBe('active');
  });

  it('ends every session when the account is deleted, and refuses afterwards', async () => {
    const signedIn = await signIn(googleIdentity('sub-1', 'person@example.com'));
    const other = await backend.sessions.createSession({
      abaUserId: signedIn.abaUserId,
      authIdentityId: null,
    });
    if (!other.ok) throw new Error('unreachable');
    const principal = await backend.sessions.verify(signedIn.sessionId);
    if (!principal.ok) throw new Error('unreachable');

    const deleted = await backend.accounts.markAccountDeleted(principal.value);
    expect(deleted.ok && deleted.value.state).toBe('deleted');
    expect(deleted.ok && deleted.value.deleted_at).toBe(clock.now());

    for (const id of [signedIn.sessionId, other.value.sessionId]) {
      const verified = await backend.sessions.verify(id);
      expect(verified.ok, id).toBe(false);
    }
    const rotated = await backend.sessions.rotateSession(signedIn.refreshToken);
    expect(!rotated.ok && rotated.error.code).toBe('SESSION_REVOKED');
  });

  it('refuses a new session for a deleted account', async () => {
    const signedIn = await signIn(googleIdentity('sub-1', 'person@example.com'));
    const principal = await backend.sessions.verify(signedIn.sessionId);
    if (!principal.ok) throw new Error('unreachable');
    await backend.accounts.markAccountDeleted(principal.value);

    const attempt = await backend.sessions.createSession({
      abaUserId: signedIn.abaUserId,
      authIdentityId: null,
    });
    expect(!attempt.ok && attempt.error.code).toBe('ACCOUNT_DELETED');
  });
});

describe('referential integrity across an unlink', () => {
  it('keeps the revoked session row, with its provenance cleared', async () => {
    const clock = new FixedClock(T0);
    const backend = createIdentityBackend({ clock });

    const account = await backend.accounts.createAccount();
    const bootstrap = await backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!bootstrap.ok) throw new Error('unreachable');
    const principal = await backend.sessions.verify(bootstrap.value.sessionId);
    if (!principal.ok) throw new Error('unreachable');

    const keep = await backend.identities.attachIdentity(principal.value, {
      kind: 'google',
      subject: 'sub-keep',
      email: null,
      emailVerified: false,
    });
    const remove = await backend.identities.attachIdentity(principal.value, {
      kind: 'email',
      subject: null,
      email: 'person@example.com',
      emailVerified: true,
    });
    if (!keep.ok || !remove.ok) throw new Error('unreachable');

    const throughRemoved = await backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: remove.value.id,
    });
    if (!throughRemoved.ok) throw new Error('unreachable');

    clock.advance(1000);
    await backend.identities.detachIdentity(principal.value, remove.value.id);

    // The row survives the identity being deleted — `ON DELETE SET NULL`, not
    // CASCADE — so the record of *why* it was revoked is still there.
    const row = await backend.store.getSession(throughRemoved.value.sessionId);
    expect(row).not.toBeNull();
    expect(row?.revoked_at).toBe(T0 + 1000);
    expect(row?.revoked_reason).toBe('identity_unlinked');
    expect(row?.auth_identity_id).toBeNull();
  });
});
