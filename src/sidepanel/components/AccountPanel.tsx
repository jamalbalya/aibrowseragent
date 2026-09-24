import { useCallback, useEffect, useRef, useState } from 'react';
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
 * show**, because the routes that feed it carry none of them: a token, a
 * provider API key, K1 key material, or the installation's own identifier.
 * That last one is deliberate: an opaque local label is not something anyone
 * needs to read.
 *
 * **What signing in is not.** It would authorise AI Browser Agent. It does not
 * connect, authorise or alter any AI account — those stay where they were,
 * each with its own key.
 *
 * ## The one-time code lives in this component and nowhere else
 *
 * `code` is React state on a view that closes. It is never written to storage
 * of any kind, never put on the URL, never logged, and never sent anywhere but
 * the verify route. The `challengeId` beside it is the same: held while the
 * code is being typed, discarded when the flow ends or the panel closes. An
 * in-flight sign-in that does not survive a closed panel is the correct
 * behaviour — asking for a new code costs one email.
 */

interface AuthStatus {
  readonly configured: boolean;
  readonly state: 'signed_out' | 'signed_in';
  readonly abaUserId: string | null;
  readonly email: string | null;
}

type Busy = 'idle' | 'signing-in' | 'signing-out' | 'sending-code' | 'verifying';

/**
 * Where the signed-out half of this panel is.
 *
 * A closed set rather than a handful of booleans, because the states are
 * mutually exclusive and a boolean pair can represent combinations that are
 * not real — "a code is being typed and no code has been sent" among them.
 */
type EmailStage =
  /** Nothing started. The address field and the Google button. */
  | { readonly kind: 'address' }
  /** A code has been sent; the person is typing it. */
  | {
      readonly kind: 'code';
      readonly challengeId: string;
      readonly address: string;
      readonly expiresAt: number;
      readonly resendAvailableAt: number;
    }
  /**
   * The challenge is finished and cannot be retried — expired, or every
   * attempt spent. The only way on is a new code.
   */
  | { readonly kind: 'ended'; readonly address: string; readonly reason: 'EXPIRED' | 'EXHAUSTED' };

