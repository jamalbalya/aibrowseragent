/**
 * TEST-SECURITY-062 — the security matrix for email one-time codes.
 *
 * Every case here drives the real `EmailAuthService` over a real
 * `MemoryStore`, a real `MemoryOtpChallengeStore` and a real
 * `MemoryRateLimiter`. Nothing is stubbed except the mail transport, which is
 * the one thing that cannot exist in a test — and even that is a genuine
 * implementation of the shipped port rather than a mock, so a message that
 * failed to carry a code fails here.
 *
 * The census store sits underneath, so a case can assert that a refused
 * verification created **no account, no identity and no device** — an absence
 * a per-account lookup cannot witness.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  createLogger,
  FixedClock,
  isDeliverableEmail,
  isOtpShape,
  MemoryOtpChallengeStore,
  MemoryRateLimiter,
  newOtpCode,
  otpMatches,
  OTP_DIGITS,
  OTP_LIMITS,
  OTP_SPACE,
  OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  RecordingLogSink,
  type EmailAuthService,
  type EmailStartOutcome,
  type EmailVerifyOutcome,
} from '../../server/index';
import { censusStore, type CensusStore } from '../fixtures/census-store';
import { RecordingEmailDelivery } from '../fixtures/recording-email-delivery';

const SOURCE = '203.0.113.9';
const ADDRESS = 'Person@Example.test';
const CANONICAL = 'Person@example.test';

interface Harness {
  readonly service: EmailAuthService;
  readonly store: CensusStore;
  readonly mail: RecordingEmailDelivery;
  readonly clock: FixedClock;
  readonly logs: RecordingLogSink;
  readonly backend: ReturnType<typeof createIdentityBackend>;
}

function harness(overrides: { readonly ttlMs?: number } = {}): Harness {
  const clock = new FixedClock(1_700_000_000_000);
  const store = censusStore();
  const mail = new RecordingEmailDelivery();
  const logs = new RecordingLogSink();
  const backend = createIdentityBackend({
    store: store.store,
    clock,
    log: createLogger(logs.sink),
    email: { delivery: mail, ...(overrides.ttlMs === undefined ? {} : { ttlMs: overrides.ttlMs }) },
  });
  if (backend.email === null) throw new Error('Email sign-in was not wired.');
  return { service: backend.email, store, mail, clock, logs, backend };
}

/** Starts a flow and returns the challenge id, failing loudly if it did not start. */
async function started(h: Harness, email = ADDRESS, source = SOURCE): Promise<string> {
  const result = await h.service.start({ email, source });
  if (!result.ok || result.value.kind !== 'sent') {
    throw new Error(`start did not send: ${JSON.stringify(result)}`);
  }
  return result.value.challengeId;
}

function startOutcome(result: { ok: boolean; value?: unknown }): EmailStartOutcome {
  if (!result.ok) throw new Error('start failed');
  return result.value as EmailStartOutcome;
}

function verifyOutcome(result: { ok: boolean; value?: unknown }): EmailVerifyOutcome {
  if (!result.ok) throw new Error('verify failed');
  return result.value as EmailVerifyOutcome;
}

describe('TEST-SECURITY-062 — the code itself', () => {
  it('01 — a code is exactly six decimal digits', () => {
    for (let index = 0; index < 500; index += 1) {
      const code = newOtpCode();
      expect(code).toHaveLength(OTP_DIGITS);
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(isOtpShape(code)).toBe(true);
    }
  });

  it('02 — codes are drawn from the whole space, not a prefix of it', () => {
    // A generator that used a truncated draw, a fixed seed, or a modulo of a
    // small range would collapse the range or repeat. 2000 draws over 10^6
    // should collide only rarely, and should touch every leading digit.
    const codes = new Set<string>();
    const leading = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      const code = newOtpCode();
      codes.add(code);
      leading.add(code[0] ?? '');
    }
    expect(codes.size).toBeGreaterThan(1990);
    expect(leading.size).toBe(10);
    expect(OTP_SPACE).toBe(1_000_000);
  });

  it('03 — leading zeros survive, so a tenth of the space is not lost', () => {
    // A generator that formatted a number without padding would silently mint
    // five-digit codes, and `isOtpShape` would then reject its own output.
    let sawLeadingZero = false;
    for (let index = 0; index < 3000 && !sawLeadingZero; index += 1) {
      sawLeadingZero = newOtpCode().startsWith('0');
    }
    expect(sawLeadingZero).toBe(true);
  });

  it('04 — comparison refuses anything that is not a code, in either position', () => {
    expect(otpMatches('123456', '123456')).toBe(true);
    expect(otpMatches('123456', '123457')).toBe(false);
    for (const bad of ['', '12345', '1234567', '12345a', ' 123456', '123456 ', '1e5']) {
      expect(otpMatches(bad, '123456'), bad).toBe(false);
      expect(otpMatches('123456', bad), bad).toBe(false);
    }
  });
});

