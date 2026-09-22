/**
 * Who this browser belongs to, remembered across everything.
 *
 * The AI Browser Agent user identity — `abaUserId` and the address that
 * names it — is **persistent user data**, not session state. It outlives
 * access-token expiry, refresh failure, revocation, logout, backend outage,
 * worker restart and browser restart. It is removed by exactly one thing: the
 * user explicitly wiping local data.
 *
 * That is not a nicety. `abaUserId` is what every connected account is bound
 * to, so if it were forgotten when a session ended, the accounts would be
 * owned by an id nothing remembered and the person would sign back in to an
 * apparently empty installation. Keeping it is what makes re-authentication
 * restore rather than recreate.
 *
 * **What is deliberately absent.** No token of any kind lives here — not an
 * access token, not a refresh token, not a Google `id_token`. Those belong to
 * `SessionStore`, in a different namespace with a different lifetime, and the
 * two modules do not import each other. A session ending therefore has no
 * reachable path to this record.
 */
import { getLogger } from '@/logging/logger';
import type { StorageArea } from '@/storage/storage-area';

const log = getLogger('security');

const PROFILE_KEY = 'profile';

/** How a user proved who they are. Recorded for display, never for authority. */
export const AUTH_METHOD_KINDS = ['google', 'email'] as const;
export type AuthMethodKind = (typeof AUTH_METHOD_KINDS)[number];

/**
 * The persistent identity of this installation's user.
 *
 * `email` is kept after sign-out on purpose: it is what lets the sign-in
 * screen offer "sign back in as …" rather than presenting a returning user
 * with a blank form. It is a label, and `emailVerified` records whether an
 * identity provider actually attested to it.
 */
export interface IdentityProfile {
  readonly abaUserId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly authMethods: readonly AuthMethodKind[];
  readonly firstSignedInAt: number;
  readonly lastSignedInAt: number;
}

export function isIdentityProfile(value: unknown): value is IdentityProfile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<IdentityProfile>;
  return (
    typeof record.abaUserId === 'string' &&
    record.abaUserId.length > 0 &&
    (record.email === null || typeof record.email === 'string') &&
    typeof record.emailVerified === 'boolean' &&
    Array.isArray(record.authMethods) &&
    typeof record.firstSignedInAt === 'number' &&
    typeof record.lastSignedInAt === 'number'
  );
}

export type ProfileRefusal = 'DIFFERENT_USER';

export type ProfileResult =
  | { readonly ok: true; readonly profile: IdentityProfile }
  | { readonly ok: false; readonly refusal: ProfileRefusal; readonly reason: string };

export class IdentityProfileStore {
  constructor(private readonly area: StorageArea) {}

  /**
   * The remembered user, if there is one.
   *
   * A malformed record reads as absent rather than being repaired. A profile
   * assembled from defaults would carry an `abaUserId` nobody authenticated
   * as, and every account bound to it would then be attributed to a user that
   * does not exist.
   */
  async get(): Promise<IdentityProfile | null> {
    const stored = await this.area.get<IdentityProfile>(PROFILE_KEY);
    if (stored === undefined) return null;
    if (!isIdentityProfile(stored)) {
      log.error('The stored identity profile is malformed and was not read.');
      return null;
    }
    return stored;
  }

  /** The remembered user id, or `null`. The value accounts are bound to. */
  async abaUserId(): Promise<string | null> {
    return (await this.get())?.abaUserId ?? null;
  }

  /**
   * Records a completed authentication.
   *
   * Signing in as the *same* user updates `lastSignedInAt` and merges the
   * method that was used — which is how Google and email both come to be
   * listed against one account without either displacing the other.
   *
   * Signing in as a *different* user is refused here rather than silently
   * overwriting, because overwriting would strand every account bound to the
   * previous id: still present in storage, owned by a user this device no
   * longer remembers, and invisible to everyone. The caller must wipe local
   * data deliberately first, with the consequences stated.
   */
  async recordSignIn(input: {
    readonly abaUserId: string;
    readonly email: string | null;
    readonly emailVerified: boolean;
    readonly method: AuthMethodKind;
    readonly now: number;
  }): Promise<ProfileResult> {
    const existing = await this.get();

    if (existing && existing.abaUserId !== input.abaUserId) {
      return {
        ok: false,
        refusal: 'DIFFERENT_USER',
        reason:
          'This browser already holds another AI Browser Agent user’s data. Remove it ' +
          'explicitly before signing in as someone else.',
      };
    }

    const methods = new Set<AuthMethodKind>(existing?.authMethods ?? []);
    methods.add(input.method);

    const profile: IdentityProfile = {
      abaUserId: input.abaUserId,
      email: input.email,
      emailVerified: input.emailVerified,
      authMethods: [...methods],
      firstSignedInAt: existing?.firstSignedInAt ?? input.now,
      lastSignedInAt: input.now,
    };
    await this.area.set(PROFILE_KEY, profile);
    return { ok: true, profile };
  }

  /**
   * Forgets the user entirely.
   *
   * Deliberately **not** called by sign-out. This is the explicit local-wipe
   * path, and it is the only thing in this module that removes a profile.
   * Everything about an authentication session ending is handled by
   * `SessionStore`, which cannot reach this.
   */
  async forget(): Promise<void> {
    await this.area.remove(PROFILE_KEY);
    log.info('The local identity profile was erased at the user’s request.');
  }
}
