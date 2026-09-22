/**
 * The workspace control surface.
 *
 * Shows which tabs the agent can currently see, and lets the user change
 * that. It is **not** an authorization mechanism: every button here sends a
 * route, every route goes through route trust, and every tab the agent later
 * acts on still passes the live membership guard in the worker. Nothing in
 * this file writes storage, drives a browser tool, or decides that a tab is
 * in scope.
 *
 * Two behaviours are deliberate and easy to get wrong:
 *
 *  - When the user looks at a tab outside the workspace, the panel **says so
 *    and offers to add it**. It does not add it, and it does not switch
 *    workspace to follow them. Either would let the agent's reach change
 *    because somebody clicked a tab.
 *  - The tab list is whatever Chrome reports right now. A closed tab simply
 *    stops appearing; a remembered id is never shown as if it were live.
 */
import { useCallback, useEffect, useState } from 'react';
import { sendToBackground, subscribeToEvents } from '@/messaging/bus';
import type { PanelResponse } from '@/messaging/protocol';

type WorkspaceState = PanelResponse<'workspace.state'>;

interface WorkspaceViewProps {
  readonly onMessage: (tone: 'ok' | 'error', text: string) => void;
}

export function WorkspaceView({ onMessage }: WorkspaceViewProps): React.JSX.Element {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await sendToBackground('workspace.state', {}));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().catch((error: unknown) => onMessage('error', describe(error)));
    // Membership can change without the panel doing anything — the user drags
    // a tab, or closes one — so the worker says when to look again.
    return subscribeToEvents((event) => {
      if (event.type === 'workspace.changed') void refresh().catch(() => undefined);
    });
  }, [refresh, onMessage]);

  const run = useCallback(
    async (action: () => Promise<string | null>) => {
      setBusy(true);
      try {
        const problem = await action();
        await refresh();
        if (problem) onMessage('error', problem);
      } catch (error) {
        onMessage('error', describe(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh, onMessage],
  );

  if (!state) return <section className="settings__section" />;

  const active = state.workspaces.find((workspace) => workspace.isActive) ?? null;
  const current = state.currentTab;

  return (
    <section className="settings__section">
      <h3>Workspace</h3>

      {state.workspaces.length === 0 ? (
        <p className="field__hint">
          No workspace yet. Start one from the tab you are on, and the agent will see that tab and
          nothing else.
        </p>
      ) : (
        <label className="field">
          <span>Active workspace</span>
          <select
            value={active?.workspaceId ?? ''}
            disabled={busy}
            onChange={(event) =>
              void run(async () => {
                const result = await sendToBackground('workspace.switch', {
                  workspaceId: event.target.value,
                });
                return result.error?.userMessage ?? null;
              })
            }
          >
            {state.workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.title}
                {workspace.state === 'detached' ? ' (detached)' : ` · ${workspace.liveTabCount}`}
              </option>
            ))}
          </select>
        </label>
      )}

      {active?.state === 'detached' ? (
        <div className="notice">
          <p>
            This workspace has no open tab group. Its tasks and history are intact — re-attach it to
            the tab you are on to keep working.
          </p>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await sendToBackground('workspace.reattach', {
                  workspaceId: active.workspaceId,
                });
                return (
                  result.error?.userMessage ?? (result.attached ? null : 'Could not re-attach.')
                );
              })
            }
          >
            Re-attach to current tab
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="button button--ghost"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await sendToBackground('workspace.create', {});
            return result.error?.userMessage ?? null;
          })
        }
      >
        New workspace from current tab
      </button>

      {active && active.state === 'attached' ? (
        <>
          <p className="field__hint">
            {state.tabs.length === 0
              ? 'No open tabs in this workspace. The agent has nothing to look at.'
              : `The agent can see these ${state.tabs.length} tab(s), and no others.`}
          </p>
          <ul className="account-list">
            {state.tabs.map((tab) => (
              <li key={tab.tabId} className="account-list__item">
                <div>
                  <strong>{tab.title || tab.url}</strong>
                  {tab.active ? <span className="badge">current</span> : null}
                  <div className="field__hint">{tab.url}</div>
                </div>
                <div className="account-list__actions">
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await sendToBackground('workspace.removeTab', {
                          tabId: tab.tabId,
                        });
                        return result.error?.userMessage ?? null;
                      })
                    }
                  >
                    Remove from workspace
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {/* Said, never done. The agent's reach does not change because the
              user looked at something. */}
          {current && !current.inActiveWorkspace ? (
            <div className="notice">
              <p>The tab you are on is outside this workspace, so the agent cannot see it.</p>
              <p className="field__hint">{current.title || current.url}</p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await sendToBackground('workspace.addCurrentTab', {});
                    return (
                      result.error?.userMessage ?? (result.added ? null : 'Could not add that tab.')
                    );
                  })
                }
              >
                Add current tab
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
