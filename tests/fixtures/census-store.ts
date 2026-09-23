/**
 * The real store, with a census of everything that carries an account.
 *
 * Some properties are about what a request produced; this one is about what
 * it did **not** produce, and an absence needs a different kind of witness. A
 * test that refreshes and then looks up the caller's account proves the
 * account it found is the right one — it cannot prove that a second account,
 * a second identity or a second device did not quietly come into existence
 * beside it, because it never looks there.
 *
 * So the census sits at the `Store` port and watches rows being created. That
 * is the whole of the argument for it being authoritative: `SessionService`,
 * `IdentityService`, `DeviceService` and `AccountService` each hold a `Store`
 * and nothing else, so a row cannot exist unless one of the `insert*` methods
 * below was called. Counting those calls is therefore a measurement of the
 * population rather than an inference about it — which is the distinction
 * between this and reading the source and concluding nothing happens.
 *
 * It wraps a genuine `MemoryStore` and changes no behaviour: every call is
 * forwarded, and the only thing added is the tally.
 */
import { MemoryStore } from '../../server/index';
import type { AbaUserRow, AuthIdentityRow, DeviceRow, Store } from '../../server/index';

/** The rows that carry an account identity. Sessions and challenges do not. */
export interface Census {
  readonly accounts: number;
  readonly identities: number;
  readonly devices: number;
}

export interface CensusStore {
  /** Hand this to `createIdentityBackend({ store })`. */
  readonly store: Store;
  /** The live population, at the moment it is asked. */
  census(): Census;
  /** Every account id that has ever existed in this store. */
  accountIds(): readonly string[];
  /** Every authentication identity id that currently exists. */
  identityIds(): readonly string[];
}

/**
 * The port's whole creation surface, as this census understands it.
 *
 * Asserted against the real prototype by `assertCensusIsTotal`, so a store
 * that grows a sixth `insert*` method cannot leave the census quietly
 * counting five kinds of row and reporting the sixth as zero.
 */
export const CREATING_METHODS = [
  'insertChallenge',
  'insertDevice',
  'insertIdentity',
  'insertSession',
  'insertUser',
] as const;

/**
 * Fails if the store can create a row the census does not know about.
 *
 * Runtime rather than type-level on purpose: a missing case in the census is
 * a silent under-count, and an under-count is exactly the failure a test
 * asserting "nothing was created" must not be able to have.
 */
export function creationSurface(): readonly string[] {
  return Object.getOwnPropertyNames(MemoryStore.prototype)
    .filter((name) => name.startsWith('insert'))
    .sort();
}

export function censusStore(inner: Store = new MemoryStore()): CensusStore {
  const accounts = new Set<string>();
  const identities = new Set<string>();
  const devices = new Set<string>();

  const store = new Proxy(inner, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const call = value.bind(target) as (...args: never[]) => unknown;

      switch (property) {
        case 'insertUser':
          return async (row: AbaUserRow): Promise<void> => {
            await (call as (r: AbaUserRow) => Promise<void>)(row);
            accounts.add(row.id);
          };
        case 'insertIdentity':
          return async (row: AuthIdentityRow): Promise<void> => {
            await (call as (r: AuthIdentityRow) => Promise<void>)(row);
            identities.add(row.id);
          };
        case 'insertDevice':
          return async (row: DeviceRow): Promise<void> => {
            await (call as (r: DeviceRow) => Promise<void>)(row);
            devices.add(`${row.aba_user_id}/${row.device_id}`);
          };
        // An identity is the one kind that is genuinely removed rather than
        // marked; accounts are marked deleted and devices are retired, so
        // both stay in the population and the census keeps counting them.
        case 'deleteIdentity':
          return async (id: string): Promise<void> => {
            await (call as (i: string) => Promise<void>)(id);
            identities.delete(id);
          };
        default:
          return call;
      }
    },
  });

  return {
    store,
    census: () => ({ accounts: accounts.size, identities: identities.size, devices: devices.size }),
    accountIds: () => [...accounts],
    identityIds: () => [...identities],
  };
}
