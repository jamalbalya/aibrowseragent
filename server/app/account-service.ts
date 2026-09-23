/**
 * Accounts: creation, lookup, and the deletion state.
 *
 * **A client cannot choose its `abaUserId`.** `createAccount` takes no id —
 * there is no parameter in which to offer one, and the value comes from
 * `newAbaUserId()`, which is CSPRNG output derived from nothing (AUTH-1).
 * That is the enforcement; a validation rule rejecting a supplied id would be
 * weaker, because it would imply a code path that accepted one.
 */
import { fail, ok, type Result } from '../domain/errors';
import { newAbaUserId } from '../domain/ids';
import type { Clock } from '../domain/clock';
import type { AbaUserRow, Store } from '../db/store';
import type { Principal } from '../domain/authorization';
import type { ServerLogger } from '../logging';

export interface AccountServiceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly log: ServerLogger;
}

export class AccountService {
  constructor(private readonly options: AccountServiceOptions) {}

  /**
   * Creates an account.
   *
   * Note the signature: no input at all. An account is an empty durable
   * identity, and everything about a person — their email, their Google
   * subject — lives on an `auth_identity` row attached separately, because an
   * account that embedded its identity could not later hold two.
   */
  async createAccount(): Promise<AbaUserRow> {
    const row: AbaUserRow = {
      id: newAbaUserId(),
      created_at: this.options.clock.now(),
      state: 'active',
      deleted_at: null,
    };
    await this.options.store.insertUser(row);
    this.options.log.info('account.created', { abaUserId: row.id });
    return row;
  }

  async getAccount(principal: Principal): Promise<Result<AbaUserRow>> {
    const row = await this.options.store.getUser(principal.abaUserId);
    if (row === null) return fail('NOT_FOUND');
    if (row.state === 'deleted') return fail('ACCOUNT_DELETED');
    return ok(row);
  }

  /**
   * Marks an account deleted and revokes every session it holds.
   *
   * Two things this deliberately is **not**:
   *
   *  - It is not logout. Logout revokes one session and leaves the account
   *    active; this changes the account's own state, and no session operation
   *    can reach it (AUTH-13).
   *  - It is not a grace period. Whether deletion is immediate or cancellable
   *    is an open product question, and inventing a pending state here would
   *    answer it silently. The account moves from `active` to `deleted`.
   *
   * The destructive half — purging rows — belongs with the deletion workflow
   * and the Cloud Sync tables that do not yet exist. What is implemented is
   * the *state*, which is what stops a deleted account authorising anything
   * from this moment on.
   */
  async markAccountDeleted(principal: Principal): Promise<Result<AbaUserRow>> {
    const existing = await this.options.store.getUser(principal.abaUserId);
    if (existing === null) return fail('NOT_FOUND');
    if (existing.state === 'deleted') return fail('ACCOUNT_DELETED');

    const at = this.options.clock.now();
    await this.options.store.markUserDeleted(existing.id, at);
    const revoked = await this.options.store.revokeAllForUser(existing.id, at, 'account_deleted');
    this.options.log.info('account.deleted', { abaUserId: existing.id, sessionsRevoked: revoked });

    const row = await this.options.store.getUser(existing.id);
    return row === null ? fail('NOT_FOUND') : ok(row);
  }
}
