/**
 * What connecting this provider actually requires.
 *
 * ## Why a component rather than a sentence
 *
 * "Connect your Google account and use your AI models" is a reasonable thing
 * to want and a specific thing to promise, and the honest answer differs per
 * vendor. A single *Connect with Google* button above a list of providers
 * would imply that one Google consent reaches all of them. It does not reach
 * any of them but Google's own, and two of the others say in writing that it
 * must not: Anthropic prohibits a third party routing a Pro or Max plan, and
 * OpenAI's plan-sharing flow needs a loopback redirect an extension cannot
 * serve.
 *
 * So the button sits against the one provider it works for, every other
 * provider says what it needs instead, and the reasons travel with their
 * sources. The content is not written here — it comes from
 * `accounts.authMethods`, which reads one table — so the panel, the worker and
 * the documentation cannot come to describe the same vendor differently.
 *
 * ## What it does not claim
 *
 * That signing in with Google reveals a user's AI accounts. No vendor here
 * offers an API that, given a Google identity, returns the accounts that
 * identity holds elsewhere, and the panel says so where a user would
 * reasonably expect otherwise. Model discovery is a different thing and does
 * work — after a credential exists, against that credential's own endpoint.
 */
import { useCallback, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { PanelResponse } from '@/messaging/protocol';
import { Message } from './Message';

type AuthMethods = PanelResponse<'accounts.authMethods'>;

export interface AuthorizationMethodsProps {
  /** The provider the connect form is pointed at. */
  readonly providerId: string;
  readonly methods: AuthMethods | null;
  /** Called after a Google authorization connects an account. */
  readonly onConnected: (connectionId: string) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AuthorizationMethods({
  providerId,
  methods,
  onConnected,
}: AuthorizationMethodsProps): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const entry = methods?.providers.find((provider) => provider.providerId === providerId);

  const connectGoogle = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      // No login hint is sent. The panel holds no email address for this and
      // guessing one from a product sign-in would be asserting that the two
      // accounts are the same person's, which nothing here knows.
      const result = await sendToBackground('accounts.connectGoogle', {});
      if (result.account === null) {
        setNotice({
          tone: 'error',
          text: result.error?.userMessage ?? 'The Google authorization did not complete.',
        });
        return;
      }
      setNotice({
        tone: 'ok',
        text: 'Connected. Now choose a model from what this account can actually use.',
      });
      onConnected(result.account.connectionId);
    } catch (error) {
      setNotice({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  }, [onConnected]);

  if (!entry) return null;

  const google = entry.methods.find((method) => method.kind === 'google_oauth');

  return (
    <section className="auth-methods" aria-label={`How to connect ${entry.displayName}`}>
      <h4 className="auth-methods__title">Connecting {entry.displayName}</h4>

      {entry.methods.map((method) => (
        <div className="auth-methods__row" key={method.kind}>
          <p className="auth-methods__label">
            {method.label}
            {method.configured ? null : <span className="auth-methods__tag">not available</span>}
          </p>
          <p className="field__hint">{method.requires}</p>
          {method.unavailableReason ? (
            <p className="field__hint auth-methods__why">{method.unavailableReason}</p>
          ) : null}
          {method.page ? (
            <p className="field__hint">
              {/* Opened by the user. Nothing here fetches it, and the
                  extension never reads the account it leads to. */}
              <a href={method.page} target="_blank" rel="noreferrer noopener">
                Where to get one
              </a>
            </p>
          ) : null}
        </div>
      ))}

      {google ? (
        <div className="auth-methods__action">
          <button
            type="button"
            // The request for the optional `identity` permission has to come
            // from a user gesture, which is this click. Chrome refuses one
            // made any other way, and that refusal would read as a bug.
            onClick={() => void connectGoogle()}
            disabled={busy || !google.configured}
          >
            {busy ? 'Waiting for Google…' : 'Connect with Google'}
          </button>
          <p className="field__hint">
            This asks Chrome for permission to open Google’s sign-in window, then asks Google for
            access to the Gemini API. It does not sign you in to AI Browser Agent, and it is not
            required to use the extension.
          </p>
          {methods && !methods.identityPermissionGranted ? (
            <p className="field__hint">
              Chrome will ask first. You can decline, and you can withdraw it later from the
              extension’s permissions.
            </p>
          ) : null}
        </div>
      ) : null}

      {entry.unavailable.length > 0 ? (
        <details className="auth-methods__unavailable">
          <summary>What is not possible here, and why</summary>
          <ul>
            {entry.unavailable.map((item) => (
              <li key={item.label}>
                <strong>{item.label}.</strong> {item.reason}{' '}
                <a href={item.source} target="_blank" rel="noreferrer noopener">
                  Source
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {methods && !methods.accountDiscoveryFromGoogleIdentity ? (
        <p className="field__hint auth-methods__discovery">
          Connecting a Google account does not reveal AI accounts you hold anywhere else. No
          provider here offers that. Models <em>are</em> discovered — from the endpoint, once this
          account has a credential of its own.
        </p>
      ) : null}

      {/* The same component the rest of Settings uses, so a refusal here is
          announced the same way rather than inventing its own. */}
      <Message tone={notice?.tone ?? 'ok'} text={notice?.text} />
    </section>
  );
}