describe('TEST-SECURITY-062 — the transient store', () => {
  it('05 — a store holds the code and never hands it back', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 5, capacity: 10 });
    await store.issue({
      id: 'otp_a',
      purpose: 'sign_in',
      abaUserId: null,
      email: CANONICAL,
      code: '111111',
      issuedAt: 0,
      expiresAt: 1000,
      attempts: 0,
    });

    const seen = await store.peek('otp_a');
    expect(seen).not.toBeNull();
    // The view type has no `code`, and the value does not carry one either.
    expect(JSON.stringify(seen)).not.toContain('111111');
    expect(Object.keys(seen ?? {})).not.toContain('code');
  });

  it('06 — issuing a new code invalidates every open one for that address', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 5, capacity: 10 });
    const base = {
      email: CANONICAL,
      purpose: 'sign_in' as const,
      abaUserId: null,
      issuedAt: 0,
      expiresAt: 1000,
      attempts: 0,
    };
    await store.issue({ ...base, id: 'otp_a', code: '111111' });
    await store.issue({ ...base, id: 'otp_b', code: '222222' });

    expect(await store.peek('otp_a')).toBeNull();
    // And the old code cannot be presented against the old challenge.
    expect((await store.attempt('otp_a', '111111', 10)).kind).toBe('unknown');
    expect((await store.attempt('otp_b', '222222', 10)).kind).toBe('verified');
  });

  it('07 — a code is single-use: the second presentation finds nothing', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 5, capacity: 10 });
    await store.issue({
      id: 'otp_a',
      purpose: 'sign_in',
      abaUserId: null,
      email: CANONICAL,
      code: '111111',
      issuedAt: 0,
      expiresAt: 1000,
      attempts: 0,
    });

    expect((await store.attempt('otp_a', '111111', 10)).kind).toBe('verified');
    expect((await store.attempt('otp_a', '111111', 10)).kind).toBe('unknown');
    expect(store.size()).toBe(0);
  });

  it('08 — concurrent presentation of one valid code succeeds at most once', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 5, capacity: 10 });
    await store.issue({
      id: 'otp_a',
      purpose: 'sign_in',
      abaUserId: null,
      email: CANONICAL,
      code: '111111',
      issuedAt: 0,
      expiresAt: 1000,
      attempts: 0,
    });

    // Twenty at once. The critical section is synchronous, so exactly one of
    // these can observe the challenge present.
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => store.attempt('otp_a', '111111', 10)),
    );
    expect(outcomes.filter((outcome) => outcome.kind === 'verified')).toHaveLength(1);
  });

  it('09 — attempts are bounded, and the exhausted challenge is gone', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 3, capacity: 10 });
    await store.issue({
      id: 'otp_a',
      purpose: 'sign_in',
      abaUserId: null,
      email: CANONICAL,
      code: '111111',
      issuedAt: 0,
      expiresAt: 10_000,
      attempts: 0,
    });

    expect(await store.attempt('otp_a', '000000', 1)).toEqual({
      kind: 'mismatch',
      remainingAttempts: 2,
    });
    expect(await store.attempt('otp_a', '000000', 2)).toEqual({
      kind: 'mismatch',
      remainingAttempts: 1,
    });
    expect((await store.attempt('otp_a', '000000', 3)).kind).toBe('exhausted');
    // And the right code no longer works, because there is nothing left.
    expect((await store.attempt('otp_a', '111111', 4)).kind).toBe('unknown');
  });

  it('09b — a challenge issued already at the cap gets no attempts at all', async () => {
    // `issue` takes `attempts` from its caller, and the service always passes
    // zero — so the guard at the top of `attempt` is unreachable *through the
    // service*. It is not unreachable at this interface, which is where the
    // store's contract lives, and a negative control that removed the guard
    // left every other case passing. Rather than claim the coverage, this
    // case exercises the guard directly: a challenge handed in already spent
    // gets no further tries, right code or not.
    const store = new MemoryOtpChallengeStore({ maxAttempts: 3, capacity: 10 });
    await store.issue({
      id: 'otp_spent',
      purpose: 'sign_in',
      abaUserId: null,
      email: CANONICAL,
      code: '111111',
      issuedAt: 0,
      expiresAt: 10_000,
      attempts: 3,
    });

    expect((await store.attempt('otp_spent', '111111', 1)).kind).toBe('exhausted');
    expect(store.size()).toBe(0);
  });

  it('10 — an expired challenge is refused and removed, not merely reported', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 5, capacity: 10 });
    await store.issue({
      id: 'otp_a',
      purpose: 'sign_in',
      abaUserId: null,
      email: CANONICAL,
      code: '111111',
      issuedAt: 0,
      expiresAt: 1000,
      attempts: 0,
    });

    expect((await store.attempt('otp_a', '111111', 1000)).kind).toBe('expired');
    expect(store.size()).toBe(0);
  });

  it('11 — the store refuses at capacity rather than evicting somebody else', async () => {
    const store = new MemoryOtpChallengeStore({ maxAttempts: 5, capacity: 2 });
    const base = {
      purpose: 'sign_in' as const,
      abaUserId: null,
      issuedAt: 0,
      expiresAt: 10_000,
      attempts: 0,
      code: '111111',
    };
    expect((await store.issue({ ...base, id: 'otp_a', email: 'a@x.test' })).kind).toBe('issued');
    expect((await store.issue({ ...base, id: 'otp_b', email: 'b@x.test' })).kind).toBe('issued');

    // A third caller is refused, and — the property that matters — the two
    // existing challenges are untouched. Eviction here would let anybody
    // flush a victim's in-flight sign-in by starting their own.
    expect((await store.issue({ ...base, id: 'otp_c', email: 'c@x.test' })).kind).toBe(
      'at_capacity',
    );
    expect(await store.peek('otp_a')).not.toBeNull();
    expect(await store.peek('otp_b')).not.toBeNull();
  });
});

