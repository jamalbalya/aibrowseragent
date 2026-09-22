/**
 * A connected AI provider account.
 *
 * The record that replaces the single provider slot. Until now a connection
 * was keyed by provider id, which made "the OpenAI connection" a singleton
 * and quietly ruled out the thing people actually do: a personal key and a
 * work key, or two OpenRouter accounts with different budgets.
 *
 * `connectionId` is the identity everything else hangs off — the credential
 * key, the consent pin, the task binding, the capability measurement. It is
 * local, opaque and stable; it is not derived from the provider, the endpoint
 * or the key, because all three can change while the account stays the same.
 *
 * **No secret lives in this record.** The credential is stored separately
 * under `credentials:conn:${connectionId}` and is reached only by the code
 * that builds a request. A record that carried its own key would end up in
 * every list response, every event broadcast and every debug log, which is
 * how a key escapes without anybody deciding it should.
 */
import type { ModelCapabilities } from '@/providers/core/types';

/**
 * The wire protocol an endpoint speaks.
 *
 * Deliberately separate from the provider. DeepSeek, Groq, Together and a
 * local llama.cpp all speak `openai-compatible`; they are different vendors
 * with different endpoints, models, capabilities and terms. Collapsing the
 * two would mean a new adapter per vendor, which is the architecture this
 * project already decided against.
 */
