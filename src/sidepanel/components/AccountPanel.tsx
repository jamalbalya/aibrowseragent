import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';

/**
 * The AI Browser Agent account: signed out, signed in, sign out.
 *
 * Deliberately small. This phase adds Google sign-in and nothing else, so the
 * panel gains one block rather than a redesign.
 *
 * **What it shows.** Whether you are signed in, and the address you signed in
 * with. **What it cannot show**, because the route that feeds it carries
 * neither: a token of any kind, a provider API key, or any K1 key material.
 *
 * **What signing in is not.** It authorises AI Browser Agent. It does not
 * connect, authorise or alter any AI provider — those stay where they were,
 * under Connected AI Accounts, each with its own credential. The copy says so
 * rather than leaving it to be inferred.
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
      <section className="account" aria-label="AI Browser Agent account">
        <p className="account__status">Checking your account…</p>
      </section>
    );
  }

  if (!status.configured) {
    return (
      <section className="account" aria-label="AI Browser Agent account">
        <p className="account__status" data-testid="auth-unavailable">
          Signing in is not available in this build.
        </p>
        <p className="account__note">
          Your connected AI accounts and everything you have made keep working without it.
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
        Anthropic, Gemini or any other AI provider — those are connected separately, each with its
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
      return 'Signing in is not available in this build.';
    case 'DIFFERENT_USER':
      return 'This browser already holds another AI Browser Agent user’s data. Remove it explicitly before signing in as someone else.';
    default:
      return 'Sign-in could not be completed.';
  }
}
