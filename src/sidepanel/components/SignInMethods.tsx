import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';

/**
 * How you sign in to AI Browser Agent — and **not** which AI you use.
 *
 * That distinction is the reason this is a component of its own rather than
 * more rows inside the AI accounts list. The two look superficially alike —
 * both are "things you connect" — and conflating them would be a genuine
 * safety problem, not a presentational one: a person who believed that
 * removing a sign-in method disconnected their OpenAI key, or that adding
 * Google here gave the agent a Claude subscription, would make decisions
 * about their credentials on a false model.
 *
 * So the wording is explicit in both directions. This section says what it
 * governs and says what it does not touch; `ConnectedAccounts` is a separate
 * section under a separate heading with its own keys.
 *
 * **Nothing here can change which account you are signed in as.** Linking
 * attaches a second way in to the account you already have. The routes issue
 * no session, and the panel holds no token — the only things it receives are
 * an opaque identity id, an address for display, and whether removal is
 * currently allowed.
 */

interface LinkedIdentity {
  readonly id: string;
  readonly kind: 'google' | 'email';
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly linkedAt: number;
  readonly lastUsedAt: number | null;
  readonly removable: boolean;
}

type Busy = 'idle' | 'listing' | 'linking-google' | 'sending-code' | 'verifying' | 'detaching';

/** Where the email-linking sub-flow is. Closed set, so no impossible pair. */
type EmailStage =
  | { readonly kind: 'closed' }
  | { readonly kind: 'address' }
  | { readonly kind: 'code'; readonly challengeId: string; readonly address: string };

