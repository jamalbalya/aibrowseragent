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
  /**
   * The Google Cloud project an OAuth-authorized call is metered against.
   *
   * Per connection rather than global, for the same reason `baseUrl` is: two
   * authorized accounts can belong to different projects, and one of them
   * paying for the other's calls is not a detail. Written at connect time from
   * the build's configuration and never from a message.
   *
   * Absent on every key-authorized account, because a key carries its own
   * project.
   */
  readonly quotaProject?: string;
  /**
   * The model, exactly as the provider named it.
   *
   * For a gateway account this routinely contains `/` — `openai/gpt-5.x` — and
   * the `/` belongs to the identifier. Never split, normalised or shortened.
   */
  readonly modelId: string | null;
  /**
   * The upstream group the model was chosen from, for a provider that has groups.
   *
   * A gateway fronts several upstream providers at once, so a selection is two
   * choices rather than one, and this is the second. Persisted so the selection
   * restores without re-deriving it from the id — which is the one thing that
   * must not be done, because a combination's id has no prefix to read and a
   * prefix can disagree with the catalogue's own `owned_by`. It never decides
   * which model is sent.
   */
  readonly upstreamKey?: string;
  /**
   * Set when the last discovery did not offer `modelId`.
   *
   * Persisted rather than re-derived, because the runtime resolves a provider
   * without discovering a catalogue — it has an account, a key and a model id,
   * and making every task fetch `/models` first would put a network round trip
   * in front of each one. So discovery writes the verdict down and the runtime
   * reads it.
   *
   * Only ever set by comparing the exact id against a catalogue that was
   * actually read, and cleared the moment that exact id appears again. It is
   * never a reason to pick a different model: see `model-selection.ts`.
   */
  readonly modelStale?: true;
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
  // Choosing a model clears the stale marker. The user picked from a list this
  // build had just discovered, so the selection is current by construction —
  // and leaving the flag set would refuse a model that is demonstrably there.
  // `modelStale` is dropped rather than set to `false`: the field's presence is
  // the state, so an absent field and a stored `false` must not both exist.
  const { modelStale: _wasStale, statusReason: _priorReason, ...rest } = account;
  if (capabilitiesApplyTo(account, account.connectionId, modelId)) {
    // The measurement still applies, so the verdict it produced still applies
    // with it — including `statusReason`, which is put back here.
    return {
      ...rest,
      modelId,
      ...(account.statusReason === undefined ? {} : { statusReason: account.statusReason }),
    };
  }
  return {
    ...rest,
    modelId,
    capabilities: null,
    capabilityScope: null,
    lastValidated: null,
    // The verdict goes with the measurement that produced it.
    //
    // `status` and `statusReason` are written by `runDoctor`, which measures one
    // exact (connection, model) pair — so they are part of that measurement and
    // not a property of the account. Leaving them behind meant a model the
    // upstream account cannot use left the whole connection reading `failed`,
    // with that model's reason attached, after the user had switched to a model
    // that works. The measurement was correctly discarded and its conclusion
    // was not.
    //
    // `connectionAfterSwitch` has always done this for the pre-account slot, in
    // the same words: configured, not yet validated. Whether a credential is
    // stored is a different question from whether a model can do the work, and
    // only the capability doctor answers the second one. This is the account
    // path agreeing with the slot path.
    //
    // `disconnected` is the exception, because it is the one status that *is*
    // about the credential rather than the model: `noteProviderDisconnected`
    // sets it when the endpoint rejected the stored key, and no choice of model
    // makes that untrue.
    status: account.status === 'disconnected' ? 'disconnected' : 'connected',
    ...(account.status === 'disconnected' && account.statusReason !== undefined
      ? { statusReason: account.statusReason }
      : {}),
  };
}

/**
 * How a selection's freshness was established.
 *
 * Produced by `OfferedModels`, and a plain union here so this module does not
 * import it — the dependency runs the other way.
 */
export type SelectionProvenance = 'offered' | 'not-offered' | 'unknown';

/**
 * Applies a selection together with what is known about where it came from.
 *
 * `accountAfterSelection` always clears the stale marker, on the stated grounds
 * that "the user picked from a list this build had just discovered". That holds
 * for the dropdown and not for the text box beside it: `SettingsView` falls back
 * to a free-text input whenever the filtered list is empty, so an id can arrive
 * having never been in a catalogue.
 *
 * So the clear is conditional on provenance:
 *
 *  - `offered` — clear it. The selection is current.
 *  - `not-offered` — put it back. The id was not in the catalogue, which for a
 *    gateway is the one case that matters: 9Router resolves an unrecognised
 *    **slash-less** id through a table of name patterns and then defaults to
 *    `openai`, so sending one risks reaching an upstream nobody chose. (A
 *    prefixed id fails loudly instead — `404 No active credentials for
 *    provider: <prefix>` — but the rule is membership for every shape.)
 *  - `unknown` — clear it, because nothing was established either way. No
 *    discovery has succeeded in this worker lifetime, which means the endpoint
 *    has not answered, which means it cannot serve a request either.
 *
 * One function so the two selection routes cannot drift, and so the decision is
 * callable in a test rather than only readable in the worker's source.
 */
export function accountAfterOfferedSelection(
  account: ConnectedAccount,
  modelId: string,
  provenance: SelectionProvenance,
): ConnectedAccount {
  const selected = accountAfterSelection(account, modelId);
  return provenance === 'not-offered' ? accountAfterCatalogue(selected, true) : selected;
}

/**
 * The account with its stale marker set or cleared from a discovery verdict.
 *
 * One function so the two discovery routes cannot drift, and so the "absent
 * field means current" rule is applied in a single place.
 */
export function accountAfterCatalogue(account: ConnectedAccount, stale: boolean): ConnectedAccount {
  if (stale) return { ...account, modelStale: true };
  const { modelStale: _cleared, ...rest } = account;
  return rest;
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
