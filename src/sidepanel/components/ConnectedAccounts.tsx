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
  /**
   * Models discovered for one account, and which account they belong to.
   *
   * **This closes a dead end.** An account authorized with Google always
   * arrives with no model selected — deliberately, because the build must not
   * assert anything about somebody else's catalogue. Until now the only model
   * picker lived in the provider form above, bound to whichever connection
   * this panel session had just connected or to the current brain. So a user
   * who authorized Google while another account was the brain, or who reopened
   * the panel, saw a row saying "no model selected" and two buttons that both
   * answered "choose a model first" — with nowhere to choose one.
   *
   * Keyed by connection so two accounts cannot show each other's catalogue.
   */
  const [picker, setPicker] = useState<{
    readonly connectionId: string;
    readonly models: readonly { readonly id: string; readonly displayName: string }[];
    readonly refused: number;
  } | null>(null);

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
        onMessage(
          'error',
          `Choose a model for ${account.displayName} first — the "Choose a model" button on ` +
            'its row asks the account what it can run.',
        );
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

  /**
   * Asks the account's own endpoint what it can run.
   *
   * The same route the provider form uses, against this connection's own
   * credential — so an authorized Google account lists what Google says that
   * project may use, and a pasted key lists what that key may use. Nothing
   * here has a model list of its own.
   */
  const discover = useCallback(
    async (account: ConnectedAccountView) => {
      setBusy(account.connectionId);
      try {
        const listed = await sendToBackground('accounts.listModels', {
          connectionId: account.connectionId,
        });
        setPicker({
          connectionId: account.connectionId,
          models: listed.models,
          refused: listed.refused ?? 0,
        });
        if (listed.models.length === 0) {
          // Said plainly rather than shown as an empty dropdown. An endpoint
          // that lists nothing is a real state — a key without access, a
          // project without the API enabled — and it is not the same as
          // "loading".
          onMessage(
            'error',
            `${account.displayName} did not offer any usable models. Check that the account ` +
              'has access and that its credential is still valid.',
          );
        }
      } catch (error) {
        onMessage('error', describe(error));
      } finally {
        setBusy(null);
      }
    },
    [onMessage],
  );

  /**
   * Selects a model and makes that account the brain.
   *
   * Both at once, because a model chosen on an account that is not the brain
   * would be a selection with no effect, and the user pressed a button that
   * says what it does. The capability check stays a separate, deliberate
   * action — it issues several real model round-trips.
   */
  const chooseModel = useCallback(
    async (account: ConnectedAccountView, modelId: string) => {
      setBusy(account.connectionId);
      try {
        await sendToBackground('accounts.setBrain', {
          connectionId: account.connectionId,
          modelId,
        });
        setPicker(null);
        await refresh();
        onChanged();
        onMessage(
          'ok',
          `${account.displayName} is now the AI brain, on ${modelId}. Run the capability check ` +
            'to confirm it can drive the browser.',
        );
      } catch (error) {
        onMessage('error', describe(error));
      } finally {
        setBusy(null);
      }
    },
    [refresh, onChanged, onMessage],
  );

  /**
   * Re-authorizes an account whose Google authorization has expired.
   *
   * **The dead end this closes.** An authorization expires, the renewal is
   * refused, and the account is marked disconnected with a reason. Before
   * this the only way forward was *Connect with Google* in the provider form,
   * which minted a **second** account for the same Google account: two rows
   * with the same label, one of them dead, and the model choice left behind on
   * the dead one.
   *
   * This writes the new token to the same connection, so the model, the
   * consent pin and the audit history stay attached to the account the user
   * already had. The capability measurement is deliberately not kept — it was
   * taken with a credential that no longer exists.
   */
  const reauthorize = useCallback(
    async (account: ConnectedAccountView) => {
      setBusy(account.connectionId);
      try {
        const result = await sendToBackground('accounts.connectGoogle', {
          reconnect: account.connectionId,
        });
        if (result.account === null) {
          onMessage(
            'error',
            result.error?.userMessage ?? 'The Google authorization did not complete.',
          );
          return;
        }
        await refresh();
        onChanged();
        onMessage(
          'ok',
          `${account.displayName} is authorized again. Run the capability check to confirm it.`,
        );
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
        onMessage(
          'error',
          `Choose a model for ${account.displayName} first — there is nothing to check until ` +
            'one is selected.',
        );
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

                {/* The way out of "no model selected". Shown only for the
                    account that has no model, because an account that has one
                    can be changed from the provider form above — and a second
                    always-visible picker would be two places to do one thing. */}
                {!account.modelId && picker?.connectionId !== account.connectionId ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy !== null}
                    onClick={() => void discover(account)}
                  >
                    {busy === account.connectionId ? 'Asking…' : 'Choose a model'}
                  </button>
                ) : null}

                {picker?.connectionId === account.connectionId && picker.models.length > 0 ? (
                  <label className="field">
                    <span>Model</span>
                    <select
                      defaultValue=""
                      disabled={busy !== null}
                      onChange={(event) => {
                        if (event.target.value.length > 0) {
                          void chooseModel(account, event.target.value);
                        }
                      }}
                    >
                      <option value="">Choose from what this account offers</option>
                      {picker.models.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {/* Said plainly. A restored connection has no credential, and
                    pretending otherwise fails at the first request instead. */}
                {account.statusReason ? (
                  <div className="field__hint field__hint--warning">{account.statusReason}</div>
                ) : null}
              </div>
              <div className="account-list__actions">
                {/* Shown only where it can work: an account connected with
                    Google whose authorization has stopped producing a
                    credential. For every other row it would be a button with
                    nothing to do. */}
                {account.authKind === 'oauth2' && account.status === 'disconnected' ? (
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy !== null}
                    onClick={() => void reauthorize(account)}
                  >
                    {busy === account.connectionId ? 'Waiting for Google…' : 'Authorize again'}
                  </button>
                ) : null}
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
