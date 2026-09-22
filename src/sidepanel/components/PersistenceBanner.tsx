import { useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { HealthDomain, HealthSnapshot } from '@/storage/persistence-health';

/**
 * Says when stored state was lost, and lets a person accept that before work
 * continues (D-3).
 *
 * This is a banner rather than a dialog on purpose. The condition it reports
 * is not transient — it is written down and survives restarts — so it belongs
 * somewhere it stays visible until someone deals with it, instead of somewhere
 * it can be dismissed by pressing Escape.
 *
 * Acknowledging repairs nothing, and the wording says so. What it does is
 * record that a person has seen what was lost and is choosing to continue,
 * which is the only thing that lets a blocked task start again.
 */
export function PersistenceBanner(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const result = await sendToBackground('health.get', {});
        if (!cancelled) setSnapshot(result.snapshot);
      } catch {
        // A panel that cannot read health says nothing rather than guessing.
        // The worker is the one that blocks work, and it is not asking.
      }
    };
    void read();
    // Polled rather than pushed: this state changes when a *write elsewhere*
    // fails, which is not an event the panel is party to.
    const timer = setInterval(() => void read(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!snapshot) return null;
  const unhealthy = snapshot.records.filter((record) => record.state !== 'HEALTHY');
  if (unhealthy.length === 0) return null;

  const acknowledge = async (domain: HealthDomain): Promise<void> => {
    setBusy(true);
    try {
      const result = await sendToBackground('health.acknowledge', { domain });
      setSnapshot(result.snapshot);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={snapshot.blocked ? 'banner banner--error' : 'banner banner--warn'}
      role="alert"
      data-testid="persistence-banner"
    >
      <strong>
        {snapshot.blocked
          ? 'Stored state was lost, and work is paused.'
          : 'Some stored records were lost.'}
      </strong>
      <ul className="banner__list">
        {unhealthy.map((record) => (
          <li key={record.domain}>
            <code>{record.domain}</code> — {record.state.toLowerCase().replace(/_/g, ' ')} (
            {record.reason})
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              data-testid={`acknowledge-${record.domain}`}
              onClick={() => void acknowledge(record.domain)}
            >
              I’ve seen this
            </button>
          </li>
        ))}
      </ul>
      <p className="banner__note">
        Acknowledging does not recover anything. It records that you have seen what was lost.
      </p>
    </div>
  );
}
