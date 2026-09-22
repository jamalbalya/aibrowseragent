import { useCallback, useEffect, useState } from 'react';
import { sendToBackground, MessagingError } from '@/messaging/bus';
import type { CapabilityReport } from '@/providers/capability-doctor/capability-doctor';
import type { ProviderConnection } from '@/providers/registry/provider-registry';
import type { SitePolicyState } from '@/policy/site-policy';

interface SettingsViewProps {
  readonly connection: ProviderConnection | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

interface ProviderOption {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly baseUrlRequired: boolean;
  readonly defaultBaseUrl?: string;
}

/**
 * Settings.
 *
 * The connection flow follows specification section 16: choose provider,
 * authenticate, choose model, run the capability doctor. The doctor's verdict
 * is reported verbatim — a failed check is shown as failed rather than being
 * smoothed over.
 */
export function SettingsView({
  connection,
  onClose,
  onChanged,
}: SettingsViewProps): React.JSX.Element {
  const [providers, setProviders] = useState<readonly ProviderOption[]>([]);
  const [providerId, setProviderId] = useState('');
  // Empty until a provider is chosen. A provider with its own documented
  // endpoint does not need one, and pre-filling another provider's URL would
  // invite sending a key somewhere it does not belong.
  const [baseUrlOverride, setBaseUrlOverride] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  // The model field defaults to whatever the stored connection uses, and
  // switches to the user's choice once they pick one. Deriving it avoids an
  // effect that would fight the user's typing.
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [models, setModels] = useState<readonly { id: string; displayName: string }[]>([]);
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [sitePolicy, setSitePolicy] = useState<SitePolicyState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadsGranted, setDownloadsGranted] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const model = modelOverride ?? connection?.modelId ?? '';
  const provider = providers.find((p) => p.id === providerId);
  const baseUrl = baseUrlOverride ?? provider?.defaultBaseUrl ?? '';

