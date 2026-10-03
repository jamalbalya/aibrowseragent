/**
 * Turning the account the user selected into the request that will be sent.
 *
 * ## Why this is its own module
 *
 * It was ~55 lines inside `service-worker.ts`, reachable only by driving the
 * whole worker in a browser. That is the shape `doctorVerdict` and
 * `digestStep` were both extracted out of, and the argument is stronger here
 * than it was for either: this function is **the answer to "which AI account
 * is actually powering the agent"**. Five separate refusals live in it, and a
 * mutation to any one of them is a selection the user made being quietly
 * replaced by something else:
 *
 *  - no model chosen on the account;
 *  - a model the last discovery did not offer;
 *  - no credential on this device;
 *  - a credential the provider rejected;
 *  - a capability measurement that belongs to a different (account, model).
 *
 * None of those could be asserted without a real Chromium run, and an E2E
 * suite cannot enumerate branch-by-branch what a selection resolves to. Now
 * it can be called with a record and a fake adapter, and the one thing the
 * tests check is the thing that matters: **the credential, base URL and model
 * that reach the adapter are the ones belonging to the account the user
 * selected, and nothing else's.**
 *
 * ## What it does not decide
 *
 * It does not choose the account — `AccountStore.getBrainAccount` does, from
 * the user's own selection. It does not read the legacy single-provider slot;
 * the worker still owns that fallback, because it is about an installation
 * that has not migrated rather than about an account. And it never substitutes:
 * every failure throws, because §60 forbids a silent provider fallback and the
 * way to keep that true is to have no code path from a refused selection to a
 * request.
 */
import { UNKNOWN_CAPABILITIES, type ModelCapabilities } from '@/providers/core/types';
import type { AIProviderAdapter, AuthResult } from '@/providers/core/types';
import type { ConnectedAccount } from './account-model';

/** What a resolution produces: an adapter already connected as this account. */
export interface ResolvedAccount {
  readonly adapter: AIProviderAdapter;
  readonly capabilities: ModelCapabilities;
  readonly providerId: string;
  readonly connectionId: string;
  readonly modelId: string;
}

/**
 * Why a selection could not become a request.
 *
 * A named reason rather than a bare message, so a caller can tell the ones
 * the user fixes in Settings from the one that means the provider refused a
 * credential — those lead to different actions, and the worker records only
 * the last as a disconnection.
 */
export type BrainRefusal =
  'NO_MODEL_SELECTED' | 'MODEL_STALE' | 'NO_CREDENTIAL_ON_DEVICE' | 'CREDENTIAL_REJECTED';

export class BrainUnavailable extends Error {
  constructor(
    readonly refusal: BrainRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'BrainUnavailable';
  }
}

export interface ResolveBrainDeps {
  /** The adapter family for a provider id. */
  readonly adapterFor: (providerId: string) => AIProviderAdapter;
  /** The credential for one connection, or `undefined` when none is held. */
  readonly keyFor: (connectionId: string) => Promise<string | undefined>;
  /** What the refusal says when a selection is no longer offered. */
  readonly staleMessage: (modelId: string) => string;
}

export interface ResolveBrainOptions {
  /**
   * Permits a selection the last discovery did not offer.
   *
   * Passed by exactly one caller — the discovery route — because that route
   * is what lets the user choose again, and refusing it there would make a
   * stale selection unrecoverable. Nothing on the request path passes it.
   */
  readonly allowStale?: boolean;
}

/**
 * Whether a measurement was taken on the pair that is now selected.
 *
 * Exported because it is the rule that decides what the adapter is told about
 * the model's abilities, and getting it wrong in the permissive direction is
 * worse than having no measurement at all: a capability carried over from
 * another model reads as evidence. One expression, used once, so the adapter
 * and the returned capabilities cannot come to disagree.
 */
export function measurementApplies(account: ConnectedAccount): ModelCapabilities | null {
  if (account.capabilityScope?.connectionId !== account.connectionId) return null;
  if (account.capabilityScope?.modelId !== account.modelId) return null;
  return account.capabilities ?? null;
}

/**
 * Resolves one connected account into a connected adapter.
 *
 * The order of the checks is deliberate: the two that need no secret come
 * first, so a selection that cannot be used stops **before** a key is read.
 * That is what makes "never substitute" structural rather than intended —
 * there is no path from a refused selection to a provider request, so nothing
 * downstream has to remember not to guess.
 *
 * The adapter is reconnected on every call, not cached. The worker may have
 * restarted, and the previous call may have connected the same adapter family
 * as a **different** account: one instance per provider is shared, and leaving
 * the last account's credential in it is exactly the cross-account leak the
 * account model exists to prevent.
 */
export async function resolveBrainAccount(
  account: ConnectedAccount,
  deps: ResolveBrainDeps,
  options: ResolveBrainOptions = {},
): Promise<ResolvedAccount> {
  if (!account.modelId) {
    throw new BrainUnavailable(
      'NO_MODEL_SELECTED',
      `${account.displayName} has no model selected. Choose one in Settings.`,
    );
  }
  if (account.modelStale === true && options.allowStale !== true) {
    throw new BrainUnavailable('MODEL_STALE', deps.staleMessage(account.modelId));
  }

  const apiKey = await deps.keyFor(account.connectionId);
  if (apiKey === undefined) {
    // Two sentences rather than one, because the fix differs. A pasted key is
    // re-pasted; an authorization is re-granted at the provider, and telling
    // somebody who connected with Google to "reconnect its API key" sends them
    // looking for something they never had.
    throw new BrainUnavailable(
      'NO_CREDENTIAL_ON_DEVICE',
      account.statusReason ??
        (account.authKind === 'oauth2'
          ? `${account.displayName} needs authorizing again on this device.`
          : `${account.displayName} needs its API key reconnected on this device.`),
    );
  }

  const adapter = deps.adapterFor(account.providerId);
  const measured = measurementApplies(account);

  const auth: AuthResult = await adapter.connect({
    providerId: account.providerId,
    ...(account.baseUrl === undefined ? {} : { baseUrl: account.baseUrl }),
    apiKey,
    // How the credential is presented, from the account record rather than
    // from the shape of the string. An access token and a key are both opaque,
    // and an adapter that guessed would send one in the header the endpoint
    // ignores — an unauthenticated request carrying the user's credential.
    credentialScheme: account.authKind === 'oauth2' ? 'bearer' : 'api_key',
    // Travels with the account, so a second authorized account on another
    // project cannot be metered against this one's.
    ...(account.quotaProject === undefined ? {} : { quotaProject: account.quotaProject }),
    model: account.modelId,
    // Handed in so the adapter's pre-flight capability check reads the
    // doctor's measurement rather than its own advertised placeholder.
    // Omitted when nothing has been measured for this exact pair, which
    // leaves the adapter reporting `unverified` and the request refused as
    // such — the correct outcome, and not a failure of this function.
    ...(measured === null ? {} : { measuredCapabilities: measured }),
  });

  if (!auth.authenticated) {
    throw new BrainUnavailable(
      'CREDENTIAL_REJECTED',
      auth.error?.userMessage ?? 'The connected account rejected its stored credentials.',
    );
  }

  return {
    adapter,
    capabilities: measured ?? UNKNOWN_CAPABILITIES,
    providerId: account.providerId,
    connectionId: account.connectionId,
    modelId: account.modelId,
  };
}
