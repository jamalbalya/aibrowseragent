/**
 * Bringing connected accounts back after a reinstall.
 *
 * What comes back from Cloud Sync is *metadata*: which provider, which
 * endpoint, which model, what the account was called. What does not come back
 * is the API key, because provider credentials are never uploaded — not in
 * plaintext and, in this wave, not encrypted either.
 *
 * That shapes the whole contract. A restored account is deliberately
 * `disconnected` and says so:
 *
 *     "This connection was restored, but its API key needs to be reconnected
 *      on this device."
 *
 * This is the important trade and it is worth naming. The alternative to an
 * honest reconnect prompt is not a working connection — it is either losing
 * the account entirely, or presenting one that will fail at its first request
 * with an authentication error the user cannot interpret. Restoring the shape
 * of someone's setup and asking for one key back is strictly better than
 * both, and it is the only one of the three that does not lie.
 *
 * Nothing here deletes. A restore that found unexpected local data leaves it
 * alone: this runs on a device that may already be in use, and a sync payload
 * is not authority to remove something the person has in front of them.
 */
import { getLogger } from '@/logging/logger';
import { CREDENTIAL_RECONNECT_NOTICE } from '@/storage/data-classification';
import { credentialKeyFor, isConnectedAccount, type ConnectedAccount } from './account-model';
import type { AccountStore, CredentialPort } from './account-store';

const log = getLogger('provider');

/**
 * The metadata Cloud Sync holds for one connection.
 *
 * No credential field exists, so a payload cannot smuggle one in and a future
 * edit cannot add one without changing this type in review.
 */
export interface ConnectionMetadata {
  readonly connectionId: string;
  readonly providerId: string;
  readonly protocol: ConnectedAccount['protocol'];
  readonly authKind: ConnectedAccount['authKind'];
  readonly displayName: string;
  readonly accountLabel: string;
  readonly baseUrl?: string;
  readonly modelId: string | null;
  readonly createdAt: number;
}

export interface RestoreOutcome {
  readonly restored: readonly string[];
  /** Already present locally with a working credential; left untouched. */
  readonly keptLocal: readonly string[];
  readonly rejected: readonly string[];
}

/**
 * Writes restored connections for an already-authenticated user.
 *
 * `abaUserId` is supplied by the caller from the resolved session. This
 * function never mints one: creating an identity during a restore is exactly
 * the failure the recovery invariant forbids, and the only way to be sure it
 * cannot happen here is for this code to have no way to do it.
 */
export async function restoreConnections(
  store: AccountStore,
  credentials: CredentialPort,
  abaUserId: string,
  records: readonly ConnectionMetadata[],
  now: number,
): Promise<RestoreOutcome> {
  const restored: string[] = [];
  const keptLocal: string[] = [];
  const rejected: string[] = [];

  for (const record of records) {
    if (
      typeof record?.connectionId !== 'string' ||
      record.connectionId.length === 0 ||
      typeof record.providerId !== 'string'
    ) {
      rejected.push(String((record as Partial<ConnectionMetadata>)?.connectionId ?? '?'));
      continue;
    }

    // A connection already here with a usable key is working. The remote copy
    // knows less about it than this device does, so it does not get to
    // downgrade it to `disconnected`.
    const existing = await store.get(record.connectionId);
    if (existing) {
      const key = await credentials.read(credentialKeyFor(record.connectionId));
      if (typeof key === 'string' && key.length > 0) {
        keptLocal.push(record.connectionId);
        continue;
      }
    }

    const account: ConnectedAccount = {
      connectionId: record.connectionId,
      abaUserId,
      providerId: record.providerId,
      protocol: record.protocol,
      displayName: record.displayName,
      accountLabel: record.accountLabel,
      authKind: record.authKind,
      ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
      modelId: record.modelId,
      // Measured on a device this one is not. A capability claim that did not
      // come from this installation's own key is not evidence about it.
      capabilities: null,
      capabilityScope: null,
      status: 'disconnected',
      statusReason: CREDENTIAL_RECONNECT_NOTICE,
      lastValidated: null,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    };

    if (!isConnectedAccount(account)) {
      rejected.push(record.connectionId);
      continue;
    }
    await store.put(account);
    restored.push(record.connectionId);
  }

  log.info('Connections were restored from cloud metadata.', {
    restored: restored.length,
    keptLocal: keptLocal.length,
    rejected: rejected.length,
  });
  return { restored, keptLocal, rejected };
}

/** Does this account need a key before it can be used? */
export function needsReconnect(account: ConnectedAccount): boolean {
  return account.status === 'disconnected';
}