export function AccountPanel(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<EmailStage>({ kind: 'address' });
  const [remaining, setRemaining] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const codeField = useRef<HTMLInputElement | null>(null);

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

  /**
   * A one-second tick, only while a code is outstanding.
   *
   * The countdown and the resend button both read a deadline, and a deadline
   * nothing re-renders is a deadline that appears frozen. The interval is
   * torn down as soon as the stage leaves `code`, so a panel sitting on any
   * other state schedules nothing.
   */
  useEffect(() => {
    if (stage.kind !== 'code') return undefined;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [stage.kind]);

  /** Returns the flow to its start, forgetting the code and the challenge. */
  const reset = useCallback(() => {
    setStage({ kind: 'address' });
    setCode('');
    setRemaining(null);
  }, []);

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

  const sendCode = useCallback(async (to: string) => {
    setBusy('sending-code');
    setMessage(null);
    try {
      const result = await sendToBackground('auth.startEmailSignIn', { email: to });
      if (!result.ok || result.challengeId === null) {
        setMessage(describeStartFailure(result.failure, result.retryAfterMs));
        return;
      }
      setCode('');
      setRemaining(null);
      setNow(Date.now());
      setStage({
        kind: 'code',
        challengeId: result.challengeId,
        address: to,
        expiresAt: result.expiresAt ?? Date.now(),
        resendAvailableAt: result.resendAvailableAt ?? Date.now(),
      });
      // Focus follows the step. A person who has just been told to check
      // their mail should be able to type the code without reaching for a
      // pointer.
      window.setTimeout(() => codeField.current?.focus(), 0);
    } catch {
      setMessage('A code could not be sent.');
    } finally {
      setBusy('idle');
    }
  }, []);

  const verify = useCallback(async () => {
    if (stage.kind !== 'code') return;
    setBusy('verifying');
    setMessage(null);
    try {
      const result = await sendToBackground('auth.verifyEmailSignIn', {
        challengeId: stage.challengeId,
        code,
      });
      if (result.ok) {
        // The code is dropped the moment it has served its purpose. It is not
        // kept for a retry, because there is nothing left to retry.
        setCode('');
        setStage({ kind: 'address' });
        setAddress('');
        await refresh();
        return;
      }
      if (result.failure === 'EXPIRED') {
        setStage({ kind: 'ended', address: stage.address, reason: 'EXPIRED' });
        setCode('');
      } else if (result.failure === 'ATTEMPTS_EXHAUSTED') {
        setStage({ kind: 'ended', address: stage.address, reason: 'EXHAUSTED' });
        setCode('');
      }
      setRemaining(result.remainingAttempts);
      setMessage(
        describeVerifyFailure(result.failure, result.remainingAttempts, result.retryAfterMs),
      );
    } catch {
      setMessage('That code could not be checked.');
    } finally {
      setBusy('idle');
    }
  }, [code, refresh, stage]);

  const signOut = useCallback(async () => {
    setBusy('signing-out');
    setMessage(null);
    try {
      await sendToBackground('auth.signOut', {});
      reset();
      await refresh();
    } catch {
      setMessage('Sign-out could not be completed.');
    } finally {
      setBusy('idle');
    }
  }, [refresh, reset]);

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

  const secondsLeft =
    stage.kind === 'code' ? Math.max(0, Math.ceil((stage.expiresAt - now) / 1000)) : 0;
  const resendIn =
    stage.kind === 'code' ? Math.max(0, Math.ceil((stage.resendAvailableAt - now) / 1000)) : 0;

  return (
    <section className="account" aria-label="AI Browser Agent account">
      <p className="account__status" data-testid="auth-signed-out">
        Not signed in
      </p>

      {stage.kind === 'address' ? (
        <form
          className="account__form"
          data-testid="auth-email-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode(address.trim());
          }}
        >
          <label className="account__label" htmlFor="auth-email">
            Email address
          </label>
          <input
            id="auth-email"
            className="input"
            data-testid="auth-email-input"
            type="email"
            autoComplete="email"
            value={address}
            disabled={busy !== 'idle'}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button
            type="submit"
            className="button"
            data-testid="auth-email-send"
            disabled={busy !== 'idle' || address.trim().length === 0}
          >
            {busy === 'sending-code' ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
      ) : null}

      {stage.kind === 'code' ? (
        <form
          className="account__form"
          data-testid="auth-code-form"
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <p className="account__note" data-testid="auth-code-sent">
            A six-digit code is on its way to {stage.address}.
          </p>
          <label className="account__label" htmlFor="auth-code">
            Code
          </label>
          <input
            id="auth-code"
            ref={codeField}
            className="input"
            data-testid="auth-code-input"
            // `text` with a numeric mode, not `number`: a number field strips
            // a leading zero, and a third of all codes start with one.
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            disabled={busy !== 'idle'}
            onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ''))}
          />
          <p className="account__note" data-testid="auth-code-expiry">
            {secondsLeft === 0
              ? 'This code has expired. Ask for another.'
              : `This code works for another ${formatDuration(secondsLeft)}.`}
          </p>
          {remaining === null ? null : (
            <p className="account__note" data-testid="auth-code-remaining">
              {remaining === 1 ? '1 try left.' : `${remaining} tries left.`}
            </p>
          )}
          <button
            type="submit"
            className="button"
            data-testid="auth-code-submit"
            disabled={busy !== 'idle' || code.length !== 6}
          >
            {busy === 'verifying' ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            data-testid="auth-code-resend"
            disabled={busy !== 'idle' || resendIn > 0}
            onClick={() => void sendCode(stage.address)}
          >
            {resendIn > 0 ? `Send another in ${formatDuration(resendIn)}` : 'Send another code'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            data-testid="auth-code-cancel"
            disabled={busy !== 'idle'}
            onClick={reset}
          >
            Use a different address
          </button>
        </form>
      ) : null}

      {stage.kind === 'ended' ? (
        <div className="account__form" data-testid="auth-code-ended">
          <p className="account__note">
            {stage.reason === 'EXPIRED'
              ? 'That code expired before it was used.'
              : 'That code was entered incorrectly too many times.'}
          </p>
          <button
            type="button"
            className="button"
            data-testid="auth-code-restart"
            disabled={busy !== 'idle'}
            onClick={() => void sendCode(stage.address)}
          >
            {busy === 'sending-code' ? 'Sending…' : 'Email me a new code'}
          </button>
          <button
            type="button"
            className="button button--ghost"
            data-testid="auth-code-cancel"
            disabled={busy !== 'idle'}
            onClick={reset}
          >
            Use a different address
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="button button--ghost"
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
      {message === null ? null : (
        <p className="account__error" data-testid="auth-error">
          {message}
        </p>
      )}
    </section>
  );
}

/** Seconds as something a person reads, not as a number of seconds. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
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

/**
 * What to say when a code was not sent.
 *
 * None of these reveals whether the address belongs to an account, because
 * the server never looked one up. `RATE_LIMITED` is the one that carries a
 * number, and it is the honest thing to show: a wait somebody can see through
 * is a wait they do not retry into.
 */
function describeStartFailure(failure: string | null, retryAfterMs: number | null): string {
  switch (failure) {
    case 'INVALID_EMAIL':
      return 'That does not look like an email address this can send to.';
    case 'RATE_LIMITED': {
      const seconds = Math.ceil((retryAfterMs ?? 0) / 1000);
      return seconds > 0
        ? `Too many codes have been requested. Try again in ${formatDuration(seconds)}.`
        : 'Too many codes have been requested. Try again shortly.';
    }
    case 'DELIVERY_FAILED':
      return 'The code could not be sent right now. Try again in a moment.';
    case 'NOT_CONFIGURED':
      return 'Signing in by email is not available on this build.';
    default:
      return 'A code could not be sent.';
  }
}

/** What to say when a code was not accepted. Every case is about this attempt. */
function describeVerifyFailure(
  failure: string | null,
  remainingAttempts: number | null,
  retryAfterMs: number | null,
): string {
  switch (failure) {
    case 'INVALID_CODE':
      return remainingAttempts === null
        ? 'That code is not right.'
        : `That code is not right. ${remainingAttempts === 1 ? '1 try left' : `${remainingAttempts} tries left`}.`;
    case 'EXPIRED':
      return 'That code has expired. Ask for another.';
    case 'ATTEMPTS_EXHAUSTED':
      return 'Too many wrong codes. Ask for a new one.';
    case 'RATE_LIMITED': {
      const seconds = Math.ceil((retryAfterMs ?? 0) / 1000);
      return seconds > 0
        ? `Too many attempts. Try again in ${formatDuration(seconds)}.`
        : 'Too many attempts. Try again shortly.';
    }
    case 'DIFFERENT_USER':
      return 'This browser already holds another AI Browser Agent user’s data. Remove it explicitly before signing in as someone else.';
    case 'NOT_CONFIGURED':
      return 'Signing in by email is not available on this build.';
    case 'UNAVAILABLE':
      return 'That address cannot be used to sign in here.';
    default:
      return 'That code could not be checked.';
  }
}