export const PROTOCOLS = ['openai-compatible', 'anthropic', 'gemini'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

/** How the account proves who it is. */
export const AUTH_KINDS = ['api_key', 'oauth2'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export const ACCOUNT_STATUSES = ['connected', 'limited', 'failed', 'disconnected'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * What a capability measurement was taken against.
 *
 * Stored beside the measurement rather than inferred, so a switch can ask
 * "were these measured for what is selected now?" and get an answer that does
 * not depend on remembering to clear them. A measurement taken on account A's
 * key says nothing about account B: the same model id on a different account
 * can differ in tier, rate limit and enabled features.
 */
export interface CapabilityScope {
  readonly connectionId: string;
  readonly modelId: string;
}

export interface ConnectedAccount {
  readonly connectionId: string;
  /**
   * The AI Browser Agent user this account belongs to, or `unassigned`.
   *
   * A *scoping label*, not an authorization input. Nothing consults it to
   * decide whether a request may be made; the egress gate never sees it. What
   * it does is survive: see `bindAccountToUser` for why it can only ever be
   * written once.
   */
  readonly abaUserId: string;
  readonly providerId: string;
  readonly protocol: Protocol;
  /** User-facing name: "OpenAI (work)". Editable, never used as an identity. */
  readonly displayName: string;
  /** Derived from the endpoint and key suffix. Never the key itself. */
  readonly accountLabel: string;
  readonly authKind: AuthKind;
  readonly baseUrl?: string;
  readonly modelId: string | null;
  readonly capabilities: ModelCapabilities | null;
  readonly capabilityScope: CapabilityScope | null;
  readonly status: AccountStatus;
  /**
   * Why the status is what it is, in words the panel can show.
   *
   * Carries the one thing a restored connection has to be able to say: that
   * it came back without its key. Never holds a credential, a token, or
   * anything derived from one.
   */
  readonly statusReason?: string;
  readonly lastValidated: number | null;
  readonly createdAt: number;
}

/**
 * The credential-store key for an account.
 *
 * The identity is the connection, never the provider: `apiKey:<providerId>`
 * is the legacy scheme and two accounts on one provider overwrite each other
 * there. This is the value passed to the connection-scoped credential
 * methods, which store it at `credentials:conn:<connectionId>`.
 */
export function credentialKeyFor(connectionId: string): string {
  return connectionId;
}

/**
 * Is this a well-formed account record?
 *
 * Used when reading storage back. A record that does not parse is evidence of
 * corruption, and the reader treats it as such rather than filling in
 * defaults — a default `status` of `connected` on an unreadable record would
 * be an account the user never configured, holding a credential reference
 * that may not resolve.
 */
export function isConnectedAccount(value: unknown): value is ConnectedAccount {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ConnectedAccount>;
  return (
    typeof record.connectionId === 'string' &&
    record.connectionId.length > 0 &&
    typeof record.abaUserId === 'string' &&
    record.abaUserId.length > 0 &&
    typeof record.providerId === 'string' &&
    typeof record.protocol === 'string' &&
    (PROTOCOLS as readonly string[]).includes(record.protocol) &&
    typeof record.displayName === 'string' &&
    typeof record.accountLabel === 'string' &&
    typeof record.authKind === 'string' &&
    (AUTH_KINDS as readonly string[]).includes(record.authKind) &&
    (record.modelId === null || typeof record.modelId === 'string') &&
    typeof record.status === 'string' &&
    (ACCOUNT_STATUSES as readonly string[]).includes(record.status) &&
    typeof record.createdAt === 'number'
  );
}

/**
 * Are these capabilities valid for this selection?
 *
 * The question a switch asks. A measurement whose scope names a different
 * account or a different model is evidence about something else, and carrying
 * it forward turns evidence about one thing into a claim about another —
 * which is worse than having no claim, because nothing downstream can tell a
 * stale claim from a fresh one.
 */
export function capabilitiesApplyTo(
  account: Pick<ConnectedAccount, 'capabilityScope'>,
  connectionId: string,
  modelId: string,
): boolean {
  const scope = account.capabilityScope;
  if (!scope) return false;
  return scope.connectionId === connectionId && scope.modelId === modelId;
}

/**
 * The record to store after selecting a connection and model.
 *
 * Extends the rule `connectionAfterSwitch` established for the single-slot
 * world to the account dimension: a measurement survives only when both the
 * account and the model are the ones it was measured on. Re-selecting what is
 * already selected changes nothing, because re-measuring on every settings
 * save would be its own kind of wrong.
 */
export function accountAfterSelection(
  account: ConnectedAccount,
  modelId: string,
): ConnectedAccount {
  if (capabilitiesApplyTo(account, account.connectionId, modelId)) {
    return { ...account, modelId };
  }
  return {
    ...account,
    modelId,
    capabilities: null,
    capabilityScope: null,
    lastValidated: null,
  };
}

/**
 * A label that identifies an account without revealing its credential.
 *
 * The last four characters of a key are enough for a person to tell two of
 * their own keys apart and are not enough to use. The endpoint host carries
 * the rest of the meaning, and is what distinguishes a DeepSeek account from
 * an OpenAI one when both speak the same protocol.
 */
export function deriveAccountLabel(baseUrl: string | undefined, apiKey: string): string {
  const suffix = apiKey.length >= 4 ? apiKey.slice(-4) : '';
  let host = '';
  if (baseUrl) {
    try {
      host = new URL(baseUrl).host;
    } catch {
      host = '';
    }
  }
  if (host && suffix) return `${host} (key …${suffix})`;
  if (host) return host;
  return suffix ? `key …${suffix}` : 'account';
}

/**
 * The `abaUserId` of an account that has never belonged to a signed-in user.
 *
 * Only two things wear it: an account migrated from the pre-authentication
 * credential layout, and an account connected while signed out. It is not a
 * user id and never resolves to one — it is the absence of an owner, spelled
 * explicitly so that "unowned" is a value the type system carries rather than
 * an empty string nobody checks.
 */
export const UNASSIGNED_ABA_USER = 'unassigned';

export function isUnassigned(account: Pick<ConnectedAccount, 'abaUserId'>): boolean {
  return account.abaUserId === UNASSIGNED_ABA_USER;
}

export type BindingRefusal = 'ALREADY_OWNED' | 'NOT_A_USER_ID';

export type BindingResult =
  | { readonly ok: true; readonly account: ConnectedAccount; readonly changed: boolean }
  | { readonly ok: false; readonly refusal: BindingRefusal; readonly reason: string };

/**
 * Binds an account to an AI Browser Agent user. The only writer of `abaUserId`.
 *
 * This function is the persistence invariant. The requirement it enforces is
 * that authentication lifecycle — expiry, refresh failure, revocation, logout,
 * backend outage, worker restart — must never reset, orphan or re-home a
 * user's connected accounts. The way to guarantee that is not to remember it
 * at every call site; it is to make sure no function exists that would do it.
 *
 * So there is exactly one transition:
 *
 *     unassigned  ──>  usr_X          allowed, once
 *     usr_X       ──>  usr_X          allowed, a no-op (re-runs are idempotent)
 *     usr_X       ──>  usr_Y          REFUSED
 *     usr_X       ──>  unassigned     impossible — there is no code path
 *
 * The last line is the important one. There is no `unbind`, no
 * `setAbaUserId`, no `clearOwner`. Signing out clears the session store, which
 * holds no account records and has no reference to the one that does. A
 * session ending therefore cannot un-own an account, because un-owning is not
 * an operation this module offers to anyone.
 *
 * `usr_X -> usr_Y` is refused rather than silently applied because a second
 * person signing in on a shared browser must not inherit the first person's
 * provider credentials. Their accounts are hidden from that user, not
 * reassigned to them.
 */
export function bindAccountToUser(account: ConnectedAccount, abaUserId: string): BindingResult {
  if (abaUserId.length === 0 || abaUserId === UNASSIGNED_ABA_USER) {
    return {
      ok: false,
      refusal: 'NOT_A_USER_ID',
      reason: 'An account can only be bound to a real user.',
    };
  }
  if (account.abaUserId === abaUserId) {
    return { ok: true, account, changed: false };
  }
  if (!isUnassigned(account)) {
    return {
      ok: false,
      refusal: 'ALREADY_OWNED',
      reason: 'This connection already belongs to a different AI Browser Agent user.',
    };
  }
  return { ok: true, account: { ...account, abaUserId }, changed: true };
}

/**
 * The accounts one user may see.
 *
 * Unassigned accounts are visible to whoever is signed in, because they are
 * this device's pre-existing connections and hiding them would present a
 * working installation as an empty one. Accounts owned by *another* user are
 * not returned — hidden, never deleted, and still there when that user
 * signs back in.
 */
export function visibleTo(
  accounts: readonly ConnectedAccount[],
  abaUserId: string | null,
): readonly ConnectedAccount[] {
  if (abaUserId === null) return accounts.filter(isUnassigned);
  return accounts.filter((account) => account.abaUserId === abaUserId || isUnassigned(account));
}