describe('TEST-SECURITY-062 — the flow', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('12 — a code is delivered, and never returned by the API', async () => {
    const result = await h.service.start({ email: ADDRESS, source: SOURCE });
    const outcome = startOutcome(result);
    expect(outcome.kind).toBe('sent');

    const code = h.mail.lastCode();
    expect(isOtpShape(code)).toBe(true);
    // The response body, serialised in full. The code is not anywhere in it.
    expect(JSON.stringify(outcome)).not.toContain(code);
  });

  it('13 — the address is canonicalised before it is used, and only as ratified', async () => {
    await h.service.start({ email: '  Person@EXAMPLE.test  ', source: SOURCE });
    // Domain folded, local part byte for byte, surrounding whitespace gone.
    expect(h.mail.last()?.to).toBe(CANONICAL);
  });

  it('14 — no dot stripping, no plus-tag removal, no provider rewriting', async () => {
    for (const address of ['a.b.c@gmail.test', 'user+tag@gmail.test', 'UPPER@gmail.test']) {
      h.mail.clear();
      h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
      await h.service.start({ email: address, source: SOURCE });
      const at = address.lastIndexOf('@');
      const expected = `${address.slice(0, at)}${address.slice(at).toLowerCase()}`;
      expect(h.mail.last()?.to, address).toBe(expected);
    }
  });

  it('15 — a verified code establishes exactly one account, identity and session', async () => {
    const id = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );

    expect(outcome.kind).toBe('verified');
    expect(h.store.census()).toEqual({ accounts: 1, identities: 1, devices: 0 });
  });

  it('16 — the identity is kind=email with a null subject and a verified address', async () => {
    const id = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );
    if (outcome.kind !== 'verified') throw new Error('not verified');

    const rows = await h.backend.store.listIdentities(outcome.session.abaUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('email');
    // Subjectless, which is what puts it on the `(kind, email)` unique branch.
    expect(rows[0]?.subject).toBeNull();
    expect(rows[0]?.email).toBe(CANONICAL);
    expect(rows[0]?.email_verified).toBe(true);
  });

  it('17 — signing in again returns to the same account rather than making another', async () => {
    const first = await started(h);
    const a = verifyOutcome(
      await h.service.verify({ challengeId: first, code: h.mail.lastCode(), source: SOURCE }),
    );

    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    const second = await started(h);
    const b = verifyOutcome(
      await h.service.verify({ challengeId: second, code: h.mail.lastCode(), source: SOURCE }),
    );

    if (a.kind !== 'verified' || b.kind !== 'verified') throw new Error('not verified');
    expect(b.session.abaUserId).toBe(a.session.abaUserId);
    expect(h.store.census().accounts).toBe(1);
    // The first sign-in created the account; the second returned to it.
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
  });

  it('18 — a wrong code creates nothing at all', async () => {
    const id = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code: '000000', source: SOURCE }),
    );

    expect(outcome.kind).toBe('refused');
    // Not "the account has no session" — no account, no identity, no device.
    expect(h.store.census()).toEqual({ accounts: 0, identities: 0, devices: 0 });
  });

  it('19 — a spent code cannot establish a second session', async () => {
    const id = await started(h);
    const code = h.mail.lastCode();
    expect(
      verifyOutcome(await h.service.verify({ challengeId: id, code, source: SOURCE })).kind,
    ).toBe('verified');

    const replay = verifyOutcome(await h.service.verify({ challengeId: id, code, source: SOURCE }));
    expect(replay.kind).toBe('refused');
    expect(h.store.census().accounts).toBe(1);
  });

  it('20 — an expired code is refused on the boundary, not one tick after', async () => {
    const id = await started(h);
    const code = h.mail.lastCode();

    // One millisecond inside the window still works; the TTL exactly reached
    // does not. `expiresAt <= now` is the rule, asserted at both edges.
    h.clock.advance(OTP_TTL_MS - 1);
    const early = harness();
    const earlyId = await started(early);
    const earlyCode = early.mail.lastCode();
    early.clock.advance(OTP_TTL_MS - 1);
    expect(
      verifyOutcome(
        await early.service.verify({ challengeId: earlyId, code: earlyCode, source: SOURCE }),
      ).kind,
    ).toBe('verified');

    h.clock.advance(1);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code, source: SOURCE }),
    );
    expect(outcome.kind === 'refused' && outcome.reason).toBe('EXPIRED');
  });

  it('21 — five wrong codes exhaust the challenge and the right one then fails', async () => {
    const id = await started(h);
    const code = h.mail.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt < MAX_OTP_ATTEMPTS; attempt += 1) {
      const outcome = verifyOutcome(
        await h.service.verify({ challengeId: id, code: wrong, source: SOURCE }),
      );
      expect(outcome.kind === 'refused' && outcome.reason, `attempt ${attempt}`).toBe(
        'INVALID_CODE',
      );
    }
    const last = verifyOutcome(
      await h.service.verify({ challengeId: id, code: wrong, source: SOURCE }),
    );
    expect(last.kind === 'refused' && last.reason).toBe('ATTEMPTS_EXHAUSTED');

    const afterwards = verifyOutcome(
      await h.service.verify({ challengeId: id, code, source: SOURCE }),
    );
    expect(afterwards.kind).toBe('refused');
    expect(h.store.census().accounts).toBe(0);
  });

  it('22 — a malformed code spends an attempt and can never match', async () => {
    const id = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code: 'abcdef', source: SOURCE }),
    );
    expect(outcome.kind === 'refused' && outcome.remainingAttempts).toBe(MAX_OTP_ATTEMPTS - 1);
  });

  it('23 — a resend invalidates the previous code', async () => {
    const first = await started(h);
    const firstCode = h.mail.lastCode();

    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    const second = await started(h);
    const secondCode = h.mail.lastCode();
    expect(secondCode).not.toBe(firstCode);

    // The old challenge is gone, so neither the old id nor the old code works.
    expect(
      verifyOutcome(await h.service.verify({ challengeId: first, code: firstCode, source: SOURCE }))
        .kind,
    ).toBe('refused');
    expect(
      verifyOutcome(
        await h.service.verify({ challengeId: second, code: secondCode, source: SOURCE }),
      ).kind,
    ).toBe('verified');
  });

  it('24 — a code for one address cannot be presented against another challenge', async () => {
    const mine = await started(h, 'mine@example.test');
    const myCode = h.mail.lastCode();
    const theirs = await started(h, 'theirs@example.test');
    const theirCode = h.mail.lastCode();
    expect(myCode).not.toBe(theirCode);

    const crossed = verifyOutcome(
      await h.service.verify({ challengeId: theirs, code: myCode, source: SOURCE }),
    );
    // A mismatch, not a success — the code is bound to its own challenge and
    // the challenge is what carries the address.
    expect(crossed.kind === 'refused' && crossed.reason).toBe('INVALID_CODE');
    expect(
      verifyOutcome(await h.service.verify({ challengeId: mine, code: myCode, source: SOURCE }))
        .kind,
    ).toBe('verified');
  });

  it('25 — delivery failure leaves no usable challenge behind', async () => {
    h.mail.failing = true;
    const result = startOutcome(await h.service.start({ email: ADDRESS, source: SOURCE }));

    expect(result.kind === 'refused' && result.reason).toBe('DELIVERY_FAILED');
    // Nothing was created and no challenge id was handed out, so there is
    // nothing for anyone to guess against.
    expect(h.store.census()).toEqual({ accounts: 0, identities: 0, devices: 0 });
  });

  it('26 — a device is registered only through a session, and only when named', async () => {
    const withoutDevice = await started(h);
    verifyOutcome(
      await h.service.verify({
        challengeId: withoutDevice,
        code: h.mail.lastCode(),
        source: SOURCE,
      }),
    );
    expect(h.store.census().devices).toBe(0);

    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    const withDevice = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({
        challengeId: withDevice,
        code: h.mail.lastCode(),
        source: SOURCE,
        deviceId: 'dev_11111111-2222-3333-4444-555555555555',
      }),
    );
    expect(outcome.kind === 'verified' && outcome.deviceRegistered).toBe(true);
    expect(h.store.census().devices).toBe(1);
  });

  it('27 — a malformed device id does not fail the sign-in and registers nothing', async () => {
    const id = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({
        challengeId: id,
        code: h.mail.lastCode(),
        source: SOURCE,
        deviceId: 'not-a-device-id',
      }),
    );
    expect(outcome.kind === 'verified' && outcome.deviceRegistered).toBe(false);
    expect(h.store.census().devices).toBe(0);
  });
});

