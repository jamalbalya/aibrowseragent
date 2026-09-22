import { useCallback, useEffect, useState } from 'react';
import { sendToBackground, MessagingError } from '@/messaging/bus';
import type { PanelResponse } from '@/messaging/protocol';

type AuditPage = PanelResponse<'audit.list'>;
type Integrity = PanelResponse<'audit.integrity'>;

interface AuditViewProps {
  /** The task an export defaults to, and the default filter. */
  readonly activeTaskId: string | null;
  readonly onClose: () => void;
}

const PAGE_SIZE = 50;

/**
 * The audit trail, read-only.
 *
 * Everything here is a decision or a reference: what was proposed, what was
 * allowed or denied, and which evidence record holds the rest. There is no
 * page content, no argument, no result and no credential, because none of
 * that is in the trail to show.
 *
 * Two things are deliberately absent. There is **no delete**: a trail that
 * the thing being audited can erase is not a trail, and a privacy control for
 * clearing history is a separate decision from making the history
 * trustworthy. And there is **no model path** to any of this — these are
 * panel messages, not tools.
 *
 * Export writes a file from a blob this panel builds, of this extension's own
 * origin. It needs no permission and reaches no network: there is no URL here
 * for anything to supply.
 */
export function AuditView({ activeTaskId, onClose }: AuditViewProps): React.JSX.Element {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [integrity, setIntegrity] = useState<Integrity | null>(null);
  const [offset, setOffset] = useState(0);
  const [scopeToTask, setScopeToTask] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const taskFilter = scopeToTask && activeTaskId !== null ? activeTaskId : undefined;

  const refresh = useCallback(async () => {
    try {
      const [listed, verdict] = await Promise.all([
        sendToBackground('audit.list', {
          offset,
          limit: PAGE_SIZE,
          ...(taskFilter === undefined ? {} : { taskId: taskFilter }),
        }),
        sendToBackground('audit.integrity', {}),
      ]);
      setPage(listed);
      setIntegrity(verdict);
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    }
  }, [offset, taskFilter]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  /**
   * Writes the export to a file, locally.
   *
   * A blob of this extension's own origin, handed to the browser through an
   * anchor the user's click activates. No `chrome.downloads`, no clipboard,
   * no network, and no permission — and no URL parameter anywhere, so there
   * is nothing here for a model or a page to point somewhere else.
   */
  const exportTrail = async (kind: 'task' | 'all'): Promise<void> => {
    if (kind === 'task' && activeTaskId === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const { export: document_ } = await sendToBackground('audit.export', {
        scope: kind === 'task' ? { kind: 'task', taskId: activeTaskId as string } : { kind: 'all' },
      });

      const blob = new Blob([JSON.stringify(document_, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        // Extension-authored, and built from a timestamp and a fixed word.
        // Nothing a page, a model or a task contributed reaches a path.
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
        anchor.download = `audit-${kind}-${stamp}.json`;
        anchor.click();
      } finally {
        // Revoked immediately: an object URL left alive is a handle on this
        // data that outlives the click that needed it.
        URL.revokeObjectURL(url);
      }

      setMessage({
        tone: 'ok',
        text: `Saved ${document_.eventCount} record${document_.eventCount === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: describe(error) });
    } finally {
      setBusy(false);
    }
  };

  const total = page?.total ?? 0;
  const shown = page?.events ?? [];

  return (
    <div className="settings">
      <header className="settings__header">
        <h2>Activity</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      </header>

      {message ? (
        <div className={`banner banner--${message.tone === 'ok' ? 'info' : 'error'}`} role="status">
          {message.text}
        </div>
      ) : null}

      {page?.degraded ? (
        <div className="banner banner--error" role="alert" data-testid="audit-degraded">
          {page.degraded}
        </div>
      ) : null}

      <section className="settings__section">
        <p className="field__hint" data-testid="audit-integrity">
          {integrity === null
            ? 'Checking…'
            : `${describeVerdict(integrity.verdict)} ${integrity.note}`}
        </p>
        <p className="field__hint">
          This checks for corruption and reordering — a partial write, a missing record, one out of
          order. It is not protection against someone who can edit the extension’s storage directly.
        </p>

        <div className="settings__actions">
          <label className="header__mode">
            <input
              type="checkbox"
              checked={scopeToTask}
              disabled={activeTaskId === null}
              onChange={(event) => {
                setScopeToTask(event.target.checked);
                setOffset(0);
              }}
            />{' '}
            This task only
          </label>
          <button
            type="button"
            className="button"
            data-testid="audit-export-task"
            disabled={busy || activeTaskId === null}
            onClick={() => void exportTrail('task')}
          >
            Export this task
          </button>
          <button
            type="button"
            className="button button--ghost"
            data-testid="audit-export-all"
            disabled={busy}
            onClick={() => void exportTrail('all')}
          >
            Export every task
          </button>
        </div>
      </section>

      <section className="settings__section">
        <h3>
          {total} record{total === 1 ? '' : 's'}
        </h3>
        {shown.length === 0 ? (
          <p className="field__hint">Nothing recorded yet.</p>
        ) : (
          <ul className="sites" data-testid="audit-list">
            {shown.map((event) => (
              <li
                key={event.id}
                className={`sites__row ${event.type === 'retention.compacted' ? 'audit--gap' : ''}`}
              >
                <span>
                  <strong>{event.type}</strong>
                  {event.tool ? (
                    <>
                      {' '}
                      — <code>{event.tool}</code>
                    </>
                  ) : null}
                  {event.type === 'retention.compacted' ? (
                    <> — {event.removedCount} older records removed</>
                  ) : null}
                  {event.site ? <> — {event.site}</> : null}
                </span>
                <span className={`badge badge--${event.outcome}`}>{event.outcome}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="settings__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Newer
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Older
          </button>
        </div>
      </section>
    </div>
  );
}

function describeVerdict(verdict: string): string {
  switch (verdict) {
    case 'ok':
      return 'Consistent.';
    case 'empty':
      return 'Empty.';
    case 'truncated':
      return 'Older records evicted.';
    case 'gap':
      return 'A record is missing.';
    case 'reordered':
      return 'Records are out of order.';
    case 'chain-broken':
      return 'A record does not follow the one before it.';
    case 'future-version':
      return 'A record came from a newer version.';
    default:
      return 'A stored record could not be read.';
  }
}

function describe(error: unknown): string {
  if (error instanceof MessagingError) return error.agentError.userMessage;
  return error instanceof Error ? error.message : String(error);
}
