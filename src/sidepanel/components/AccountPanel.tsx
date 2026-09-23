import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';

/**
 * How this installation is being used, and — where a build offers it — signing
 * in.
 *
 * **The first branch is the one people actually see.** The extension is
 * standalone: it works on this device with no account, and every shipped build
 * has no sign-in to offer. So that state is written as what it is — a complete
 * way to use the product — rather than as a feature that is missing.
 *
 * The distinction is not cosmetic. "Signing in is not available" describes the
 * software's limitation; "you're using it on this device" describes the user's
 * situation, and only one of those is the thing they need to know. Nothing
 * here invents a local account to fill the gap either: there is no account,
 * and saying there is one would be a worse lie than the one it replaced.
 *
 * **What it shows.** Whether this device is being used on its own, and — when
 * a build has sign-in — the address you signed in with. **What it cannot
 * show**, because the route that feeds it carries none of them: a token, a
 * provider API key, K1 key material, or the installation's own identifier.
 * That last one is deliberate: an opaque local label is not something anyone
 * needs to read.
 *
 * **What signing in is not.** It would authorise AI Browser Agent. It does not
 * connect, authorise or alter any AI account — those stay where they were,
 * each with its own key.
 */

interface AuthStatus {
  readonly configured: boolean;
  readonly state: 'signed_out' | 'signed_in';
  readonly abaUserId: string | null;
  readonly email: string | null;
}

type Busy = 'idle' | 'signing-in' | 'signing-out';

export function AccountPanel(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await sendToBackground('auth.status', {}));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    // The first read of the account state. Same pattern as the neighbouring
    // panels: the load is asynchronous, so the state it produces necessarily
    // lands after the effect runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async () => {
    setBusy('signing-in');
    setMessage(null);
    try {
      const result = await sendToBackground('auth.signInWithGoogle', {});
      // The failure codes are safe by construction: none of them says whether
      // an account exists, so none is worth translating into a hint.
      if (!result.ok) setMessage(describeFailure(result.failure));
      await refresh();
    } catch {
      setMessage('Sign-in could not be completed.');
    } finally {
      setBusy('idle');
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    setBusy('signing-out');
    setMessage(null);
    try {
      await sendToBackground('auth.signOut', {});
      await refresh();
    } catch {
      setMessage('Sign-out could not be completed.');
    } finally {
      setBusy('idle');
    }
  }, [refresh]);

  if (status === null) {
    return (
      <section className="account" aria-label="This device">
        {/* Neutral on purpose: until `configured` is known, saying "checking
            your account" would announce an account to somebody who has none. */}
        <p className="account__status">Just a moment…</p>
      </section>
    );
  }

  if (!status.configured) {
    return (
      <section className="account" aria-label="This device">
        <p className="account__status" data-testid="auth-local-only">
          You’re using AI Browser Agent on this device.
        </p>
        <p className="account__note">
          Your work is stored here. No account is needed, and nothing is sent to us — AI Browser
          Agent has no service of its own to send it to.
        </p>
      </section>
    );
  }

  if (status.state === 'signed_in') {
    return (
      <section className="account" aria-label="AI Browser Agent account">
        <p className="account__status" data-testid="auth-signed-in">
          Signed in{status.email === null ? '' : ` as ${status.email}`}
        </p>
        <button
          type="button"
          className="button button--ghost"
          data-testid="auth-sign-out"
          disabled={busy !== 'idle'}
          onClick={() => void signOut()}
        >
          Sign out
        </button>
        <p className="account__note">
          Signing out ends this session. It removes nothing — your connected AI accounts, their keys
          and everything you have made stay exactly where they are.
        </p>
        {message === null ? null : <p className="account__error">{message}</p>}
      </section>
    );
  }

  return (
    <section className="account" aria-label="AI Browser Agent account">
      <p className="account__status" data-testid="auth-signed-out">
        Not signed in
      </p>
      <button
        type="button"
        className="button"
        data-testid="auth-sign-in-google"
        disabled={busy !== 'idle'}
        onClick={() => void signIn()}
      >
        {busy === 'signing-in' ? 'Signing in…' : 'Sign in with Google'}
      </button>
      <p className="account__note">
        This signs you in to AI Browser Agent only. It does not connect or authorise OpenAI,
        Anthropic, Gemini or any other AI account — those are connected separately, each with its
        own key.
      </p>
      {message === null ? null : <p className="account__error">{message}</p>}
    </section>
  );
}

function describeFailure(failure: string | null): string {
  switch (failure) {
    case 'CANCELLED':
      return 'Sign-in was not completed.';
    case 'NOT_CONFIGURED':
      return 'There is nothing to sign in to — this device is all you need.';
    case 'DIFFERENT_USER':
      return 'This browser already holds another AI Browser Agent user’s data. Remove it explicitly before signing in as someone else.';
    default:
      return 'Sign-in could not be completed.';
  }
}