describe('TEST-SECURITY-062 — enumeration and identity authority', () => {
  it('28 — start performs no account lookup, so it cannot depend on one', async () => {
    const h = harness();
    // A real account for this address, established by a completed sign-in.
    const first = await started(h);
    await h.service.verify({ challengeId: first, code: h.mail.lastCode(), source: SOURCE });

    // Now watch the store while a second start runs. The property is stronger
    // than "the responses look alike": the lookup does not happen.
    const reads: string[] = [];
    const watched = new Proxy(h.backend.store, {
      get(target, property, receiver) {
        if (typeof property === 'string' && property.startsWith('find')) reads.push(property);
        if (typeof property === 'string' && property === 'getUser') reads.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const watchedBackend = createIdentityBackend({
      store: watched,
      clock: h.clock,
      email: { delivery: h.mail },
    });
    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    await watchedBackend.email?.start({ email: ADDRESS, source: SOURCE });
    expect(reads).toEqual([]);
  });

  it('29 — a known and an unknown address produce structurally identical answers', async () => {
    const h = harness();
    const first = await started(h, 'known@example.test');
    await h.service.verify({ challengeId: first, code: h.mail.lastCode(), source: SOURCE });

    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    const known = startOutcome(
      await h.service.start({ email: 'known@example.test', source: SOURCE }),
    );
    const unknown = startOutcome(
      await h.service.start({ email: 'stranger@example.test', source: SOURCE }),
    );

    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect(known.kind).toBe('sent');
    expect(unknown.kind).toBe('sent');
  });

  it('30 — an address on a Google identity does not merge, and does not unlock it', async () => {
    const h = harness();
    // A Google identity carrying this address, attached to its own account.
    const account = await h.backend.accounts.createAccount();
    const session = await h.backend.sessions.createSession({
      abaUserId: account.id,
      authIdentityId: null,
    });
    if (!session.ok) throw new Error('no session');
    const principal = await h.backend.sessions.verify(session.value.sessionId);
    if (!principal.ok) throw new Error('no principal');
    await h.backend.identities.attachIdentity(principal.value, {
      kind: 'google',
      subject: 'google-subject-1',
      email: CANONICAL,
      emailVerified: true,
    });

    const id = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );

    // **This is the ratified behaviour, and it is deliberately not a merge.**
    // A Google `sub` proves control of a Google account; a code proves
    // control of a mailbox. They are different proofs of different things,
    // and a shared address string is not a proof of either (AUTH-27). So the
    // email sign-in succeeds — and lands somewhere else.
    //
    // The alternative was tried in an earlier draft of this case, which
    // expected a refusal. That expectation was the one wrong thing here: a
    // refusal would make an address on somebody's Google account block email
    // sign-in for whoever actually holds the mailbox, and an automatic merge
    // would hand the Google account to them instead. Splitting one person
    // into two accounts is the visible, repairable failure; merging two
    // people into one is neither.
    expect(outcome.kind).toBe('verified');
    if (outcome.kind !== 'verified') throw new Error('not verified');
    expect(outcome.session.abaUserId).not.toBe(account.id);

    // Two accounts, two identities, and the Google row is exactly as it was.
    expect(h.store.census().accounts).toBe(2);
    expect(h.store.census().identities).toBe(2);
    const google = await h.backend.store.findIdentityBySubject('google', 'google-subject-1');
    expect(google?.aba_user_id).toBe(account.id);
    expect(google?.email).toBe(CANONICAL);

    // And the email identity did not acquire the Google subject on the way.
    const mine = await h.backend.store.listIdentities(outcome.session.abaUserId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.kind).toBe('email');
    expect(mine[0]?.subject).toBeNull();
  });

  it('30b — one verified address yields at most one email identity', async () => {
    const h = harness();
    const id = await started(h);
    const first = verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );
    if (first.kind !== 'verified') throw new Error('not verified');

    // A second account tries to attach the same address as an email identity.
    // The subjectless branch of `auth_identity_email_key` is what stops it,
    // and it stops it at the write rather than at a check that could race.
    const other = await h.backend.accounts.createAccount();
    const session = await h.backend.sessions.createSession({
      abaUserId: other.id,
      authIdentityId: null,
    });
    if (!session.ok) throw new Error('no session');
    const principal = await h.backend.sessions.verify(session.value.sessionId);
    if (!principal.ok) throw new Error('no principal');

    const attached = await h.backend.identities.attachIdentity(principal.value, {
      kind: 'email',
      subject: null,
      email: CANONICAL,
      emailVerified: true,
    });
    expect(attached.ok).toBe(false);
    expect(!attached.ok && attached.error.code).toBe('IDENTITY_IN_USE');
    expect(h.store.census().identities).toBe(1);
  });

  it('31 — a deleted account cannot be signed back into, and says nothing extra', async () => {
    const h = harness();
    const id = await started(h);
    const first = verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );
    if (first.kind !== 'verified') throw new Error('not verified');

    const principal = await h.backend.sessions.verify(first.session.sessionId);
    if (!principal.ok) throw new Error('no principal');
    await h.backend.accounts.markAccountDeleted(principal.value);

    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    const second = await started(h);
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: second, code: h.mail.lastCode(), source: SOURCE }),
    );
    // Collapsed into the same refusal a taken address gets: an answer, and
    // not one that distinguishes "deleted" from "in use".
    expect(outcome.kind === 'refused' && outcome.reason).toBe('UNAVAILABLE');
  });

  it('32 — the address a session is issued for comes from the challenge, not the caller', async () => {
    const h = harness();
    const id = await started(h, 'victim@example.test');
    const outcome = verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );
    if (outcome.kind !== 'verified') throw new Error('not verified');

    // Two halves, and this case proves one of them. That `verify` has no
    // parameter in which an address could be offered is structural and is
    // asserted where it can be — on the route, in
    // `server-auth-mutations.test.ts` case 03b, which fails when an `email`
    // field is added to the verify handler. This asserts the other half: the
    // address a session is issued for is the one the challenge carries.
    expect(outcome.email).toBe('victim@example.test');
    const rows = await h.backend.store.listIdentities(outcome.session.abaUserId);
    expect(rows[0]?.email).toBe('victim@example.test');
  });
});

