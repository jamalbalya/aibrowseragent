/**
 * Who owns the data on this installation, decided without asking anybody.
 *
 * The extension is standalone: it works with no account, no server and no
 * network. But "works with no account" is not the same as "has no owner" —
 * every workspace, connected provider account and active brain is stored
 * against an owner id, and something has to supply one.
 *
 * Until now that something was a sign-in, and with no backend deployed the
 * answer was the shared literal `unassigned` for every installation forever.
 * That is a placeholder the account model deliberately refuses to treat as an
 * owner (`bindAccountToUser` rejects it by name), so a standalone user could
 * never take ownership of anything they connected. This module supplies the
 * missing value locally.
 *
 * ## What this identifier is, and the seven things it is not
 *
 * It is a **partition label for local data**. That is the whole of it.
 *
 * | It is not | Because |
 * | --- | --- |
 * | authentication | nothing is proved by holding it; it is read from disk, not presented |
 * | authorization | no route, tool or egress decision reads it — see the note below |
 * | an encryption key | it is stored in plaintext beside the data it labels |
 * | a recovery key | it recovers nothing, and losing it loses no ciphertext |
 * | a provider credential | providers never see it, and it unlocks none of theirs |
 * | a human identity | it names an installation's data, not a person |
 * | a Google or email identity | no address, no subject, no provider ever touches it |
 *
 * **It authorises nothing, and that is structural rather than promised.**
 * Route trust is decided by the sender classifier, task isolation by the task
 * record, the workspace boundary by live Chrome state, egress by the
 * destination policy, consent by the consent store, taint by the taint state.
 * None of them takes an owner id as an input, so there is no parameter in
 * which this value could widen anything. What it does do is decide which
 * rows a reader is shown — a filter over local storage, applied after those
 * checks rather than instead of them.
 *
 * ## Why it is generated rather than derived
 *
 * Derived from a hardware value it would be a fingerprint, stable across
 * reinstalls and correlatable between installations — exactly the tracking
 * this product does not do. Derived from a Chrome runtime handle it would be
 * recycled state that changes under the data it labels. So it is 128 bits
 * from the platform CSPRNG and a function of nothing.
 *
 * ## What it deliberately cannot survive
 *
 * If Chrome deletes the extension's storage, this is gone with it, and a
 * fresh install mints a new one. There is no hidden copy, no server holding
 * a spare, and no recovery path that quietly re-establishes the old label.
 * Carrying data across an uninstall is what export and import are for, and
 * they are explicit because the alternative is a product that claims to
 * forget and does not.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';

const log = getLogger('security');

const IDENTITY_KEY = 'installation';

/**
 * `loc_` and not `usr_`, so the two can never be confused in a log, a record
 * or a reader's head. A `usr_` id was minted by a server that authenticated
 * somebody; a `loc_` id was minted by this device and proves nothing.
 */
export const LOCAL_IDENTITY_PREFIX = 'loc_';

/** 128 bits, hex. Wide enough that two installations never collide. */
export const LOCAL_IDENTITY_PATTERN = /^loc_[0-9a-f]{32}$/;

export interface LocalIdentity {
  /** Bumped only if the shape changes. A future value reads as unknown. */
  readonly version: 1;
  readonly installationId: string;
  readonly createdAt: number;
}

export function isLocalIdentity(value: unknown): value is LocalIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LocalIdentity>;
  return (
    record.version === 1 &&
    typeof record.installationId === 'string' &&
    LOCAL_IDENTITY_PATTERN.test(record.installationId) &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  );
}

/**
 * 128 bits from the platform CSPRNG, hex encoded.
 *
 * `getRandomValues` rather than `randomUUID` because the requirement is that
 * the randomness is cryptographic and that a test can say so: this is a
 * visible call to the CSPRNG rather than a helper that happens to use one.
 */
