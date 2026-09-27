/**
 * MCP servers the user has added (P-026).
 *
 * Three things this shows rather than hides, each because the alternative would
 * be a screen that reads as more reassuring than the product is.
 *
 *  - **What a server actually contributed, and what it did not.** A tool whose
 *    arguments this build will not compile is named with the reason. The user's
 *    own MCP client may show that tool working, so "it is missing and nobody
 *    said why" is the wrong outcome.
 *  - **That every call is confirmed.** Adding a server is not a grant. The
 *    copy says so in the same place the button is, because a person who thinks
 *    they have authorised something is a person who stops reading prompts.
 *  - **A server that did not answer.** Named with its failure rather than shown
 *    as offering nothing, which is a different fact.
 *
 * There is no "connected" indicator, and its absence is deliberate: a server's
 * tools are a fresh reading on every worker start rather than a state, so a
 * green dot would be describing the last time somebody looked.
 */
import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { PanelResponse } from '@/messaging/protocol';

interface McpServersProps {
  readonly onMessage: (tone: 'ok' | 'error', text: string) => void;
}

type ServerList = PanelResponse<'mcp.list'>['servers'];

export function McpServers({ onMessage }: McpServersProps): React.JSX.Element {
  const [servers, setServers] = useState<ServerList>([]);
  const [id, setId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setServers((await sendToBackground('mcp.list', {})).servers);
  }, []);

  useEffect(() => {
    // Synchronises the panel with the service worker, which is what effects
    // are for. The state update happens after an await, not in the body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const add = useCallback(async () => {
    setBusy('add');
    try {
      const result = await sendToBackground('mcp.add', { id, displayName, url });
      if (!result.added) {
        // The validator's own sentences, so the user is told which part was
        // wrong rather than that "something" was.
        onMessage(
          'error',
          result.problems.length > 0
            ? `That server was not added: ${result.problems.join('; ')}.`
            : `That server was not added (${result.reason}).`,
        );
        return;
      }
      const refusedCount = result.refused.length;
      onMessage(
        'ok',
        `${displayName} added. ${result.registered.length} tool${
          result.registered.length === 1 ? '' : 's'
        } available` + (refusedCount > 0 ? `, ${refusedCount} not usable by this extension.` : '.'),
      );
      setId('');
      setDisplayName('');
      setUrl('');
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [displayName, id, onMessage, refresh, url]);

  const remove = useCallback(
    async (serverId: string) => {
      setBusy(serverId);
      try {
        const result = await sendToBackground('mcp.remove', { id: serverId });
        onMessage(
          'ok',
          result.removed
            ? `Removed. Its ${result.unregistered.length} tool${
                result.unregistered.length === 1 ? '' : 's'
              } are gone with it.`
            : 'That server was already gone.',
        );
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [onMessage, refresh],
  );

  const recheck = useCallback(async () => {
    setBusy('refresh');
    try {
      await sendToBackground('mcp.refresh', {});
      await refresh();
      onMessage('ok', 'Every server was asked again.');
    } finally {
      setBusy(null);
    }
  }, [onMessage, refresh]);

  return (
    <section className="settings__section">
      <h3>MCP servers</h3>
      <p className="field__hint">
        An MCP server is a service somebody else runs that offers the agent extra tools. The
        extension connects out to it over HTTPS; nothing connects in.
      </p>
      <p className="field__hint">
        Adding a server is not permission to use it. Every call to one of its tools is confirmed
        first, every time, in every permission mode — including a read, because the arguments leave
        your browser either way. A scheduled task cannot use one at all.
      </p>

      {servers.length === 0 ? (
        <p className="field__hint">You have not added any MCP servers.</p>
      ) : null}

      {servers.map((server) => (
        <div key={server.id} className="connector">
          <div className="connector__header">
            <strong>{server.displayName}</strong>
            <button
              type="button"
              className="button button--quiet"
              disabled={busy !== null}
              onClick={() => void remove(server.id)}
            >
              Remove
            </button>
          </div>
          <p className="field__hint">
            <code>{server.url}</code>
          </p>
          {server.outcome === undefined ? (
            <p className="field__hint">Not asked yet in this browser session.</p>
          ) : server.outcome.failure !== undefined ? (
            <p className="message message--error">{server.outcome.failure}</p>
          ) : (
            <>
              <p className="field__hint">
                {server.outcome.registered.length} tool
                {server.outcome.registered.length === 1 ? '' : 's'} available.
              </p>
              {server.outcome.refused.map((entry) => (
                <p key={entry.name} className="field__hint">
                  <code>{entry.name}</code> is not usable by this extension, because {entry.reason}.
                </p>
              ))}
            </>
          )}
        </div>
      ))}

      <div className="field">
        <label className="field__label" htmlFor="mcp-id">
          Short name
        </label>
        <input
          id="mcp-id"
          className="field__input"
          value={id}
          placeholder="docs"
          onChange={(event) => setId(event.target.value)}
        />
        <p className="field__hint">
          Lower-case letters, digits and hyphens. It becomes part of each tool’s name, so two
          servers cannot share one.
        </p>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="mcp-name">
          Name to show
        </label>
        <input
          id="mcp-name"
          className="field__input"
          value={displayName}
          placeholder="Docs search"
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="mcp-url">
          Address
        </label>
        <input
          id="mcp-url"
          className="field__input"
          value={url}
          placeholder="https://example.com/mcp"
          onChange={(event) => setUrl(event.target.value)}
        />
        <p className="field__hint">Must be https. Only add servers you trust.</p>
      </div>

      <div className="settings__actions">
        <button
          type="button"
          className="button"
          disabled={busy !== null || id.trim() === '' || url.trim() === ''}
          onClick={() => void add()}
        >
          {busy === 'add' ? 'Adding…' : 'Add server'}
        </button>
        {servers.length > 0 ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={busy !== null}
            onClick={() => void recheck()}
          >
            {busy === 'refresh' ? 'Asking…' : 'Ask again'}
          </button>
        ) : null}
      </div>
    </section>
  );
}
