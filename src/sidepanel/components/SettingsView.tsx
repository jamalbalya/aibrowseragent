import { useCallback, useEffect, useState } from 'react';
import { sendToBackground, MessagingError } from '@/messaging/bus';
import { AccountPanel } from './AccountPanel';
import { TechnicalDetails } from './TechnicalDetails';
import { DataPanel } from './DataPanel';
import { AboutLink } from './AboutLink';
import { ConnectedAccounts } from './ConnectedAccounts';
import { McpServers } from './McpServers';
import { SignInMethods } from './SignInMethods';
import { ProtectionPanel } from './ProtectionPanel';
import { WorkspaceView } from './WorkspaceView';
import type { CapabilityReport } from '@/providers/capability-doctor/capability-doctor';
import type { ProviderConnection } from '@/providers/registry/provider-registry';
import type { SitePolicyState } from '@/policy/site-policy';
import type { PanelResponse } from '@/messaging/protocol';
import { missingConnectors } from '@/sidepanel/connector-readiness';
import { endpointsFor, knownEndpoint } from '@/providers/registry/known-endpoints';

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
  /**
   * The known endpoint the user picked, if any.
   *
   * Only ever a *source of a default*. It is not stored on the account, not
   * sent anywhere, and not consulted again once the Base URL field holds a
   * value — the user can edit that field afterwards and this does not fight
   * them for it.
   */
  const [endpointId, setEndpointId] = useState('');
  const [apiKey, setApiKey] = useState('');
  // The model field defaults to whatever the stored connection uses, and
  // switches to the user's choice once they pick one. Deriving it avoids an
  // effect that would fight the user's typing.
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [models, setModels] = useState<
    readonly { id: string; displayName: string; upstreamKey?: string }[]
  >([]);
  /**
   * The upstream levels, when the connected provider has any.
   *
   * A gateway fronts several upstream providers at once, so choosing a model is
   * two choices. Empty for every provider that is not a gateway, and the model
   * field then behaves exactly as it did before.
   */
  const [groups, setGroups] = useState<
    readonly { key: string; displayName: string; kind: string; modelCount: number }[]
  >([]);
  /** How many catalogue entries the gateway offered that could not be used. */
  const [refusedModels, setRefusedModels] = useState(0);
  /**
   * The chosen upstream, by **key**.
   *
   * Never by display label: two upstreams can present the same label, and keying
   * on it would merge them and send the request to whichever won.
   */
  const [upstreamOverride, setUpstreamOverride] = useState<string | null>(null);
  // The account this form just created. The capability check and the model
  // selection that follows both belong to *that* account: running them
  // against the provider id instead was how a measurement ended up on the
  // pre-account settings slot while the account it was taken for kept none.
  const [connectionId, setConnectionId] = useState<string | null>(connection?.connectionId ?? null);

  /**
   * The upstream in effect: the user's choice, else the one that was persisted,
   * else the first group discovered.
   *
   * Derived rather than stored in an effect, for the same reason the model field
   * is: an effect would fight the user's selection.
   */
  const upstreamKey =
    upstreamOverride ?? connection?.upstreamKey ?? (groups.length > 0 ? groups[0]!.key : null);

  /**
   * The models under the chosen upstream.
   *
   * Filtered by `upstreamKey`, which each model carries. Nothing here reads the
   * model id: a gateway id contains `/` in the ordinary case and none at all for
   * a combination, so grouping by anything derived from the id would put a
   * combination nowhere and split a renamed alias in two.
   */
  const visibleModels =
    groups.length === 0 || upstreamKey === null
      ? models
      : models.filter((option) => option.upstreamKey === upstreamKey);
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [sitePolicy, setSitePolicy] = useState<SitePolicyState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadsGranted, setDownloadsGranted] = useState(false);
  const [notifications, setNotifications] = useState(true);
  const [connectors, setConnectors] = useState<PanelResponse<'connector.list'>['connectors']>([]);
  /**
   * Tokens typed into the form, per connector, before being sent.
   *
   * Held in component state and nowhere else: not in `localStorage`, not in a
   * ref that outlives the form, and cleared the moment the worker answers. The
   * input is `type="password"` so a screen share or a screenshot does not
   * carry it, and the value never reaches any route but `connector.connectToken`.
   */
  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<PanelResponse<'skill.list'>['skills']>([]);
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
        setConnectors((await sendToBackground('connector.list', {})).connectors);
        setSkills((await sendToBackground('skill.list', {})).skills);
        setNotifications((await sendToBackground('settings.getNotificationsEnabled', {})).enabled);
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
      // The same fields as before, now creating a *connected account* with its
      // own `connectionId` and its own credential key. Connecting a second
      // OpenAI key no longer overwrites the first: that was the whole point.
      const result = await sendToBackground('accounts.connect', {
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

      if (result.account) {
        setConnectionId(result.account.connectionId);
        const modelList = await sendToBackground('accounts.listModels', {
          connectionId: result.account.connectionId,
        });
        setModels(modelList.models);
        setGroups(modelList.groups ?? []);
        setRefusedModels(modelList.refused ?? 0);
        // A fresh catalogue may not contain the upstream a previous selection
        // used, so the derived default takes over rather than a stale override.
        setUpstreamOverride(null);
      }
      onChanged();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  }, [providerId, baseUrl, apiKey, model, onChanged]);

  const refreshConnectors = useCallback(async () => {
    setConnectors((await sendToBackground('connector.list', {})).connectors);
  }, []);

  /**
   * Starts an authorization.
   *
   * `includeWrite` is decided here, by the person, and never by the agent: a
   * connector authorised for read cannot later be talked into a write,
   * because the scope was never granted.
   */
  const authorizeConnector = useCallback(
    async (connectorId: string, includeWrite: boolean) => {
      setBusy('connector');
      setMessage(null);
      try {
        const result = await sendToBackground('connector.authorize', {
          connectorId,
          includeWrite,
        });
        setMessage(
          result.state === 'READY'
            ? { tone: 'ok', text: 'Connected.' }
            : { tone: 'error', text: `Not connected (${result.reason}).` },
        );
        await refreshConnectors();
      } catch (error) {
        setMessage({ tone: 'error', text: describe(error) });
      } finally {
        setBusy(null);
      }
    },
    [refreshConnectors],
  );

  /**
   * Connects with a token the user created in their own account.
   *
   * Separate from `authorizeConnector` because it is a different mechanism,
   * not a different argument: there is no flow, no redirect and no client id.
   * It exists because every one of the services on the roadmap requires a
   * client secret in its code exchange, and this extension must not hold one.
   *
   * The draft is cleared whatever happens, including on a failure. A token
   * that was refused is of no further use, and leaving it in the field invites
   * pressing the button again.
   */
  const connectWithToken = useCallback(
    async (connectorId: string) => {
      const token = (tokenDrafts[connectorId] ?? '').trim();
      if (token.length === 0) {
        setMessage({ tone: 'error', text: 'Paste the token before connecting.' });
        return;
      }
      setBusy('connector');
      setMessage(null);
      try {
        const result = await sendToBackground('connector.connectToken', { connectorId, token });
        setMessage(
          result.state === 'READY'
            ? {
                tone: 'ok',
                text:
                  `Connected${result.accountLabel ? ` as ${result.accountLabel}` : ''}. ` +
                  (result.scopesKnown
                    ? `Permissions: ${result.scopes.join(', ') || 'none'}.`
                    : 'The service did not report what this token may do, so reads will work ' +
                      'and writes will be refused rather than attempted.'),
              }
            : {
                tone: 'error',
                text:
                  result.reason === 'token_rejected'
                    ? 'That token was refused. Check it is current and try another.'
                    : result.reason === 'token_unverified'
                      ? 'The service could not be reached to check the token. Nothing was saved.'
                      : `Not connected (${result.reason}).`,
              },
        );
        await refreshConnectors();
      } catch (error) {
        setMessage({ tone: 'error', text: describe(error) });
      } finally {
        // Cleared on every path, including the error ones.
        setTokenDrafts((drafts) => ({ ...drafts, [connectorId]: '' }));
        setBusy(null);
      }
    },
    [refreshConnectors, tokenDrafts],
  );

  const disconnectConnector = useCallback(
    async (connectorId: string) => {
      setBusy('connector');
      try {
        await sendToBackground('connector.disconnect', { connectorId });
        await refreshConnectors();
        setMessage({ tone: 'ok', text: 'Disconnected.' });
      } catch (error) {
        setMessage({ tone: 'error', text: describe(error) });
      } finally {
        setBusy(null);
      }
    },
    [refreshConnectors],
  );

  /**
   * Runs the capability check against the connected account.
   *
   * Against the account rather than the provider id, because the measurement
   * has to land where the runtime will look for it. `accounts.runDoctor`
   * stamps the report onto the account with the (connection, model) pair it
   * was taken on, which is the only form `resolveProvider` will honour; the
   * provider-id route stored it on the pre-account settings slot, where the
   * panel could read "ready" from a measurement the runtime was ignoring.
   *
   * It also makes the account the one in use when the check passes, which is
   * what the old `provider.setActive` call was for.
   */
  const runDoctor = useCallback(async () => {
    if (!model) {
      setMessage({ tone: 'error', text: 'Enter or choose a model first.' });
      return;
    }
    if (!connectionId) {
      setMessage({ tone: 'error', text: 'Connect an AI account first.' });
      return;
    }
    setBusy('doctor');
    setMessage(null);
    try {
      const result = await sendToBackground(
        'accounts.runDoctor',
        { connectionId, modelId: model },
        // The doctor issues several real model round-trips.
        { timeoutMs: 180_000 },
      );
      setReport(result.report);
      if (result.report.readiness === 'AGENT_READY') {
        await sendToBackground('accounts.setBrain', {
          connectionId,
          // Exactly what was selected. Not a prefix, not a suffix, not trimmed.
          modelId: model,
          ...(upstreamKey === null ? {} : { upstreamKey }),
        });
      }
      onChanged();
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(null);
    }
  }, [connectionId, model, upstreamKey, onChanged]);

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

      <AccountPanel />

      {/* How you sign in. Deliberately above, and visually separate from, the
          AI accounts below: one governs identity, the other governs which AI
          brain the agent uses, and they must never read as one list. */}
      <SignInMethods />

      <DataPanel />

      <WorkspaceView onMessage={(tone, text) => setMessage({ tone, text })} />

      <ConnectedAccounts
        onMessage={(tone, text) => setMessage({ tone, text })}
        onChanged={onChanged}
      />

      <ProtectionPanel />

      <section className="settings__section">
        {/* The same form as before, unchanged, now reached as one way to add
            an account rather than as the only connection there can be.
            "Account" rather than "provider" because that is the thing the
            user already has and is about to point us at. */}
        <h3>Connect AI account</h3>

        <label className="field">
          <span>Provider</span>
          <select
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              // A URL typed for one provider must not be carried to the next:
              // the API key goes wherever this field points.
              setBaseUrlOverride(null);
              setEndpointId('');
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

        {/* Vendors that speak the protocol above, named so a user can find
            their own account without knowing which protocol it is. Each one
            only fills the editable field below; nothing here is a credential
            and nothing is forced. There is no adapter behind any of them that
            does not already exist. */}
        {endpointsFor(providerId).length > 0 ? (
          <>
            <label className="field">
              <span>Known endpoint (optional)</span>
              <select
                value={endpointId}
                onChange={(event) => {
                  const picked = knownEndpoint(event.target.value);
                  setEndpointId(event.target.value);
                  // Clearing the choice clears the default it supplied, and
                  // leaves anything the user typed alone.
                  if (picked) setBaseUrlOverride(picked.baseUrl);
                  setModels([]);
                }}
              >
                <option value="">Enter a base URL myself</option>
                {endpointsFor(providerId).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.displayName}
                  </option>
                ))}
              </select>
            </label>
            {knownEndpoint(endpointId) ? (
              <p className="field__hint">
                {knownEndpoint(endpointId)!.note}
                {knownEndpoint(endpointId)!.keyPage ? (
                  <>
                    {' '}
                    {/* Opened by the user. Nothing here fetches it, and the
                        extension never reads the account it leads to. */}
                    <a
                      href={knownEndpoint(endpointId)!.keyPage}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Create a key
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}

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
        {refusedModels > 0 ? (
          <p className="field__hint" data-testid="catalogue-refused">
            {refusedModels} entr{refusedModels === 1 ? 'y' : 'ies'} in this catalogue could not be
            used and {refusedModels === 1 ? 'is' : 'are'} not listed.
          </p>
        ) : null}

        {groups.length > 0 ? (
          <label className="field">
            <span>Upstream provider</span>
            <select
              value={upstreamKey ?? ''}
              data-testid="upstream-select"
              onChange={(event) => {
                setUpstreamOverride(event.target.value);
                // The model belonged to the previous upstream, so the choice is
                // cleared rather than carried across — silently keeping it would
                // show one upstream while sending a model from another.
                setModelOverride('');
              }}
            >
              {groups.map((group) => (
                // Keyed and valued by `key`, never by the label.
                <option key={group.key} value={group.key}>
                  {group.displayName} ({group.modelCount})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span>Model</span>
          {visibleModels.length > 0 ? (
            <select
              value={model}
              data-testid="model-select"
              onChange={(event) => setModelOverride(event.target.value)}
            >
              <option value="">Choose a model…</option>
              {visibleModels.map((option) => (
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
          {/* No Disconnect here. It called `provider.disconnect`, which
              clears the pre-account slot and its credential — and said "removed
              the stored key" while the account's own key, stored under its
              connection id, stayed exactly where it was. Connected Accounts
              above disconnects the account and its credential together, which
              is the only place that can honestly claim to. */}
        </div>

        {message ? <p className={`message message--${message.tone}`}>{message.text}</p> : null}
        {report ? <DoctorReport report={report} /> : null}
      </section>

      <McpServers onMessage={(tone, text) => setMessage({ tone, text })} />

      <section className="settings__section">
        <h3>Connectors</h3>
        <p className="field__hint">
          A connector lets the agent use an external service through its API instead of by driving
          its website. The extension never sees your password, and a connector receives only the
          permissions listed under it.
        </p>
        <p className="field__hint">
          Connectors here are authorised with a token you create in your own account, rather than
          with a sign-in flow. That is not a shortcut: every service on this build’s list requires a
          client secret to complete a sign-in flow, and a secret shipped inside an extension is
          readable by anyone who unzips it, so this build does not carry one. A token you issue
          yourself can be revoked by you at any time, in the same account page you made it in.
        </p>

        {connectors.length === 0 ? (
          <p className="field__hint">No connectors are available in this build.</p>
        ) : null}

        {connectors.map((connector) => (
          <div key={connector.id} className="connector">
            <div className="connector__header">
              <strong>{connector.displayName}</strong>
              <span className="connector__state">
                {connector.state === 'READY' ? 'Connected' : 'Not connected'}
              </span>
            </div>

            {Object.entries(connector.scopeRationale).map(([scope, why]) => (
              <p key={scope} className="field__hint">
                <code>{scope}</code> — {why}
              </p>
            ))}

            {connector.state === 'READY' ? (
              <div className="settings__actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy !== null}
                  onClick={() => void disconnectConnector(connector.id)}
                >
                  Disconnect
                </button>
              </div>
            ) : connector.tokenHint ? (
              <>
                <p className="field__hint">{connector.tokenHint.help}</p>
                <p className="field__hint">
                  {/* The user opens it. Nothing here fetches that page, and
                      the extension never reads the account it leads to. */}
                  <a href={connector.tokenHint.issuePage} target="_blank" rel="noreferrer noopener">
                    Create a token
                  </a>
                </p>
                <label className="field">
                  <span className="field__label">{connector.tokenHint.label}</span>
                  <input
                    className="field__input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={tokenDrafts[connector.id] ?? ''}
                    placeholder="Paste the token"
                    onChange={(event) =>
                      setTokenDrafts((drafts) => ({
                        ...drafts,
                        [connector.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="settings__actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={
                      busy !== null || (tokenDrafts[connector.id] ?? '').trim().length === 0
                    }
                    onClick={() => void connectWithToken(connector.id)}
                  >
                    Connect
                  </button>
                </div>
              </>
            ) : connector.configured ? (
              <div className="settings__actions">
                {/* Two buttons rather than a checkbox: the scope is the
                    decision, and it should be the thing being pressed. */}
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy !== null}
                  onClick={() => void authorizeConnector(connector.id, false)}
                >
                  Connect (read only)
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy !== null}
                  onClick={() => void authorizeConnector(connector.id, true)}
                >
                  Connect with write access
                </button>
              </div>
            ) : (
              <p className="field__hint">
                This build has no OAuth application registered for {connector.displayName}, so it
                cannot be connected. That is missing configuration, not a fault.
              </p>
            )}
          </div>
        ))}
      </section>

      <section className="settings__section">
        <h3>Workflows</h3>
        <p className="field__hint">
          A workflow is a fixed sequence of steps the agent can run in one go. Every step still asks
          for whatever it would have asked for on its own, so a workflow never turns several
          approvals into one.
        </p>
        <p className="field__hint">
          Workflows ship with the extension and cannot be added, edited or created while it is
          running — not by you, and not by the model.
        </p>

        {skills.length === 0 ? <p className="field__hint">This build ships no workflows.</p> : null}

        {skills.map((skill) => (
          <div key={`${skill.id}@${skill.version}`} className="skill">
            <div className="skill__header">
              <strong>{skill.name}</strong>
              <span className="skill__risk">{skill.risk}</span>
            </div>
            <p className="field__hint">{skill.description}</p>
            <p className="field__hint">
              {skill.steps} {skill.steps === 1 ? 'step' : 'steps'}, using{' '}
              {skill.tools.map((tool) => (
                <code key={tool}>{tool} </code>
              ))}
              {skill.connectors.length > 0 ? `via ${skill.connectors.join(', ')}` : null}
            </p>
            {/* Whether the connectors a skill needs are connected right now.
                Display only, and deliberately: the thing that decides whether
                a connector call may happen is the connector's own preflight,
                which refuses an operation on a connector that is not READY
                before anything is sent. A second place that decided it could
                drift from the first, and a skill list is not where authority
                belongs. What this fixes is only the order in which the user
                finds out — before approving a run rather than one step into
                it. */}
            {missingConnectors(skill.connectors, connectors).length > 0 ? (
              <p className="field__hint">
                Needs {missingConnectors(skill.connectors, connectors).join(', ')}, which{' '}
                {missingConnectors(skill.connectors, connectors).length === 1 ? 'is' : 'are'} not
                connected. Running it will stop at the first step that needs it.
              </p>
            ) : null}
            {/* Turning one off removes it everywhere at once: the agent stops
                being offered it, cannot run it by name, and a shortcut
                pointing at it stops resolving. */}
            <label className="skill__toggle">
              <input
                type="checkbox"
                checked={skill.enabled}
                data-testid={`skill-enabled-${skill.id}`}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void (async () => {
                    await sendToBackground('skill.setEnabled', {
                      skillId: skill.id,
                      skillVersion: skill.version,
                      enabled,
                    });
                    setSkills((await sendToBackground('skill.list', {})).skills);
                  })();
                }}
              />
              <span>{skill.enabled ? 'Available to the agent' : 'Turned off'}</span>
            </label>
          </div>
        ))}
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
        <h3>Notifications</h3>
        <p className="settings__hint">
          The agent tells you when it needs your approval, when a task ends, and what one of your
          scheduled tasks did. A notification says what happened and nothing about what the task
          read, typed or was told — it is drawn by your operating system, where this extension can
          no longer protect it.
        </p>
        <label className="skill__toggle">
          <input
            type="checkbox"
            checked={notifications}
            data-testid="notifications-enabled"
            onChange={(event) => {
              const next = event.target.checked;
              // Optimistic, then corrected from what the worker actually
              // stored: the checkbox must never claim a setting that failed
              // to save.
              setNotifications(next);
              sendToBackground('settings.setNotificationsEnabled', { enabled: next }).then(
                (result) => setNotifications(result.enabled),
                (error: unknown) => {
                  setNotifications(!next);
                  setMessage({ tone: 'error', text: describe(error) });
                },
              );
            }}
          />
          Show notifications
        </label>
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

      {/* Last, and collapsed. Diagnostics are not part of setting anything up. */}
      <section className="settings__section">
        <TechnicalDetails />
      </section>

      {/* An icon, and nothing else. The byline belongs to the store listing. */}
      <AboutLink />
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
