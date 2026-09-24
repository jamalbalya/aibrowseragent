import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { PanelResponse } from '@/messaging/protocol';

type Status = PanelResponse<'k1.status'>;

/**
 * Turning on, and living with, local protection for stored keys.
 *
 * The copy rules this follows, because a security feature people misread is
 * worse than one they never turn on:
 *
 *  - **No account language.** There is no sign-in here, nothing is uploaded,
 *    and nothing about this reaches anybody else's service. A passphrase is
 *    not a password for an account, and calling it one would suggest a
 *    recovery flow that does not and will not exist.
 *  - **The irreversibility is said before the field, not after.** A person
 *    deciding whether to do this needs it while deciding.
 *  - **No cryptographic detail.** No algorithm, no salt, no iteration count,
 *    no key id. None of it helps a person decide anything, and a diagnostics
 *    box full of it reads as a place to go looking for a key.
 *  - **What is protected is named exactly.** "Your AI account keys", not
 *    "your data" — because the rest of the user's data is *not* protected by
 *    this, and implying otherwise would be the most damaging thing on screen.
 */
export function ProtectionPanel(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [changing, setChanging] = useState(false);
  const [currentPassphrase, setCurrentPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await sendToBackground('k1.status', {}));
  }, []);

  useEffect(() => {
    // The state update happens after an await, which is what effects are for:
    // this synchronises the panel with the service worker rather than deriving
    // anything from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().catch(() => setMessage({ tone: 'error', text: 'Could not read the state.' }));
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<{ tone: 'ok' | 'error'; text: string }>) => {
      setBusy(true);
      setMessage(null);
      try {
        setMessage(await action());
      } catch (error) {
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Failed.' });
      } finally {
        // The passphrase leaves this component's state as soon as it has been
        // handed over, whatever happened. A field still holding it after a
        // failed attempt is a field somebody walks away from.
        setPassphrase('');
        setConfirmation('');
        setCurrentPassphrase('');
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  const enable = useCallback(
    () =>
      run(async () => {
        if (passphrase !== confirmation) {
          return { tone: 'error', text: 'The two passphrases are not the same.' };
        }
        const result = await sendToBackground('k1.enable', { passphrase });
        return result.ok
          ? {
              tone: 'ok',
              text:
                result.encrypted > 0
                  ? `Protected. ${result.encrypted} stored key(s) were locked away.`
                  : 'Protected. Keys you add from now on are locked away.',
            }
          : { tone: 'error', text: result.detail };
      }),
    [run, passphrase, confirmation],
  );

  const unlock = useCallback(
    () =>
      run(async () => {
        const result = await sendToBackground('k1.unlock', { passphrase });
        return result.ok
          ? { tone: 'ok', text: 'Unlocked for this browser session.' }
          : { tone: 'error', text: result.detail };
      }),
    [run, passphrase],
  );

  const lock = useCallback(
    () =>
      run(async () => {
        await sendToBackground('k1.lock', {});
        return {
          tone: 'ok',
          text: 'Locked. You will be asked again when you next use an AI account.',
        };
      }),
    [run],
  );

  /**
   * Changing the passphrase, which is the only remedy for one that may have
   * been seen.
   *
   * There is no reset and no recovery service, and switching protection off
   * and on again would write every protected record back to disk in
   * plaintext in between — so this has to exist, and it has to be the thing
   * people reach for.
   */
  const changePassphrase = useCallback(
    () =>
      run(async () => {
        if (passphrase !== confirmation) {
          return { tone: 'error', text: 'The two new passphrases are not the same.' };
        }
        const result = await sendToBackground('k1.changePassphrase', {
          current: currentPassphrase,
          next: passphrase,
        });
        setChanging(false);
        setCurrentPassphrase('');
        return result.ok
          ? { tone: 'ok', text: 'Passphrase changed. The old one no longer works.' }
          : { tone: 'error', text: result.detail };
      }),
    [run, currentPassphrase, passphrase, confirmation],
  );

  const disable = useCallback(
    () =>
      run(async () => {
        const result = await sendToBackground('k1.disable', { passphrase });
        return result.ok
          ? { tone: 'ok', text: 'Protection is off. Your keys are stored as they were before.' }
          : { tone: 'error', text: result.detail };
      }),
    [run, passphrase],
  );

  const state = status?.state ?? 'OFF';

  return (
    <section className="settings__section" data-testid="protection-panel">
      <h3>Protect your AI account keys</h3>

      {state === 'OFF' ? (
        <>
          <p className="field__hint" data-testid="protection-explainer">
            Your AI account keys are stored on this device. Anyone who can read the files in this
            Chrome profile — on a shared or stolen computer, or in a backup of it — can read them.
            Choosing a passphrase locks those keys away so that they cannot be.
          </p>
          <p className="field__hint" data-testid="protection-no-recovery">
            <strong>There is no way to recover this passphrase.</strong> It is never sent anywhere
            and it is not stored on this device, which is what makes it work. If you forget it, the
            keys it protects are gone and you will need to enter them again from your AI provider.
            There is no AI Browser Agent service that can reset it, because there is no AI Browser
            Agent service.
          </p>
          <p className="field__hint">
            Your workflows, shortcuts and settings are not affected and stay readable as they are.
          </p>

          <label className="field">
            <span>Passphrase</span>
            <input
              type="password"
              value={passphrase}
              autoComplete="new-password"
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="At least 8 characters"
            />
          </label>
          <label className="field">
            <span>Type it again</span>
            <input
              type="password"
              value={confirmation}
              autoComplete="new-password"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <div className="settings__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy || passphrase.length < 8}
              onClick={() => void enable()}
            >
              {busy ? 'Protecting…' : 'Protect my keys'}
            </button>
          </div>
        </>
      ) : null}

      {state === 'LOCKED' ? (
        <>
          <p className="field__hint" data-testid="protection-locked">
            Your AI account keys are locked. Enter your passphrase to use them in this browser
            session. Everything else keeps working.
          </p>
          <label className="field">
            <span>Passphrase</span>
            <input
              type="password"
              value={passphrase}
              autoComplete="current-password"
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          <div className="settings__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy || passphrase.length === 0}
              onClick={() => void unlock()}
            >
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </div>
        </>
      ) : null}

      {state === 'UNLOCKED' ? (
        <>
          <p className="field__hint" data-testid="protection-unlocked">
            Your AI account keys are protected and unlocked for this browser session. Closing Chrome
            locks them again.
          </p>
          <label className="field">
            <span>Passphrase (to switch protection off)</span>
            <input
              type="password"
              value={passphrase}
              autoComplete="current-password"
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
          {changing ? (
            <>
              <label className="field">
                <span>Current passphrase</span>
                <input
                  type="password"
                  value={currentPassphrase}
                  autoComplete="current-password"
                  onChange={(event) => setCurrentPassphrase(event.target.value)}
                />
              </label>
              <label className="field">
                <span>New passphrase</span>
                <input
                  type="password"
                  value={passphrase}
                  autoComplete="new-password"
                  onChange={(event) => setPassphrase(event.target.value)}
                  placeholder="At least 8 characters"
                />
              </label>
              <label className="field">
                <span>Type the new one again</span>
                <input
                  type="password"
                  value={confirmation}
                  autoComplete="new-password"
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <p className="field__hint">
                Your keys stay exactly where they are. Only the passphrase that opens them changes,
                and the old one stops working straight away.
              </p>
            </>
          ) : null}

          <div className="settings__actions">
            {changing ? (
              <button
                type="button"
                className="button button--primary"
                disabled={busy || passphrase.length < 8 || currentPassphrase.length === 0}
                onClick={() => void changePassphrase()}
              >
                {busy ? 'Changing…' : 'Change passphrase'}
              </button>
            ) : (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setChanging(true)}
                data-testid="protection-change"
              >
                Change passphrase
              </button>
            )}
            <button type="button" className="button" disabled={busy} onClick={() => void lock()}>
              Lock now
            </button>
            <button
              type="button"
              className="button button--danger"
              disabled={busy || passphrase.length === 0}
              onClick={() => void disable()}
            >
              Switch protection off
            </button>
          </div>
        </>
      ) : null}

      {state === 'NEEDS_RECOVERY' ? (
        <p className="message message--error" data-testid="protection-needs-recovery">
          The protection settings on this device are damaged, so your stored AI account keys cannot
          be read. Nothing has been deleted and nothing else is affected. Disconnect those AI
          accounts in Connected Accounts and add them again with a key from your provider.
        </p>
      ) : null}

      {message ? <p className={`message message--${message.tone}`}>{message.text}</p> : null}
    </section>
  );
}