describe('TEST-SECURITY-062 — rate limiting', () => {
  it('33 — codes to one address are capped, and the cap is not per source', async () => {
    const h = harness();
    let sent = 0;
    for (let index = 0; index < OTP_LIMITS.startPerEmail.limit + 3; index += 1) {
      // A different source each time, so only the per-address limit can stop
      // this. Cooldown advanced past so it is not what refuses.
      const outcome = startOutcome(
        await h.service.start({ email: ADDRESS, source: `source-${index}` }),
      );
      if (outcome.kind === 'sent') sent += 1;
      h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    }
    expect(sent).toBe(OTP_LIMITS.startPerEmail.limit);
    expect(h.mail.to(CANONICAL)).toHaveLength(OTP_LIMITS.startPerEmail.limit);
  });

  it('34 — one caller cannot start unbounded sign-ins across many addresses', async () => {
    const h = harness();
    let sent = 0;
    for (let index = 0; index < OTP_LIMITS.startPerSource.limit + 5; index += 1) {
      const outcome = startOutcome(
        await h.service.start({ email: `person${index}@example.test`, source: SOURCE }),
      );
      if (outcome.kind === 'sent') sent += 1;
    }
    expect(sent).toBe(OTP_LIMITS.startPerSource.limit);
  });

  it('35 — a resend cooldown stops a retry loop spending the whole allowance', async () => {
    const h = harness();
    expect(startOutcome(await h.service.start({ email: ADDRESS, source: SOURCE })).kind).toBe(
      'sent',
    );

    const immediate = startOutcome(await h.service.start({ email: ADDRESS, source: SOURCE }));
    expect(immediate.kind === 'refused' && immediate.reason).toBe('RATE_LIMITED');
    expect(immediate.kind === 'refused' && immediate.retryAfterMs).toBeGreaterThan(0);

    h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    expect(startOutcome(await h.service.start({ email: ADDRESS, source: SOURCE })).kind).toBe(
      'sent',
    );
  });

  it('36 — verification attempts are capped per caller, across challenges', async () => {
    const h = harness();
    const id = await started(h);
    let refusedByLimit = 0;
    for (let index = 0; index < OTP_LIMITS.verifyPerSource.limit + 5; index += 1) {
      const outcome = verifyOutcome(
        await h.service.verify({ challengeId: id, code: '000000', source: SOURCE }),
      );
      if (outcome.kind === 'refused' && outcome.reason === 'RATE_LIMITED') refusedByLimit += 1;
    }
    expect(refusedByLimit).toBe(5);
  });

  it('37 — a limiter cannot be cleared by flooding it with other keys', () => {
    const clock = new FixedClock(0);
    // **Capacity well above the flood on purpose.** An earlier version of this
    // case used a capacity of 8, and under the very mutation it exists to
    // catch it still passed — not because the victim's counter survived, but
    // because the limiter saturated and refused everything. The assertion was
    // true for the wrong reason, which is a test that reports coverage it
    // does not have. With room to spare, the only thing that can refuse the
    // victim is the victim's own counter.
    const limiter = new MemoryRateLimiter({ clock, capacity: 10_000 });
    const victim = { limit: 2, windowMs: 15 * 60 * 1000 };
    const noisy = { limit: 100, windowMs: 1000 };

    expect(limiter.consume('start', 'victim', victim).allowed).toBe(true);
    expect(limiter.consume('start', 'victim', victim).allowed).toBe(true);
    expect(limiter.consume('start', 'victim', victim).allowed).toBe(false);

    // Flood a short-windowed bucket, repeatedly. An earlier implementation
    // pruned every counter older than the *current* rule's window, so this
    // swept away the victim's fifteen-minute counter.
    for (let round = 0; round < 5; round += 1) {
      clock.advance(2000);
      for (let index = 0; index < 20; index += 1) {
        limiter.consume('noise', `key-${round}-${index}`, noisy);
      }
    }

    const after = limiter.consume('start', 'victim', victim);
    expect(after.allowed).toBe(false);
    // And refused by the rule, not by the key cap — which is the distinction
    // the earlier version could not make.
    expect(after.allowed === false && after.saturated).toBe(false);
  });

  it('38 — a full limiter refuses rather than admitting', () => {
    const clock = new FixedClock(0);
    const limiter = new MemoryRateLimiter({ clock, capacity: 3 });
    const rule = { limit: 5, windowMs: 60_000 };
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.consume('start', `key-${index}`, rule).allowed).toBe(true);
    }
    const outcome = limiter.consume('start', 'overflow', rule);
    expect(outcome.allowed).toBe(false);
    expect(outcome.allowed === false && outcome.saturated).toBe(true);
  });

  it('39 — a completed sign-in clears that address’s send budget, not the caller’s', async () => {
    const h = harness();
    const id = await started(h);
    verifyOutcome(
      await h.service.verify({ challengeId: id, code: h.mail.lastCode(), source: SOURCE }),
    );
    // The cooldown is cleared by success, so a person who signs in and
    // immediately needs another code is not made to wait.
    expect(startOutcome(await h.service.start({ email: ADDRESS, source: SOURCE })).kind).toBe(
      'sent',
    );
  });
});