export function SignInMethods(): React.JSX.Element | null {
  const [identities, setIdentities] = useState<readonly LinkedIdentity[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState<Busy>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [stage, setStage] = useState<EmailStage>({ kind: 'closed' });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await sendToBackground('identities.list', {});
      if (result.ok) {
        setIdentities(result.identities);
        setAvailable(true);
        return;
      }
      // Not signed in, or a build with no backend. Either way there is no
      // account whose sign-in methods could be shown, and saying so is the
      // honest answer rather than an empty list that looks like a loss.
      setIdentities(null);
      setAvailable(false);
    } catch {
      setIdentities(null);
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const linkGoogle = useCallback(async () => {
    setBusy('linking-google');
    setMessage(null);
    try {
      const result = await sendToBackground('identities.linkGoogle', {});
      if (!result.ok) setMessage(describeLinkFailure(result.failure));
      await refresh();
    } catch {
      setMessage('That sign-in method could not be added.');
    } finally {
      setBusy('idle');
    }
  }, [refresh]);

  const sendCode = useCallback(async () => {
    setBusy('sending-code');
    setMessage(null);
    try {
      const result = await sendToBackground('identities.startEmailLink', {
        email: address.trim(),
      });
      if (!result.ok || result.challengeId === null) {
        setMessage(describeLinkFailure(result.failure));
        return;
      }
      setCode('');
      setStage({ kind: 'code', challengeId: result.challengeId, address: address.trim() });
    } catch {
      setMessage('A code could not be sent.');
    } finally {
      setBusy('idle');
    }
  }, [address]);

  const verifyCode = useCallback(async () => {
    if (stage.kind !== 'code') return;
    setBusy('verifying');
    setMessage(null);
    try {
      const result = await sendToBackground('identities.completeEmailLink', {
        challengeId: stage.challengeId,
        code,
      });
      if (!result.ok) {
        setMessage(describeLinkFailure(result.failure));
        return;
      }
      // The code has served its purpose and is dropped; the sub-flow closes.
      setCode('');
      setAddress('');
      setStage({ kind: 'closed' });
      await refresh();
    } catch {
      setMessage('That code could not be checked.');
    } finally {
      setBusy('idle');
    }
  }, [code, refresh, stage]);

  const detach = useCallback(
    async (identityId: string) => {
      setBusy('detaching');
      setMessage(null);
      try {
        const result = await sendToBackground('identities.detach', { identityId });
        if (!result.ok) {
          setMessage(describeDetachFailure(result.failure));
        } else if (result.revokedSessions > 0) {
          // Removing the method you are currently signed in with ends this
          // session. Said plainly, because the next thing the person sees is
          // a sign-in screen and an unexplained one looks like a fault.
          setMessage(
            'That sign-in method was removed. It was the one this session was started with, so you have been signed out.',
          );
        }
        await refresh();
      } catch {
        setMessage('That sign-in method could not be removed.');
      } finally {
        setBusy('idle');
      }
    },
    [refresh],
  );

  // A build with no backend, or nobody signed in. There is no account, so
  // there is nothing to render — the account block above already explains
  // the standalone state, and a second empty panel would only add noise.
  if (!available || identities === null) return null;

  return (
    <section className="settings__section" aria-label="Sign-in methods">
      <h3>Sign-in methods</h3>
      <p className="settings__hint">
        How you sign in to AI Browser Agent. These are <strong>not</strong> your AI accounts — the
        providers you connect below keep their own keys and are unaffected by anything here.
      </p>

      <ul className="identity-list" data-testid="identity-list">
        {identities.map((identity) => (
          <li key={identity.id} className="identity-list__item" data-testid="identity-row">
            <span className="identity-list__kind">
              {identity.kind === 'google' ? 'Google' : 'Email'}
            </span>
            <span className="identity-list__label">
              {identity.email ?? 'Signed in with Google'}
            </span>
            {identity.removable ? (
              <button
                type="button"
                className="button button--ghost"
                data-testid="identity-remove"
                disabled={busy !== 'idle'}
                onClick={() => void detach(identity.id)}
              >
                Remove
              </button>
            ) : (
              <span className="identity-list__note" data-testid="identity-last">
                This is the only way you can sign in, so it cannot be removed. Add another first.
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="identity-add">
        <button
          type="button"
          className="button button--ghost"
          data-testid="identity-add-google"
          disabled={busy !== 'idle'}
          onClick={() => void linkGoogle()}
        >
          {busy === 'linking-google' ? 'Opening Google…' : 'Add Google'}
        </button>

        {stage.kind === 'closed' ? (
          <button
            type="button"
            className="button button--ghost"
            data-testid="identity-add-email"
            disabled={busy !== 'idle'}
            onClick={() => setStage({ kind: 'address' })}
          >
            Add an email address
          </button>
        ) : null}
      </div>

      {stage.kind === 'address' ? (
        <form
          className="identity-add__form"
          data-testid="identity-email-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode();
          }}
        >
          <label className="account__label" htmlFor="identity-email">
            Email address to add
          </label>
          <input
            id="identity-email"
            className="input"
            data-testid="identity-email-input"
            type="email"
            autoComplete="email"
            value={address}
            disabled={busy !== 'idle'}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button
            type="submit"
            className="button"
            data-testid="identity-email-send"
            disabled={busy !== 'idle' || address.trim().length === 0}
          >
            {busy === 'sending-code' ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
      ) : null}

      {stage.kind === 'code' ? (
        <form
          className="identity-add__form"
          data-testid="identity-code-form"
          onSubmit={(event) => {
            event.preventDefault();
            void verifyCode();
          }}
        >
          <p className="settings__hint" data-testid="identity-code-sent">
            A six-digit code is on its way to {stage.address}. Entering it proves the mailbox is
            yours and adds it as a way to sign in.
          </p>
          <label className="account__label" htmlFor="identity-code">
            Code
          </label>
          <input
            id="identity-code"
            className="input"
            data-testid="identity-code-input"
            // `text` with a numeric mode: a number field strips a leading
            // zero, and a tenth of all codes start with one.
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            disabled={busy !== 'idle'}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
          />
          <button
            type="submit"
            className="button"
            data-testid="identity-code-submit"
            disabled={busy !== 'idle' || code.length !== 6}
          >
            {busy === 'verifying' ? 'Checking…' : 'Add this address'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            data-testid="identity-code-cancel"
            disabled={busy !== 'idle'}
            onClick={() => {
              setCode('');
              setStage({ kind: 'closed' });
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}

      {message === null ? null : (
        <p className="account__error" data-testid="identity-message">
          {message}
        </p>
      )}
    </section>
  );
}

/**
 * What to say when a link did not happen.
 *
 * `IDENTITY_IN_USE` is the one worth its own sentence, and the sentence is
 * careful: it says the method is in use somewhere, never where, never by
 * whom, and never that any particular account exists.
 */
function describeLinkFailure(failure: string | null): string {
  switch (failure) {
    case 'IDENTITY_IN_USE':
      return 'That sign-in method is already used by another AI Browser Agent account. It cannot be added here.';
    case 'CANCELLED':
      return 'That was not completed.';
    case 'INVALID_EMAIL':
      return 'That does not look like an email address this can send to.';
    case 'INVALID_CODE':
      return 'That code is not right.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Try again shortly.';
    case 'DELIVERY_FAILED':
      return 'The code could not be sent right now. Try again in a moment.';
    case 'NOT_SIGNED_IN':
      return 'Sign in first, then you can add another way to sign in.';
    case 'NOT_CONFIGURED':
      return 'Sign-in methods are not available on this build.';
    default:
      return 'That sign-in method could not be added.';
  }
}

function describeDetachFailure(failure: string | null): string {
  switch (failure) {
    case 'LAST_IDENTITY':
      return 'This is the only way you can sign in, so it cannot be removed. Add another first.';
    case 'NOT_FOUND':
      return 'That sign-in method is no longer there.';
    case 'NOT_SIGNED_IN':
      return 'Sign in first.';
    default:
      return 'That sign-in method could not be removed.';
  }
}
