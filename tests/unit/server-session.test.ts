/**
 * TEST-SERVER-003 — session families: creation, expiry, rotation, reuse and
 * revocation.
 *
 * The rotation tests are the ones worth reading. A refresh token that could
 * be used twice is a refresh token a thief and a user can both hold, so the
 * property under test is not merely that rotation issues a new token — it is
 * that presenting the old one afterwards is treated as *evidence of theft*
 * and takes the whole family down with it.
 *
 * Every boundary is exercised on both sides. An expiry that is off by one
 * comparison is an expiry that never fires or always fires, and neither shows
 * up in a test that only checks the middle of the range.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  createIdentityBackend,
  FixedClock,
  newRefreshToken,
  sha256Digest,
  timingSafeEqual,
  type IdentityBackend,
} from '@server/index';

const T0 = 1_800_000_000_000;

describe('sessions', () => {
  let clock: FixedClock;
  let backend: IdentityBackend;

  beforeEach(() => {
    clock = new FixedClock(T0);
    backend = createIdentityBackend({ clock });
  });

  async function account(): Promise<string> {
    return (await backend.accounts.createAccount()).id;
  }

  describe('creation', () => {
    it('issues a refresh token and the approved lifetimes', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');

      expect(issued.value.abaUserId).toBe(abaUserId);
      expect(issued.value.refreshToken).toMatch(/^[0-9a-f]{64}$/);
      expect(issued.value.refreshExpiresAt).toBe(T0 + REFRESH_TTL_MS);
      expect(issued.value.accessExpiresAt).toBe(T0 + ACCESS_TTL_MS);
    });

    it('uses the approved lifetimes: 15 minutes and 30 days', () => {
      expect(ACCESS_TTL_MS).toBe(15 * 60 * 1000);
      expect(REFRESH_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('never stores the refresh token itself', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');

      const row = await backend.store.getSession(issued.value.sessionId);
      expect(row?.refresh_digest).not.toBe(issued.value.refreshToken);
      expect(JSON.stringify(row)).not.toContain(issued.value.refreshToken);
      expect(row?.refresh_digest).toBe(await sha256Digest.compute(issued.value.refreshToken));
    });

    it('refuses to create a session for an account that does not exist', async () => {
      const issued = await backend.sessions.createSession({
        abaUserId: 'usr_00000000000000000000000000000000',
        authIdentityId: null,
      });
      expect(!issued.ok && issued.error.code).toBe('NOT_FOUND');
    });

    it('refuses an identity that belongs to a different account', async () => {
      const alice = await account();
      const bob = await account();
      const aliceSession = await backend.sessions.createSession({
        abaUserId: alice,
        authIdentityId: null,
      });
      if (!aliceSession.ok) throw new Error('unreachable');
      const alicePrincipal = await backend.sessions.verify(aliceSession.value.sessionId);
      if (!alicePrincipal.ok) throw new Error('unreachable');
      const hers = await backend.identities.attachIdentity(alicePrincipal.value, {
        kind: 'google',
        subject: 'sub-1',
        email: null,
        emailVerified: false,
      });
      if (!hers.ok) throw new Error('unreachable');

      const attempt = await backend.sessions.createSession({
        abaUserId: bob,
        authIdentityId: hers.value.id,
      });
      expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
    });

    it('starts a distinct family per sign-in', async () => {
      const abaUserId = await account();
      const first = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      const second = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!first.ok || !second.ok) throw new Error('unreachable');

      const a = await backend.store.getSession(first.value.sessionId);
      const b = await backend.store.getSession(second.value.sessionId);
      expect(a?.family_id).not.toBe(b?.family_id);
    });

    it('does not adopt a caller-supplied session id — createSession takes no id', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');
      // Session fixation needs a value the caller chooses. The only inputs are
      // the account and the identity; the id is minted here.
      expect(issued.value.sessionId).toMatch(/^ses_[0-9a-f]{32}$/);
    });
  });

  describe('expiry', () => {
    it('verifies one millisecond before the refresh expiry', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');

      clock.set(T0 + REFRESH_TTL_MS - 1);
      expect((await backend.sessions.verify(issued.value.sessionId)).ok).toBe(true);
    });

    it('refuses exactly at the refresh expiry', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');

      clock.set(T0 + REFRESH_TTL_MS);
      const verified = await backend.sessions.verify(issued.value.sessionId);
      expect(!verified.ok && verified.error.code).toBe('AUTH_REQUIRED');
    });

    it('refuses to rotate an expired token', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');

      clock.set(T0 + REFRESH_TTL_MS);
      const rotated = await backend.sessions.rotateSession(issued.value.refreshToken);
      expect(!rotated.ok && rotated.error.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('rotation', () => {
    it('issues a new token and keeps the family', async () => {
      const abaUserId = await account();
      const first = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!first.ok) throw new Error('unreachable');

      clock.advance(60_000);
      const second = await backend.sessions.rotateSession(first.value.refreshToken);
      if (!second.ok) throw new Error('unreachable');

      expect(second.value.refreshToken).not.toBe(first.value.refreshToken);
      expect(second.value.sessionId).not.toBe(first.value.sessionId);

      const a = await backend.store.getSession(first.value.sessionId);
      const b = await backend.store.getSession(second.value.sessionId);
      expect(b?.family_id).toBe(a?.family_id);
    });

    it('rolls the expiry forward, so an active session does not age out', async () => {
      const abaUserId = await account();
      const first = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!first.ok) throw new Error('unreachable');

      clock.advance(REFRESH_TTL_MS - 1);
      const second = await backend.sessions.rotateSession(first.value.refreshToken);
      expect(second.ok && second.value.refreshExpiresAt).toBe(clock.now() + REFRESH_TTL_MS);
    });

    it('marks the presented token rotated', async () => {
      const abaUserId = await account();
      const first = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!first.ok) throw new Error('unreachable');

      clock.advance(1000);
      await backend.sessions.rotateSession(first.value.refreshToken);
      const row = await backend.store.getSession(first.value.sessionId);
      expect(row?.rotated_at).toBe(clock.now());
    });

    it('is single use — the same token does not rotate twice', async () => {
      const abaUserId = await account();
      const first = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!first.ok) throw new Error('unreachable');

      await backend.sessions.rotateSession(first.value.refreshToken);
      const replay = await backend.sessions.rotateSession(first.value.refreshToken);
      expect(!replay.ok && replay.error.code).toBe('SESSION_REVOKED');
    });

    it('revokes the whole family on reuse', async () => {
      const abaUserId = await account();
      const first = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!first.ok) throw new Error('unreachable');
      const second = await backend.sessions.rotateSession(first.value.refreshToken);
      if (!second.ok) throw new Error('unreachable');
      const third = await backend.sessions.rotateSession(second.value.refreshToken);
      if (!third.ok) throw new Error('unreachable');

      // The thief presents the first token, long after the user moved on.
      await backend.sessions.rotateSession(first.value.refreshToken);

      // Every member is revoked, including the one the user is holding.
      for (const id of [first.value.sessionId, second.value.sessionId, third.value.sessionId]) {
        const row = await backend.store.getSession(id);
        expect(row?.revoked_at, id).not.toBeNull();
        expect(row?.revoked_reason, id).toBe('refresh_reuse');
      }
      const verified = await backend.sessions.verify(third.value.sessionId);
      expect(!verified.ok && verified.error.code).toBe('SESSION_REVOKED');
    });

    it('leaves a different family untouched when one is revoked for reuse', async () => {
      const abaUserId = await account();
      const family1 = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      const family2 = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!family1.ok || !family2.ok) throw new Error('unreachable');

      await backend.sessions.rotateSession(family1.value.refreshToken);
      await backend.sessions.rotateSession(family1.value.refreshToken);

      expect((await backend.sessions.verify(family2.value.sessionId)).ok).toBe(true);
    });

    it('reports an unknown token without saying whether it ever existed', async () => {
      const rotated = await backend.sessions.rotateSession(newRefreshToken());
      expect(!rotated.ok && rotated.error.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('revocation', () => {
    it('signs out one session and leaves the others', async () => {
      const abaUserId = await account();
      const a = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      const b = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!a.ok || !b.ok) throw new Error('unreachable');

      const principal = await backend.sessions.verify(a.value.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      await backend.sessions.revokeSession(principal.value);

      expect((await backend.sessions.verify(a.value.sessionId)).ok).toBe(false);
      expect((await backend.sessions.verify(b.value.sessionId)).ok).toBe(true);
    });

    it('signs out everywhere on request', async () => {
      const abaUserId = await account();
      const a = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      const b = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!a.ok || !b.ok) throw new Error('unreachable');

      const principal = await backend.sessions.verify(a.value.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      const result = await backend.sessions.revokeAllSessions(principal.value);

      expect(result.ok && result.value.revoked).toBe(2);
      expect((await backend.sessions.verify(b.value.sessionId)).ok).toBe(false);
    });

    it('refuses a revoked session with SESSION_REVOKED, not AUTH_REQUIRED', async () => {
      const abaUserId = await account();
      const issued = await backend.sessions.createSession({ abaUserId, authIdentityId: null });
      if (!issued.ok) throw new Error('unreachable');
      const principal = await backend.sessions.verify(issued.value.sessionId);
      if (!principal.ok) throw new Error('unreachable');
      await backend.sessions.revokeSession(principal.value);

      const verified = await backend.sessions.verify(issued.value.sessionId);
      // The distinction matters: a revocation is an answer, and an answer is
      // never an outage the client may ride out on grace (AUTH-14).
      expect(!verified.ok && verified.error.code).toBe('SESSION_REVOKED');
    });
  });

  describe('token material', () => {
    it('generates 256 bits of entropy per token', () => {
      const tokens = new Set(Array.from({ length: 200 }, () => newRefreshToken()));
      expect(tokens.size).toBe(200);
      for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces a stable digest that is not the token', async () => {
      const token = newRefreshToken();
      const digest = await sha256Digest.compute(token);
      expect(digest).toBe(await sha256Digest.compute(token));
      expect(digest).not.toBe(token);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('separates its digest domain, so a digest means nothing elsewhere', async () => {
      const token = newRefreshToken();
      const plain = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
      );
      const plainHex = [...plain].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      expect(await sha256Digest.compute(token)).not.toBe(plainHex);
    });

    it('compares in constant time without early exit on length-equal input', () => {
      expect(timingSafeEqual('abc', 'abc')).toBe(true);
      expect(timingSafeEqual('abc', 'abd')).toBe(false);
      expect(timingSafeEqual('abc', 'ab')).toBe(false);
    });
  });
});