describe('TEST-SECURITY-062 — what never leaves the process', () => {
  it('40 — the code is in no log record, at any level', async () => {
    const h = harness();
    const id = await started(h);
    const code = h.mail.lastCode();
    await h.service.verify({ challengeId: id, code: '000000', source: SOURCE });
    await h.service.verify({ challengeId: id, code, source: SOURCE });

    const written = h.logs.serialised();
    expect(written).not.toContain(code);
    // Nor the address, nor the caller. Only the domain is loggable.
    expect(written).not.toContain(CANONICAL);
    expect(written).not.toContain(SOURCE);
    expect(written).toContain('example.test');
  });

  it('41 — no response from either step carries the code', async () => {
    const h = harness();
    const start = startOutcome(await h.service.start({ email: ADDRESS, source: SOURCE }));
    const code = h.mail.lastCode();
    const verify = verifyOutcome(
      await h.service.verify({
        challengeId: (start as { challengeId: string }).challengeId,
        code,
        source: SOURCE,
      }),
    );
    expect(JSON.stringify(start)).not.toContain(code);
    expect(JSON.stringify(verify)).not.toContain(code);
  });

  it('42 — nothing in the durable store contains the code or the challenge', async () => {
    const h = harness();
    const id = await started(h);
    const code = h.mail.lastCode();
    await h.service.verify({ challengeId: id, code, source: SOURCE });

    // Every row the backend holds, serialised. A challenge row would show up
    // here; there is none, because there is no table.
    const accountId = h.store.accountIds()[0] ?? '';
    const rows = JSON.stringify({
      identities: await h.backend.store.listIdentities(accountId),
      sessions: await h.backend.store.listSessions(accountId),
      devices: await h.backend.store.listDevices(accountId),
      user: await h.backend.store.getUser(accountId),
    });
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(id);
  });

  it('43 — a sweep removes expired challenges', async () => {
    const h = harness();
    await started(h);
    h.clock.advance(OTP_TTL_MS + 1);
    expect(await h.service.sweep()).toBe(1);
  });
});