export function mintInstallationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${LOCAL_IDENTITY_PREFIX}${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Why an identity could not be established.
 *
 * Both are fail-closed: a caller that gets one must not invent an owner, and
 * must not carry on writing rows that would be labelled with a value nothing
 * agrees on.
 */
export type LocalIdentityFailure =
  /** Something is stored and it is not a local identity. */
  | 'CORRUPT'
  /** A write appeared to succeed and the read-back disagreed. */
  | 'NOT_PERSISTED';

export type LocalIdentityResult =
  | { readonly ok: true; readonly identity: LocalIdentity; readonly created: boolean }
  | { readonly ok: false; readonly failure: LocalIdentityFailure; readonly reason: string };

export interface LocalIdentityStoreOptions {
  readonly now?: () => number;
  readonly mint?: () => string;
}

export class LocalIdentityStore {
  private readonly now: () => number;
  private readonly mint: () => string;
  /**
   * The one `ensure` in flight, if any.
   *
   * Two callers racing a first run would otherwise both read absence, both
   * mint, and both write — after which one of them holds an id that is no
   * longer the stored one and labels rows nothing will ever find again.
   * Collapsing them means exactly one mint happens and every caller gets the
   * same answer. It is per worker instance, which is the right scope: storage
   * is per profile and the worker is the only thing that writes this.
   */
  private inFlight: Promise<LocalIdentityResult> | null = null;

  constructor(
    private readonly area: StorageArea,
    options: LocalIdentityStoreOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.mint = options.mint ?? mintInstallationId;
  }

  /**
   * Reads without creating.
   *
   * For callers that want to know whether an identity exists — the panel, a
   * migration — without the side effect of making one.
   */
  async peek(): Promise<LocalIdentity | null> {
    const stored = await this.area.get<unknown>(IDENTITY_KEY);
    if (stored === undefined) return null;
    return isLocalIdentity(stored) ? stored : null;
  }

  /**
   * The installation's identity, creating one on first run.
   *
   * The ordering is the design, and every step of it is a refusal to guess:
   *
   *  1. read what is there;
   *  2. a **valid** record is returned untouched — never re-minted, because
   *     re-minting would orphan everything already labelled with it;
   *  3. a record that is present but **malformed** fails closed rather than
   *     being replaced. Replacing it is indistinguishable, from here, from
   *     silently discarding a real installation's ownership: the bytes might
   *     be a corrupted id whose rows still exist, and minting over them would
   *     make that data invisible to everybody and deletable by nobody;
   *  4. only genuine absence mints;
   *  5. and a mint is **read back and compared** before it is believed. A
   *     write that reports success and does not land would otherwise leave
   *     the worker holding an id that exists nowhere, labelling rows that the
   *     next restart could not find.
   *
   * No step contacts anything. There is nothing to contact.
   */
  ensure(): Promise<LocalIdentityResult> {
    this.inFlight ??= this.runEnsure().then((result) => {
      // A failure is cleared so it can be retried; a success is kept, because
      // the identity cannot change while this worker is alive.
      if (!result.ok) this.inFlight = null;
      return result;
    });
    return this.inFlight;
  }

  private async runEnsure(): Promise<LocalIdentityResult> {
    const stored = await this.area.get<unknown>(IDENTITY_KEY);

    if (stored !== undefined) {
      if (isLocalIdentity(stored)) return { ok: true, identity: stored, created: false };
      log.error('The stored installation identity is malformed; refusing to replace it.');
      return {
        ok: false,
        failure: 'CORRUPT',
        reason: 'stored installation identity is unreadable',
      };
    }

    const identity: LocalIdentity = {
      version: 1,
      installationId: this.mint(),
      createdAt: this.now(),
    };
    await this.area.set(IDENTITY_KEY, identity);

    // Believe the write only after reading it back. `set` resolving is not
    // the same as the bytes being there on the next start.
    const readBack = await this.area.get<unknown>(IDENTITY_KEY);
    if (!isLocalIdentity(readBack) || readBack.installationId !== identity.installationId) {
      log.error('The installation identity did not persist; local ownership is not established.');
      return {
        ok: false,
        failure: 'NOT_PERSISTED',
        reason: 'installation identity did not survive read-back',
      };
    }

    log.info('A local installation identity was created for this device.');
    return { ok: true, identity: readBack, created: true };
  }
}

/**
 * Which id owns the local data, given both the sign-in profile and the local
 * identity.
 *
 * A signed-in profile wins, because its id is what every row was labelled
 * with while it was in force. Absent one, the installation identity is the
 * owner. That ordering is the whole rule — but it leaves one state that must
 * not be resolved by preferring either side.
 *
 * **Conflict: both exist and disagree.** Reachable if an installation ran
 * standalone, labelled its rows `loc_…`, and later signed in as `usr_…`.
 * Preferring the profile would hide every standalone row behind an owner
 * that never wrote them; preferring the local id would ignore an
 * authentication that did happen. Neither is safe, and adopting one into the
 * other is a migration with its own consent questions. So this fails closed
 * and leaves the decision to a person, exactly as `recordSignIn` already does
 * for a second user on one installation.
 */
export type OwnerResolution =
  | { readonly ok: true; readonly abaUserId: string; readonly source: 'profile' | 'installation' }
  | { readonly ok: false; readonly failure: 'CONFLICT'; readonly reason: string };

export function resolveOwner(
  profileUserId: string | null,
  installationId: string | null,
): OwnerResolution {
  if (profileUserId !== null && installationId !== null && profileUserId !== installationId) {
    return {
      ok: false,
      failure: 'CONFLICT',
      reason: 'a signed-in identity and a local identity disagree about who owns this data',
    };
  }
  if (profileUserId !== null) return { ok: true, abaUserId: profileUserId, source: 'profile' };
  if (installationId !== null) {
    return { ok: true, abaUserId: installationId, source: 'installation' };
  }
  return {
    ok: false,
    failure: 'CONFLICT',
    reason: 'no owner is established for this installation',
  };
}
