/**
 * Devices: registration, retirement and reactivation.
 *
 * A device row is **provenance, not authorization** (AUTH-20). Nothing here
 * grants anything on the strength of a `deviceId`: every method takes a
 * `Principal`, and the device is looked up *within* that principal's account.
 * Presenting another account's `deviceId` therefore finds nothing, which is
 * reported as `NOT_FOUND` — the same answer as a device that does not exist.
 *
 * The `deviceId` is minted by the client and validated here only for shape.
 * That is enough, because it authorises nothing; what the shape check buys is
 * that a tab id, a window id or an extension id cannot be presented as one
 * (AUTH-7).
 */
import { fail, ok, type Result } from '../domain/errors';
import { isDeviceId } from '../domain/ids';
import type { Clock } from '../domain/clock';
import type { DeviceRow, Store } from '../db/store';
import type { Principal } from '../domain/authorization';
import type { ServerLogger } from '../logging';

export interface DeviceServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly log: ServerLogger;
}

export class DeviceService {
  constructor(private readonly options: DeviceServiceOptions) {}

  /**
   * Refuses every device operation on a deleted account.
   *
   * Defence in depth rather than the primary control: a `Principal` is minted
   * by session verification, which already refuses a deleted account, so a
   * caller holding one for a deleted account is holding a stale object. That
   * is exactly the case worth refusing again — a principal obtained a moment
   * before deletion must not keep working a moment after (AUTH-14).
   */
  private async requireLiveAccount(principal: Principal): Promise<Result<void>> {
    const account = await this.options.store.getUser(principal.abaUserId);
    if (account === null) return fail('NOT_FOUND');
    if (account.state === 'deleted') return fail('ACCOUNT_DELETED');
    return ok(undefined);
  }

  /**
   * Registers an installation, or refreshes one already registered.
   *
   * Idempotent by `(abaUserId, deviceId)`, because a client that cannot tell
   * "never arrived" from "arrived, response lost" will retry, and a second
   * row for one installation would inflate the account's own device list.
   *
   * A reinstall presents a **new** `deviceId` and so produces a new row; the
   * old one stays until retired. Two rows for one physical machine is normal
   * and is not an error to detect — recognising "the same machine" would need
   * a hardware or profile fingerprint, which is exactly the PII this design
   * declines to collect.
   */
  async registerDevice(principal: Principal, deviceId: string): Promise<Result<DeviceRow>> {
    if (!isDeviceId(deviceId)) return fail('INVALID_ARGUMENT');
    const live = await this.requireLiveAccount(principal);
    if (!live.ok) return fail(live.error.code);

    const now = this.options.clock.now();
    const existing = await this.options.store.getDevice(principal.abaUserId, deviceId);
    if (existing !== null) {
      await this.options.store.touchDevice(principal.abaUserId, deviceId, now);
      const refreshed = await this.options.store.getDevice(principal.abaUserId, deviceId);
      return refreshed === null ? fail('NOT_FOUND') : ok(refreshed);
    }

    const row: DeviceRow = {
      aba_user_id: principal.abaUserId,
      device_id: deviceId,
      registered_at: now,
      last_seen_at: now,
      retired_at: null,
      reactivated_at: null,
    };
    await this.options.store.insertDevice(row);
    this.options.log.info('device.registered', { abaUserId: principal.abaUserId, deviceId });
    return ok(row);
  }

  async getDevice(principal: Principal, deviceId: string): Promise<Result<DeviceRow>> {
    const row = await this.options.store.getDevice(principal.abaUserId, deviceId);
    return row === null ? fail('NOT_FOUND') : ok(row);
  }

  async listDevices(principal: Principal): Promise<DeviceRow[]> {
    return this.options.store.listDevices(principal.abaUserId);
  }

  /**
   * Retires a device.
   *
   * Retirement is bookkeeping: it deletes no record and revokes no session.
   * Its only effect in the wider design is to remove the device from the
   * tombstone purge quorum, which belongs to Cloud Sync and does not exist
   * yet — so here it is purely a state, which is the honest shape for it.
   */
  async retireDevice(principal: Principal, deviceId: string): Promise<Result<DeviceRow>> {
    const live = await this.requireLiveAccount(principal);
    if (!live.ok) return fail(live.error.code);
    const existing = await this.options.store.getDevice(principal.abaUserId, deviceId);
    if (existing === null) return fail('NOT_FOUND');
    if (existing.retired_at !== null) return ok(existing);

    await this.options.store.setDeviceRetired(
      principal.abaUserId,
      deviceId,
      this.options.clock.now(),
      existing.reactivated_at,
    );
    this.options.log.info('device.retired', { abaUserId: principal.abaUserId, deviceId });
    const row = await this.options.store.getDevice(principal.abaUserId, deviceId);
    return row === null ? fail('NOT_FOUND') : ok(row);
  }

  /**
   * Reactivates a retired device.
   *
   * It rejoins at its **existing** state rather than a fresh one. The
   * distinction is invisible today and load-bearing later: when Cloud Sync
   * adds an acknowledgement watermark, reactivating at the head would make a
   * device claim it had seen changes it has not, which is how a deleted
   * record gets resurrected.
   */
  async reactivateDevice(principal: Principal, deviceId: string): Promise<Result<DeviceRow>> {
    const live = await this.requireLiveAccount(principal);
    if (!live.ok) return fail(live.error.code);
    const existing = await this.options.store.getDevice(principal.abaUserId, deviceId);
    if (existing === null) return fail('NOT_FOUND');
    if (existing.retired_at === null) return ok(existing);

    await this.options.store.setDeviceRetired(
      principal.abaUserId,
      deviceId,
      null,
      this.options.clock.now(),
    );
    this.options.log.info('device.reactivated', { abaUserId: principal.abaUserId, deviceId });
    const row = await this.options.store.getDevice(principal.abaUserId, deviceId);
    return row === null ? fail('NOT_FOUND') : ok(row);
  }

  /** Records that a device was seen. Refused while retired. */
  async touchDevice(principal: Principal, deviceId: string): Promise<Result<DeviceRow>> {
    const live = await this.requireLiveAccount(principal);
    if (!live.ok) return fail(live.error.code);
    const existing = await this.options.store.getDevice(principal.abaUserId, deviceId);
    if (existing === null) return fail('NOT_FOUND');
    if (existing.retired_at !== null) return fail('DEVICE_RETIRED');

    await this.options.store.touchDevice(principal.abaUserId, deviceId, this.options.clock.now());
    const row = await this.options.store.getDevice(principal.abaUserId, deviceId);
    return row === null ? fail('NOT_FOUND') : ok(row);
  }
}