describe('TEST-SECURITY-062 — address shape and the open Unicode question', () => {
  it('44 — obviously undeliverable addresses are refused before anything is sent', () => {
    for (const bad of [
      '',
      'nobody',
      '@example.test',
      'person@',
      'person@localhost',
      'person@.example.test',
      'person@example.test.',
      'person@exam..ple.test',
      'a b@example.test',
      `${'x'.repeat(250)}@example.test`,
    ]) {
      expect(isDeliverableEmail(bad), bad).toBe(false);
    }
    for (const good of ['a@b.test', 'a.b+c@d.example.test', 'UPPER@lower.test']) {
      expect(isDeliverableEmail(good), good).toBe(true);
    }
  });

  it('45 — a non-ASCII address is refused rather than silently normalised', async () => {
    const h = harness();
    // Unicode normalisation and IDN handling are open questions this phase
    // was told not to settle. Accepting the bytes would settle them by
    // default, and any later rule would then merge or split real accounts.
    // Refusing is reversible; merging is not.
    for (const address of [
      'josé@example.test',
      'person@exämple.test',
      'person@xn--mple-6qa.test',
    ]) {
      const outcome = startOutcome(await h.service.start({ email: address, source: SOURCE }));
      if (address.startsWith('person@xn--')) {
        // Punycode is ASCII, so it is accepted as the literal domain it is.
        // That is not a decision that punycode and Unicode are the same
        // domain — nothing here maps between them.
        expect(outcome.kind, address).toBe('sent');
      } else {
        expect(outcome.kind === 'refused' && outcome.reason, address).toBe('INVALID_EMAIL');
      }
      h.clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    }
    expect(h.mail.sent.every((message) => /^[\x21-\x7e]+$/.test(message.to))).toBe(true);
  });

  it('46 — an address the service refuses is never handed to the mail transport', async () => {
    const h = harness();
    await h.service.start({ email: 'nobody', source: SOURCE });
    await h.service.start({ email: 'a b@example.test', source: SOURCE });
    expect(h.mail.sent).toHaveLength(0);
  });
});

describe('TEST-SECURITY-062 — the unconfigured build', () => {
  it('47 — with no mail transport there is no email service at all', () => {
    const backend = createIdentityBackend({ store: censusStore().store, clock: new FixedClock(0) });
    expect(backend.email).toBeNull();

    // And a transport that reports itself unconfigured is the same as none.
    const half = createIdentityBackend({
      store: censusStore().store,
      clock: new FixedClock(0),
      email: { delivery: new RecordingEmailDelivery(false) },
    });
    expect(half.email).toBeNull();
  });
});

