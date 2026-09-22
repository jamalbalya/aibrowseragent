/**
 * Connected AI accounts, and which one is the AI brain.
 *
 * The list the settings page opens with. Below it, unchanged, is the same
 * provider form that has always been there — endpoint, API key, model,
 * Connect, capability check — now reached under "Connect AI Provider" rather
 * than being the whole of the page.
 *
 * Two things this deliberately shows rather than hides:
 *
 *  - A restored connection says it needs its key back. Cloud restore brings
 *    back what an account *was*, never its credential, and presenting one
 *    that will fail at its first request would be worse than saying so.
 *  - Unowned connections are *offered*, never taken. Connections set up
 *    before anyone signed in belong to whoever set them up, and on a shared
 *    or handed-down profile claiming them automatically would hand one
 *    person another person's provider credentials with no way back.
 */
import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { ConnectedAccountView, PanelResponse } from '@/messaging/protocol';

interface ConnectedAccountsProps {
  readonly onMessage: (tone: 'ok' | 'error', text: string) => void;
  readonly onChanged: () => void;
}

type AccountsResponse = PanelResponse<'accounts.list'>;

export function ConnectedAccounts({
  onMessage,
  onChanged,
}: ConnectedAccountsProps): React.JSX.Element {
  const [accounts, setAccounts] = useState<readonly ConnectedAccountView[]>([]);
  const [brain, setBrain] = useState<AccountsResponse['brain']>(null);
  const [offer, setOffer] = useState<readonly ConnectedAccountView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const listed = await sendToBackground('accounts.list', {});
    setAccounts(listed.accounts);
    setBrain(listed.brain);
    const pending = await sendToBackground('accounts.associationOffer', {});
    // An offer already declined is not shown again. The connections stay
    // exactly where they are; only the prompt stops.
    setOffer(pending.declined ? [] : pending.accounts);
  }, []);

  useEffect(() => {
    // Synchronises the panel with the service worker, which is what effects
    // are for. The state updates happen after an await, not in the body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().catch((error: unknown) => onMessage('error', describe(error)));
  }, [refresh, onMessage]);

  const selectBrain = useCallback(
    async (account: ConnectedAccountView) => {
      if (!account.modelId) {
        onMessage('error', `Choose a model for ${account.displayName} first.`);
        return;
      }
      setBusy(account.connectionId);
      try {
        await sendToBackground('accounts.setBrain', {
          connectionId: account.connectionId,
          modelId: account.modelId,
        });
        await refresh();
        onChanged();
        onMessage('ok', `${account.displayName} is now the AI brain.`);
      } catch (error) {
        onMessage('error', describe(error));
      } finally {
        setBusy(null);
      }
    },
    [refresh, onChanged, onMessage],
  );

  const disconnect = useCallback(
    async (account: ConnectedAccountView) => {
      setBusy(account.connectionId);
      try {
        await sendToBackground('accounts.disconnect', { connectionId: account.connectionId });
        await refresh();
        onChanged();
        onMessage('ok', `${account.displayName} was disconnected.`);
      } catch (error) {
        onMessage('error', describe(error));
      } finally {
        setBusy(null);
      }
    },
    [refresh, onChanged, onMessage],
  );

  const check = useCallback(
    async (account: ConnectedAccountView) => {
      if (!account.modelId) {
        onMessage('error', `Choose a model for ${account.displayName} first.`);
        return;
      }
      setBusy(account.connectionId);
      try {
        const { report } = await sendToBackground('accounts.runDoctor', {
          connectionId: account.connectionId,
          modelId: account.modelId,
        });
        await refresh();
        // The doctor's verdict is reported as it came back. A failed check is
        // shown as failed rather than smoothed into a warning.
        onMessage(
          report.readiness === 'AGENT_READY' ? 'ok' : 'error',
          `${account.displayName}: ${report.readiness}.`,
        );
      } catch (error) {
        onMessage('error', describe(error));
      } finally {
        setBusy(null);
      }
    },
    [refresh, onMessage],
  );

  const takeOwnership = useCallback(async () => {
    setBusy('associate');
    try {
      const outcome = await sendToBackground('accounts.associate', {});
      await refresh();
      onMessage('ok', `${outcome.associated} connection(s) added to your account.`);
    } catch (error) {
      onMessage('error', describe(error));
    } finally {
      setBusy(null);
    }
  }, [refresh, onMessage]);

  const declineOwnership = useCallback(async () => {
    setBusy('associate');
    try {
      await sendToBackground('accounts.declineAssociation', {});
      await refresh();
    } catch (error) {
      onMessage('error', describe(error));
    } finally {
      setBusy(null);
    }
  }, [refresh, onMessage]);

  const brainAccount = accounts.find((account) => account.connectionId === brain?.connectionId);

  return (
    <section className="settings__section">
      <h3>Connected AI accounts</h3>

      <p className="field__hint">
        {brainAccount
          ? `AI brain: ${brainAccount.displayName} · ${brainAccount.modelId ?? 'no model'}`
          : 'No AI brain selected. Choose one below, or connect an AI provider.'}
      </p>

      {accounts.length === 0 ? (
        <p className="field__hint">
          No AI accounts connected yet. Connect one below to get started.
        </p>
      ) : (
        <ul className="account-list">
          {accounts.map((account) => (
            <li key={account.connectionId} className="account-list__item">
              <div>
                <strong>{account.displayName}</strong>
                {account.isBrain ? <span className="badge">AI brain</span> : null}
                <div className="field__hint">
                  {account.accountLabel}
                  {account.modelId ? ` · ${account.modelId}` : ' · no model selected'}
                </div>
                {/* Said plainly. A restored connection has no credential, and
                    pretending otherwise fails at the first request instead. */}
                {account.statusReason ? (
                  <div className="field__hint field__hint--warning">{account.statusReason}</div>
                ) : null}
              </div>
              <div className="account-list__actions">
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy !== null || account.isBrain}
                  onClick={() => void selectBrain(account)}
                >
                  Use as AI brain
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy !== null}
                  onClick={() => void check(account)}
                >
                  Run capability check
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy !== null}
                  onClick={() => void disconnect(account)}
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {offer.length > 0 ? (
        <div className="notice">
          <p>
            {offer.length} connection(s) on this device are not yet part of any AI Browser Agent
            account. Add them to yours?
          </p>
          <p className="field__hint">
            Either way they keep working. Declining leaves them exactly as they are.
          </p>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => void takeOwnership()}
          >
            Add to my account
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={busy !== null}
            onClick={() => void declineOwnership()}
          >
            Not now
          </button>
        </div>
      ) : null}
    </section>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
