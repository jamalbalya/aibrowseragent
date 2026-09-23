/**
 * TEST-SERVER-004 — devices: ownership, lifecycle and what a `deviceId` is
 * not.
 *
 * The lifecycle half is ordinary. The half worth writing is the negative
 * space: a `deviceId` authorises nothing, so presenting another account's
 * device must find nothing rather than find something and be refused — and
 * the two are distinguishable to an attacker unless the code is careful.
 *
 * The reinstall case is the one the architecture rests on. A reinstall mints
 * a new `deviceId` and produces a second row for one physical machine, and
 * that is correct rather than a duplicate to clean up: recognising "the same
 * machine" would need a fingerprint, which is the PII this design declines to
 * collect.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIdentityBackend,
  FixedClock,
  isDeviceId,
  type IdentityBackend,
  type Principal,
} from '@server/index';

const T0 = 1_800_000_000_000;
const DEVICE_A = 'dev_11111111-2222-4333-8444-555555555555';
const DEVICE_B = 'dev_66666666-7777-4888-8999-aaaaaaaaaaaa';

describe('devices', () => {
  let clock: FixedClock;
  let backend: IdentityBackend;

  beforeEach(() => {
    clock = new FixedClock(T0);
    backend = createIdentityBackend({ clock });
  });

  async function signedIn(): Promise<Principal> {
    const created = await backend.accounts.createAccount();
    const issued = await backend.sessions.createSession({
      abaUserId: created.id,
      authIdentityId: null,
    });
    if (!issued.ok) throw new Error('unreachable');
    const verified = await backend.sessions.verify(issued.value.sessionId);
    if (!verified.ok) throw new Error('unreachable');
    return verified.value;
  }

  describe('deviceId shape', () => {
    it('accepts a client-minted dev_ UUID', () => {
      expect(isDeviceId(DEVICE_A)).toBe(true);
    });

    it('rejects Chrome runtime handles presented as a device id', () => {
      // The values a mistake would actually reach for (AUTH-7).
      for (const candidate of [
        '42', // tabId
        'tab_42',
        'window_7',
        'group_3',
        'abcdefghijklmnopabcdefghijklmnop', // an extension id
        'dev_42',
        '',
        'dev_not-a-uuid',
      ]) {
        expect(isDeviceId(candidate), candidate).toBe(false);
      }
    });

    it('rejects non-strings', () => {
      for (const candidate of [null, undefined, 42, {}, []]) {
        expect(isDeviceId(candidate)).toBe(false);
      }
    });
  });

  describe('registration', () => {
    it('registers a device against the principal, not against a supplied user', async () => {
      const principal = await signedIn();
      const registered = await backend.devices.registerDevice(principal, DEVICE_A);
      expect(registered.ok && registered.value.aba_user_id).toBe(principal.abaUserId);
      expect(registered.ok && registered.value.retired_at).toBeNull();
    });

    it('refuses a malformed device id', async () => {
      const principal = await signedIn();
      const attempt = await backend.devices.registerDevice(principal, 'tab-42');
      expect(!attempt.ok && attempt.error.code).toBe('INVALID_ARGUMENT');
    });

    it('is idempotent, so a retried registration makes one row', async () => {
      const principal = await signedIn();
      await backend.devices.registerDevice(principal, DEVICE_A);
      clock.advance(5000);
      await backend.devices.registerDevice(principal, DEVICE_A);

      const devices = await backend.devices.listDevices(principal);
      expect(devices).toHaveLength(1);
      expect(devices[0]?.registered_at).toBe(T0);
      expect(devices[0]?.last_seen_at).toBe(T0 + 5000);
    });

    it('treats a reinstall as a new device and keeps the old row', async () => {
      const principal = await signedIn();
      await backend.devices.registerDevice(principal, DEVICE_A);
      clock.advance(86_400_000);
      await backend.devices.registerDevice(principal, DEVICE_B);

      const devices = await backend.devices.listDevices(principal);
      expect(devices).toHaveLength(2);
      expect(new Set(devices.map((row) => row.device_id))).toEqual(new Set([DEVICE_A, DEVICE_B]));
    });

    it('keeps a worker restart on the same device — the id is what decides', async () => {
      const principal = await signedIn();
      const first = await backend.devices.registerDevice(principal, DEVICE_A);
      // A worker restart re-runs registration with the id it read from disk.
      clock.advance(1000);
      const second = await backend.devices.registerDevice(principal, DEVICE_A);

      if (!first.ok || !second.ok) throw new Error('unreachable');
      expect(second.value.registered_at).toBe(first.value.registered_at);
      expect(await backend.devices.listDevices(principal)).toHaveLength(1);
    });

    it('lets two accounts hold the same device id as separate rows', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      await backend.devices.registerDevice(alice, DEVICE_A);
      await backend.devices.registerDevice(bob, DEVICE_A);

      expect(await backend.devices.listDevices(alice)).toHaveLength(1);
      expect(await backend.devices.listDevices(bob)).toHaveLength(1);
      const hers = await backend.store.getDevice(alice.abaUserId, DEVICE_A);
      const his = await backend.store.getDevice(bob.abaUserId, DEVICE_A);
      expect(hers?.aba_user_id).not.toBe(his?.aba_user_id);
    });
  });

  describe('ownership', () => {
    it('reports another account’s device as not found', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      await backend.devices.registerDevice(alice, DEVICE_A);

      const attempt = await backend.devices.getDevice(bob, DEVICE_A);
      expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
    });

    it('refuses to retire another account’s device, and does not retire it', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      await backend.devices.registerDevice(alice, DEVICE_A);

      const attempt = await backend.devices.retireDevice(bob, DEVICE_A);
      expect(!attempt.ok && attempt.error.code).toBe('NOT_FOUND');
      expect((await backend.store.getDevice(alice.abaUserId, DEVICE_A))?.retired_at).toBeNull();
    });

    it('lists only the principal’s own devices', async () => {
      const alice = await signedIn();
      const bob = await signedIn();
      await backend.devices.registerDevice(alice, DEVICE_A);
      await backend.devices.registerDevice(bob, DEVICE_B);

      expect((await backend.devices.listDevices(alice)).map((row) => row.device_id)).toEqual([
        DEVICE_A,
      ]);
    });
  });

  describe('lifecycle', () => {
    it('retires and reactivates, restoring the existing row', async () => {
      const principal = await signedIn();
      await backend.devices.registerDevice(principal, DEVICE_A);

      clock.advance(1000);
      const retired = await backend.devices.retireDevice(principal, DEVICE_A);
      expect(retired.ok && retired.value.retired_at).toBe(T0 + 1000);

      clock.advance(1000);
      const back = await backend.devices.reactivateDevice(principal, DEVICE_A);
      expect(back.ok && back.value.retired_at).toBeNull();
      expect(back.ok && back.value.reactivated_at).toBe(T0 + 2000);
      // The original registration survives: reactivation is not re-registration.
      expect(back.ok && back.value.registered_at).toBe(T0);
    });

    it('is idempotent in both directions', async () => {
      const principal = await signedIn();
      await backend.devices.registerDevice(principal, DEVICE_A);

      await backend.devices.retireDevice(principal, DEVICE_A);
      const again = await backend.devices.retireDevice(principal, DEVICE_A);
      expect(again.ok && again.value.retired_at).toBe(T0);

      await backend.devices.reactivateDevice(principal, DEVICE_A);
      const backAgain = await backend.devices.reactivateDevice(principal, DEVICE_A);
      expect(backAgain.ok && backAgain.value.retired_at).toBeNull();
    });

    it('refuses activity from a retired device until it is reactivated', async () => {
      const principal = await signedIn();
      await backend.devices.registerDevice(principal, DEVICE_A);
      await backend.devices.retireDevice(principal, DEVICE_A);

      const touched = await backend.devices.touchDevice(principal, DEVICE_A);
      expect(!touched.ok && touched.error.code).toBe('DEVICE_RETIRED');

      await backend.devices.reactivateDevice(principal, DEVICE_A);
      expect((await backend.devices.touchDevice(principal, DEVICE_A)).ok).toBe(true);
    });

    it('revokes no session when a device is retired', async () => {
      const principal = await signedIn();
      await backend.devices.registerDevice(principal, DEVICE_A);
      await backend.devices.retireDevice(principal, DEVICE_A);

      // Retirement is bookkeeping. A device is not an authenticator, so
      // retiring one cannot be a way to end somebody's session.
      expect((await backend.sessions.verify(principal.sessionId)).ok).toBe(true);
    });

    it('reports an unregistered device as not found', async () => {
      const principal = await signedIn();
      expect(!(await backend.devices.retireDevice(principal, DEVICE_A)).ok).toBe(true);
      expect(!(await backend.devices.reactivateDevice(principal, DEVICE_A)).ok).toBe(true);
    });
  });
});