describe('TEST-SECURITY-062 — the single-process limitation, demonstrated', () => {
  /**
   * These cases **demonstrate a limitation rather than a guarantee**, the same
   * way `k1-boundary.test.ts` case 12 demonstrates that rollback is accepted.
   * A limitation that is only described is a limitation nobody has checked,
   * and the first thing a second server process would do is break three
   * properties the flow otherwise has.
   *
   * If any of these starts failing, the challenge store or the limiter has
   * been made cross-process and `EMAIL_OTP_AUTHENTICATION.md` §5 must be
   * rewritten — that is what they are here to catch.
   *
   * Nothing here argues for building shared infrastructure. It records, in a
   * form that cannot rot, exactly which properties are single-process-only.
   */
  function twoInstances(): {
    readonly a: ReturnType<typeof createIdentityBackend>;
    readonly b: ReturnType<typeof createIdentityBackend>;
    readonly mailA: RecordingEmailDelivery;
    readonly mailB: RecordingEmailDelivery;
    readonly store: CensusStore;
    readonly clock: FixedClock;
  } {
    // One store — the shared database a two-process deployment would have.
    // Two backends — each with its own in-memory challenge store and limiter.
    const store = censusStore();
    const clock = new FixedClock(1_700_000_000_000);
    const mailA = new RecordingEmailDelivery();
    const mailB = new RecordingEmailDelivery();
    return {
      store,
      clock,
      mailA,
      mailB,
      a: createIdentityBackend({ store: store.store, clock, email: { delivery: mailA } }),
      b: createIdentityBackend({ store: store.store, clock, email: { delivery: mailB } }),
    };
  }

  it('48 — LIMITATION: two instances leave two simultaneously USABLE codes for one address', async () => {
    const { a, b, mailA, mailB } = twoInstances();
    const first = startOutcome(await a.email!.start({ email: ADDRESS, source: 'ip-1' }));
    const second = startOutcome(await b.email!.start({ email: ADDRESS, source: 'ip-1' }));
    if (first.kind !== 'sent' || second.kind !== 'sent') throw new Error('not sent');
    expect(mailA.lastCode()).not.toBe(mailB.lastCode());

    // **Usable, not merely issued.** An earlier version of this case asserted
    // only that both starts returned `sent` and that the codes differed — both
    // of which stay true when the challenge store is shared, so the case
    // passed under the very mutation it exists to catch. What actually
    // distinguishes one process from two is whether the *older* code still
    // works after the newer one is issued: with one store it is invalidated,
    // with two it is not.
    const older = verifyOutcome(
      await a.email!.verify({
        challengeId: first.challengeId,
        code: mailA.lastCode(),
        source: 'ip-1',
      }),
    );
    expect(older.kind).toBe('verified');
  });

  it('49 — LIMITATION: a code minted by one instance cannot be verified by the other', async () => {
    const { a, b, mailB } = twoInstances();
    const started = startOutcome(await b.email!.start({ email: ADDRESS, source: 'ip-1' }));
    if (started.kind !== 'sent') throw new Error('not sent');

    // Not a security hole — it fails closed — but it is a functional break,
    // and it is why the challenge store is a port.
    const crossed = verifyOutcome(
      await a.email!.verify({
        challengeId: started.challengeId,
        code: mailB.lastCode(),
        source: 'ip-1',
      }),
    );
    expect(crossed.kind).toBe('refused');
  });

  it('50 — LIMITATION: the per-address send budget multiplies by the instance count', async () => {
    const { a, b, clock } = twoInstances();
    let sent = 0;
    for (let round = 0; round < OTP_LIMITS.startPerEmail.limit + 1; round += 1) {
      for (const instance of [a, b]) {
        const outcome = startOutcome(
          await instance.email!.start({ email: ADDRESS, source: `src-${round}` }),
        );
        if (outcome.kind === 'sent') sent += 1;
      }
      clock.advance(OTP_LIMITS.resendCooldown.windowMs);
    }
    // Exactly twice the limit, with two instances. The anti-mail-bomb control
    // is therefore a per-process control.
    expect(sent).toBe(OTP_LIMITS.startPerEmail.limit * 2);
  });

  it('51 — LIMITATION: a cross-instance race leaves an account with no identity', async () => {
    const { a, b, mailA, mailB, store } = twoInstances();
    const first = startOutcome(await a.email!.start({ email: ADDRESS, source: 'ip-1' }));
    const second = startOutcome(await b.email!.start({ email: ADDRESS, source: 'ip-2' }));
    if (first.kind !== 'sent' || second.kind !== 'sent') throw new Error('not sent');

    const [one, two] = await Promise.all([
      a.email!.verify({ challengeId: first.challengeId, code: mailA.lastCode(), source: 'ip-1' }),
      b.email!.verify({ challengeId: second.challengeId, code: mailB.lastCode(), source: 'ip-2' }),
    ]);

    // The important half is safe: the uniqueness constraint holds, so the
    // address yields exactly one identity and the loser is refused. Nobody
    // signs in as somebody else.
    const outcomes = [verifyOutcome(one), verifyOutcome(two)];
    expect(outcomes.filter((outcome) => outcome.kind === 'verified')).toHaveLength(1);
    expect(store.census().identities).toBe(1);

    // The unsafe half, recorded rather than hidden: the loser created its
    // account *before* the attach that was refused, and nothing removes it.
    // `resolveAccount` has no rollback, and giving it one needs a delete the
    // `Store` port deliberately does not have — which is deletion semantics,
    // and those are deferred. So this is reported, not patched.
    expect(store.census().accounts).toBe(2);

    const orphans: string[] = [];
    for (const id of store.accountIds()) {
      if ((await store.store.listIdentities(id)).length === 0) orphans.push(id);
    }
    expect(orphans).toHaveLength(1);
  });

  it('52 — the same race within ONE instance creates nothing extra', async () => {
    // The control for 51. Single-process, the challenge store serialises
    // everything, and the orphan does not occur — which is what makes 51 a
    // statement about deployment shape rather than about this code.
    const h = harness();
    const started = startOutcome(await h.service.start({ email: ADDRESS, source: 'ip-1' }));
    if (started.kind !== 'sent') throw new Error('not sent');
    const code = h.mail.lastCode();

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        h.service.verify({ challengeId: started.challengeId, code, source: 'ip-1' }),
      ),
    );
    expect(outcomes.map(verifyOutcome).filter((o) => o.kind === 'verified')).toHaveLength(1);
    expect(h.store.census()).toEqual({ accounts: 1, identities: 1, devices: 0 });
  });
});
