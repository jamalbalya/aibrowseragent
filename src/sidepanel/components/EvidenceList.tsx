import { useCallback, useEffect, useState } from 'react';
import { MessagingError, sendToBackground } from '@/messaging/bus';
import type { EvidenceReference } from '@/evidence/evidence-model';

type PayloadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'loaded';
      readonly content: string;
      readonly mimeType: string;
      readonly encoding: string;
    };

interface EvidenceListProps {
  readonly taskId: string;
}

/**
 * Evidence for a finished task.
 *
 * Evidence is only meaningful if it can be inspected — a count alone tells the
 * user nothing about what the agent actually saw. Payloads are fetched on
 * demand rather than up front, because a screenshot is large and most items
 * are never opened.
 */
export function EvidenceList({ taskId }: EvidenceListProps): React.JSX.Element | null {
  const [items, setItems] = useState<readonly EvidenceReference[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // Three states, not two: loading, missing, and loaded. Collapsing "missing"
  // into "loading" would leave the panel spinning forever on evidence whose
  // payload was evicted.
  const [payload, setPayload] = useState<PayloadState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await sendToBackground('evidence.listForTask', { taskId });
        if (!cancelled) setItems(result.evidence);
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const open = useCallback(
    async (id: string) => {
      if (openId === id) {
        setOpenId(null);
        setPayload({ kind: 'idle' });
        return;
      }
      setOpenId(id);
      setPayload({ kind: 'loading' });
      try {
        const result = await sendToBackground('evidence.getPayload', { evidenceId: id });
        setPayload(
          result.content === null
            ? { kind: 'missing' }
            : {
                kind: 'loaded',
                content: result.content,
                mimeType: result.mimeType,
                encoding: result.encoding,
              },
        );
      } catch (caught) {
        setPayload({ kind: 'missing' });
        setError(describe(caught));
      }
    },
    [openId],
  );

  if (items.length === 0 && !error) return null;

  return (
    <section className="evidence">
      <h3 className="evidence__title">Evidence ({items.length})</h3>
      {error ? <p className="message message--error">{error}</p> : null}

      <ul className="evidence__list">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="evidence__item"
              aria-expanded={openId === item.id}
              onClick={() => void open(item.id)}
            >
              <span className="evidence__type">{item.type}</span>
              <span className="evidence__label">{item.label}</span>
              <span className="evidence__size">{formatBytes(item.byteLength)}</span>
            </button>

            {openId === item.id ? (
              <div className="evidence__payload">
                {payload.kind === 'loading' || payload.kind === 'idle' ? (
                  <p className="evidence__loading">Loading…</p>
                ) : payload.kind === 'missing' ? (
                  <p className="evidence__loading">
                    This item&rsquo;s contents are no longer stored. Evidence is retained up to a
                    fixed limit, and older items are removed.
                  </p>
                ) : payload.encoding === 'base64' ? (
                  <img
                    className="evidence__image"
                    src={`data:${payload.mimeType};base64,${payload.content}`}
                    alt={item.label}
                  />
                ) : (
                  <pre className="evidence__text">{payload.content}</pre>
                )}
                <p className="evidence__meta">
                  Captured by <code>{item.sourceTool}</code>
                  {item.origin ? ` from ${item.origin}` : ''} ·{' '}
                  {new Date(item.createdAt).toLocaleTimeString()}
                </p>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(error: unknown): string {
  if (error instanceof MessagingError) return error.agentError.userMessage;
  return error instanceof Error ? error.message : String(error);
}
