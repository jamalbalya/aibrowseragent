/**
 * The display projection of the AI brain.
 *
 * There are two records describing "the AI connection this installation
 * uses", and until now they could disagree with each other:
 *
 *  - `AccountStore` holds the connected accounts and which one is the brain.
 *    `resolveProvider` reads it, so it decides what actually runs.
 *  - `settings.provider-connection` is the single-slot record from before
 *    accounts existed. The **panel** reads it: the header's status line and
 *    the composer's readiness gate are both derived from it.
 *
 * Connecting an account wrote the first and not the second, so a user could
 * connect an account, see the capability check pass, and still be told there
 * was no provider — and the composer stayed disabled while the runtime had a
 * perfectly good account to use.
 *
 * The fix is not a third store. It is to stop treating the settings record as
 * a second source of truth and make it a **projection** of the first: derived
 * whenever the brain changes, never written by hand, and carrying the
 * `connectionId` it came from so that nothing downstream can mistake a
 * projection for the pre-account record it replaced.
 *
 * Pure, and separate from the worker, because the interesting rule here — a
 * measurement counts only on the pair it was measured on — is exactly the
 * kind of thing that should be provable without a browser.
 */
import type { ProviderConnection } from '@/providers/registry/provider-registry';
import type { ConnectedAccount } from './account-model';

/**
 * Projects the brain account onto the panel's connection record.
 *
 * `null` in, `null` out: no brain means no connection to show, which is the
 * honest answer and the one the header already renders.
 */
export function connectionForBrain(account: ConnectedAccount | null): ProviderConnection | null {
  if (account === null) return null;

  // Carried through unchanged. A measurement belongs to the (connection,
  // model) pair it was taken on, and `capabilityScope` is what records that
  // pair — so a capability survives the projection only when the account
  // itself would still honour it. Showing "tool calling: yes" from a
  // measurement taken on another model is how a composer gets enabled for a
  // model that cannot drive a browser.
  const scoped =
    account.capabilityScope?.connectionId === account.connectionId &&
    account.capabilityScope?.modelId === account.modelId;

  return {
    connectionId: account.connectionId,
    providerId: account.providerId,
    modelId: account.modelId ?? '',
    authKind: account.authKind,
    ...(scoped && account.capabilities ? { capabilities: account.capabilities } : {}),
    createdAt: account.createdAt,
    ...(account.lastValidated === null ? {} : { lastValidated: account.lastValidated }),
    status: projectStatus(account.status),
  };
}

/**
 * A projection is never a legacy record.
 *
 * The one-time migration reads `settings.provider-connection` and turns it
 * into an account. A projection written *by* an account must not be read back
 * as something to migrate — that would mint a second account for a connection
 * that already has one, and the credential it went looking for
 * (`apiKey:<providerId>`) was never there, so the migration would "helpfully"
 * clear the projection and leave the installation with no visible connection.
 *
 * `connectionId` is the discriminator, and it is structural rather than a
 * flag somebody has to remember to set: only a projection has one.
 */
export function isBrainProjection(connection: ProviderConnection | undefined): boolean {
  return typeof connection?.connectionId === 'string' && connection.connectionId.length > 0;
}

function projectStatus(status: string): ProviderConnection['status'] {
  return status === 'connected' || status === 'limited' || status === 'failed'
    ? status
    : 'disconnected';
}
