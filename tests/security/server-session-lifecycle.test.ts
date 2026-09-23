/**
 * TEST-SECURITY-049 — the session lifecycle, and the race that broke it.
 *
 * The first case in this file is the one the suite exists for. Before the
 * atomic claim, `rotateSession` was a read, a check and a write with nothing
 * holding them together: two concurrent presentations of one refresh token
 * both read `rotated_at` as null, both passed the reuse check, and both minted
 * a successor. One single-use token produced two independently valid
 * sessions, and neither was detected as reuse — which is the exact failure
 * reuse detection exists to catch.
 *
 * That is why the assertions here are about *outcomes under concurrency*
 * rather than about sequential steps. A sequential test passed throughout the
 * period the defect existed.
 *
 * The rest of the file pins the lifecycle properties that surround it, so a
 * later change to rotation cannot quietly cost one of them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  createLogger,
  FixedClock,
  RecordingLogSink,
  REFRESH_TTL_MS,
  type IdentityBackend,
} from '@server/index';

const NOW = 1_800_000_000_000;

describe('refresh rotation under concurrency', () => {
  let clock: FixedClock;
  let recorder: RecordingLogSink;
  let backend: IdentityBackend;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    recorder = new RecordingLogSink();
    backend = createIdentityBackend({ clock, log: createLogger(recorder.sink) });
  });

  /** An account with one live session. */
  async function signedIn(): Promise<{ abaUserId: string; refreshToken: string }> {
    const user = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: user.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('session not issued');
    return { abaUserId: user.id, refreshToken: issued.value.refreshToken };
  }

  it('01 — two concurrent uses of one refresh token never yield two valid sessions', async () => {
    const { refreshToken } = await signedIn();

    const [a, b] = await Promise.all([
      backend.sessions.rotateSession(refreshToken),
      backend.sessions.rotateSession(refreshToken),
    ]);

    const succeeded = [a, b].filter((result) => result.ok);
    // At most one, and in practice exactly one: the claim decides.
    expect(succeeded.length).toBeLessThanOrEqual(1);

    // And whatever did succeed must not still be usable, because losing the
    // race is treated as reuse and reuse revokes the whole family.
    for (const result of succeeded) {
      if (!result.ok) continue;
      const verified = await backend.sessions.verify(result.value.sessionId);
      expect(verified.ok).toBe(false);
    }
  });

  it('02 — a detected race is reported as reuse, and leaves nothing usable', async () => {
    const { refreshToken } = await signedIn();

    const results = await Promise.all([
      backend.sessions.rotateSession(refreshToken),
      backend.sessions.rotateSession(refreshToken),
    ]);
    const failures = results.filter((result) => !result.ok);

    // How many fail depends on where the two calls interleave, and both
    // outcomes are safe: either the loser alone is refused and the winner's
    // successor is revoked underneath it, or the winner also notices the
    // revocation and refuses too. What must never vary is that no usable
    // session comes out, so that is what is asserted rather than a count.
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const failure of failures) {
      expect(failure.ok === false && failure.error.code).toBe('SESSION_REVOKED');
    }
    // Said out loud in the log, because a reuse signal that nobody records is
    // a compromise nobody can investigate.
    expect(JSON.stringify(recorder.records)).toContain('session.refresh.reuse');
  });

  it('03 — many concurrent uses still yield at most one winner', async () => {
    const { refreshToken } = await signedIn();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => backend.sessions.rotateSession(refreshToken)),
    );

    expect(results.filter((result) => result.ok).length).toBeLessThanOrEqual(1);
  });

  it('04 — the whole family is revoked, so the winner cannot be used either', async () => {
    const { abaUserId, refreshToken } = await signedIn();

    await Promise.all([
      backend.sessions.rotateSession(refreshToken),
      backend.sessions.rotateSession(refreshToken),
    ]);

    // Revoking only the presented token would leave a thief's copy working;
    // §6.3 revokes the family for exactly that reason.
    const sessions = await backend.store.listSessions(abaUserId);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.revoked_at, session.id).not.toBeNull();
    }
  });

  it('05 — a sequential rotation still works, and the old token is then reuse', async () => {
    const { refreshToken } = await signedIn();

    const first = await backend.sessions.rotateSession(refreshToken);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.value.refreshToken).not.toBe(refreshToken);

    // The ordinary path is unchanged: this is the case that passed throughout
    // the period the concurrent defect existed, which is why it is not enough.
    const replay = await backend.sessions.rotateSession(refreshToken);
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error('unreachable');
    expect(replay.error.code).toBe('SESSION_REVOKED');
  });

  it('06 — a rotated token never appears in plaintext in any stored row', async () => {
    const { abaUserId, refreshToken } = await signedIn();
    const rotated = await backend.sessions.rotateSession(refreshToken);
    if (!rotated.ok) throw new Error('unreachable');

    const stored = JSON.stringify(await backend.store.listSessions(abaUserId));
    expect(stored).not.toContain(refreshToken);
    expect(stored).not.toContain(rotated.value.refreshToken);
    // What is stored is a digest, and it is not the token.
    expect(stored).toContain('refresh_digest');
  });

  it('07 — no refresh token, old or new, reaches the log', async () => {
    const { refreshToken } = await signedIn();
    const rotated = await backend.sessions.rotateSession(refreshToken);
    if (!rotated.ok) throw new Error('unreachable');

    const logs = JSON.stringify(recorder.records);
    expect(logs).not.toContain(refreshToken);
    expect(logs).not.toContain(rotated.value.refreshToken);
  });
});