  useEffect(() => {
    void (async () => {
      try {
        const [list, policy] = await Promise.all([
          sendToBackground('provider.list', {}),
          sendToBackground('policy.getSitePolicy', {}),
        ]);
        setProviders(list.providers);
        setSitePolicy(policy.state);
        setDownloadsGranted((await sendToBackground('file.downloadsPermission', {})).granted);
        setProviderId((current) => current || (list.providers[0]?.id ?? ''));
      } catch (error) {
        setMessage({ tone: 'error', text: describe(error) });
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    setBusy('connect');
    setMessage(null);
    try {
      const result = await sendToBackground('provider.connect', {
        providerId,
        // Omitted rather than sent empty, so the adapter applies its own
        // documented default instead of being handed a blank endpoint.
        ...(baseUrl.trim().length === 0 ? {} : { baseUrl }),
        apiKey,
        model,
      });
      if (result.error) {
        setMessage({ tone: 'error', text: result.error.userMessage });
        return;
      }
      // The key is now held by the service worker's credential store; drop the
      // copy in this component so it does not sit in the panel's memory.
      setApiKey('');
      setMessage({ tone: 'ok', text: 'Connected. Now choose a model and run the check.' });

      const modelList = await sendToBackground('provider.listModels', { providerId });
      setModels(modelList.models);
      onChanged();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  }, [providerId, baseUrl, apiKey, model, onChanged]);

  const runDoctor = useCallback(async () => {
    if (!model) {
      setMessage({ tone: 'error', text: 'Enter or choose a model first.' });
      return;
    }
    setBusy('doctor');
    setMessage(null);
    try {
      const result = await sendToBackground(
        'provider.runDoctor',
        { providerId, modelId: model },
        // The doctor issues several real model round-trips.
        { timeoutMs: 180_000 },
      );
      setReport(result.report);
      if (result.report.readiness === 'AGENT_READY') {
        await sendToBackground('provider.setActive', { providerId, modelId: model });
      }
      onChanged();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  }, [providerId, model, onChanged]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    try {
      await sendToBackground('provider.disconnect', { providerId });
      setReport(null);
      setModels([]);
      setMessage({ tone: 'ok', text: 'Disconnected and removed the stored key.' });
      onChanged();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  }, [providerId, onChanged]);

  const removeSite = useCallback(async (site: string) => {
    try {
      const result = await sendToBackground('policy.removeSiteRule', { site });
      setSitePolicy(result.state);
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    }
  }, []);

  return (
    <div className="settings">
      <div className="settings__header">
        <h2>Settings</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Done
        </button>
      </div>

      <section className="settings__section">
        <h3>AI provider</h3>

        <label className="field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              // A URL typed for one provider must not be carried to the next:
              // the API key goes wherever this field points.
              setBaseUrlOverride(null);
              setModels([]);
            }}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>
        </label>
        {provider ? <p className="field__hint">{provider.description}</p> : null}

        <label className="field">
          <span>{provider?.baseUrlRequired === false ? 'Base URL (optional)' : 'Base URL'}</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrlOverride(event.target.value)}
            placeholder={provider?.defaultBaseUrl ?? 'https://api.openai.com/v1'}
          />
        </label>
        {provider?.baseUrlRequired === false ? (
          <p className="field__hint">
            Leave this as it is unless you route this provider through your own gateway.
          </p>
        ) : null}

        <label className="field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={connection ? 'Stored — enter a new key to replace it' : 'sk-…'}
          />
        </label>
        <p className="field__hint">
          The key is stored by the extension and sent only to the base URL above. It is never
          included in logs, evidence or model prompts.
        </p>

        <label className="field">
          <span>Model</span>
          {models.length > 0 ? (
            <select value={model} onChange={(event) => setModelOverride(event.target.value)}>
              <option value="">Choose a model…</option>
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(event) => setModelOverride(event.target.value)}
              placeholder="gpt-4o-mini"
            />
          )}
        </label>

        <div className="settings__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={busy !== null}
            onClick={() => void connect()}
          >
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => void runDoctor()}
          >
            {busy === 'doctor' ? 'Checking…' : 'Run capability check'}
          </button>
          {connection ? (
            <button
              type="button"
              className="button button--danger"
              disabled={busy !== null}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          ) : null}
        </div>

        {message ? <p className={`message message--${message.tone}`}>{message.text}</p> : null}
        {report ? <DoctorReport report={report} /> : null}
      </section>

      <section className="settings__section">
        <h3>Downloads</h3>
        <p className="field__hint">
          Saving a file needs Chrome’s downloads permission. It is off until you turn it on, and the
          agent cannot request it for you — this button has to be pressed by you. Files are saved to
          your normal download folder under a plain name; the agent cannot choose a folder, and it
          will not download programs, installers, scripts or browser extensions.
        </p>
        <div className="settings__actions">
          {downloadsGranted ? (
            <span className="field__hint">Granted.</span>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() => {
                // Must run inside the click handler: Chrome only honours a
                // permission request made during a user gesture.
                chrome.permissions.request({ permissions: ['downloads'] }).then(
                  (granted) => {
                    setDownloadsGranted(granted);
                    if (!granted) {
                      setMessage({ tone: 'error', text: 'The downloads permission was declined.' });
                    }
                  },
                  () => setMessage({ tone: 'error', text: 'Chrome refused the request.' }),
                );
              }}
            >
              Allow downloads
            </button>
          )}
        </div>
      </section>

      <section className="settings__section">
        <h3>Site permissions</h3>
        {sitePolicy && sitePolicy.rules.length > 0 ? (
          <ul className="sites">
            {sitePolicy.rules.map((rule) => (
              <li key={rule.site} className="sites__row">
                <span>
                  <strong>{rule.site}</strong> — {rule.decision} up to {rule.maxRisk}
                </span>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => void removeSite(rule.site)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="field__hint">
            No standing site approvals. Approvals you grant with “Always allow on this site” appear
            here.
          </p>
        )}
      </section>
    </div>
  );
}

function DoctorReport({ report }: { readonly report: CapabilityReport }): React.JSX.Element {
  return (
    <div className={`doctor doctor--${report.readiness.toLowerCase()}`}>
      <h4>{readinessLabel(report.readiness)}</h4>
      <p className="doctor__summary">{report.summary}</p>
      <ul className="doctor__checks">
        {report.checks.map((check) => (
          <li key={check.id} className={`doctor__check doctor__check--${check.status}`}>
            <span className="doctor__label">{check.label}</span>
            <span className="doctor__status">{check.status.toUpperCase()}</span>
            {check.detail ? <span className="doctor__detail">{check.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function readinessLabel(readiness: CapabilityReport['readiness']): string {
  switch (readiness) {
    case 'AGENT_READY':
      return 'Agent ready';
    case 'CONNECTED_LIMITED':
      return 'Connected — limited';
    case 'CHAT_ONLY':
      return 'Chat only — cannot run browser tasks';
    case 'FAILED':
      return 'Failed';
  }
}

function describe(error: unknown): string {
  if (error instanceof MessagingError) return error.agentError.userMessage;
  return error instanceof Error ? error.message : String(error);
}