describe('session lifecycle boundaries', () => {
  let clock: FixedClock;
  let backend: IdentityBackend;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    backend = createIdentityBackend({ clock });
  });

  async function signedIn(): Promise<{
    abaUserId: string;
    refreshToken: string;
    sessionId: string;
  }> {
    const user = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: user.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('session not issued');
    return {
      abaUserId: user.id,
      refreshToken: issued.value.refreshToken,
      sessionId: issued.value.sessionId,
    };
  }

  it('08 — an expired refresh token is refused without revealing it once existed', async () => {
    const { refreshToken } = await signedIn();
    clock.set(NOW + REFRESH_TTL_MS + 1);

    const result = await backend.sessions.rotateSession(refreshToken);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The same code an unknown token gets, so expiry is not an oracle.
    expect(result.error.code).toBe('AUTH_REQUIRED');
    const unknown = await backend.sessions.rotateSession('never-issued');
    expect(unknown.ok === false && unknown.error.code).toBe('AUTH_REQUIRED');
  });

  it('09 — a deleted account cannot rotate, and the answer is definitive', async () => {
    const { abaUserId, refreshToken } = await signedIn();
    await backend.store.markUserDeleted(abaUserId, clock.now());

    const result = await backend.sessions.rotateSession(refreshToken);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // An answer, never an outage: AUTH-14.
    expect(result.error.code).toBe('ACCOUNT_DELETED');
  });

  it('10 — a deleted account cannot verify an already-issued session either', async () => {
    const { abaUserId, sessionId } = await signedIn();
    expect((await backend.sessions.verify(sessionId)).ok).toBe(true);

    await backend.store.markUserDeleted(abaUserId, clock.now());

    // The session row outlives the account by exactly as long as nobody
    // checks, which is why verification re-reads the account every time.
    expect((await backend.sessions.verify(sessionId)).ok).toBe(false);
  });

  it('11 — a session id is not a credential and cannot be rotated with', async () => {
    const { sessionId } = await signedIn();

    // The session id is logged and is not secret. Only the refresh token
    // rotates, and presenting the id where a token belongs finds nothing.
    const result = await backend.sessions.rotateSession(sessionId);
    expect(result.ok).toBe(false);
  });

  it('12 — one account may hold several independent sessions', async () => {
    const user = await backend.accounts.createAccount();
    const a = await backend.sessions.createSession({ abaUserId: user.id, authIdentityId: null });
    const b = await backend.sessions.createSession({ abaUserId: user.id, authIdentityId: null });
    if (!a.ok || !b.ok) throw new Error('unreachable');

    // Separate families: one installation signing out must not sign the
    // others out, which is what makes rotation chains per-session (§6.4).
    expect(a.value.sessionId).not.toBe(b.value.sessionId);
    const rotated = await backend.sessions.rotateSession(a.value.refreshToken);
    expect(rotated.ok).toBe(true);
    expect((await backend.sessions.verify(b.value.sessionId)).ok).toBe(true);
  });

  it('13 — revoking one family leaves another account untouched', async () => {
    const mine = await signedIn();
    const theirs = await signedIn();

    await Promise.all([
      backend.sessions.rotateSession(mine.refreshToken),
      backend.sessions.rotateSession(mine.refreshToken),
    ]);

    // My family is revoked; theirs is not. Revocation is scoped by family,
    // and a family belongs to one account.
    expect((await backend.sessions.verify(theirs.sessionId)).ok).toBe(true);
  });
});
