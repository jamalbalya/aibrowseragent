/**
 * Diagnostics, closed by default and off the ordinary path.
 *
 * Everything here answers "is something wrong with this installation", which
 * is a question almost nobody has and a few people badly need. So it is a
 * `<details>` at the bottom of Settings: the summary is the whole affordance,
 * and nothing inside it is part of setting the product up.
 *
 * **No identifiers.** The installation's own label is opaque, means nothing
 * to a person, and reading it aloud would make an internal partition key look
 * like an account number. What is shown instead is whether local storage is
 * working, which is the thing that actually has a symptom.
 */
import { useCallback, useEffect, useState } from 'react';
import { sendToBackground } from '@/messaging/bus';
import type { HealthSnapshot } from '@/storage/persistence-health';

export function TechnicalDetails(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await sendToBackground('health.get', {});
      setSnapshot(result.snapshot);
    } catch {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    // Same pattern as the neighbouring panels: the load is asynchronous, so
    // the state it produces necessarily lands after the effect runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  return (
    <details className="technical" data-testid="technical-details">
      <summary>Technical details</summary>

      <p className="technical__row" data-testid="technical-storage">
        Local storage: {describeStorage(snapshot)}
      </p>

      <p className="technical__row">
        This installation runs on its own. It has no account and contacts no service belonging to AI
        Browser Agent.
      </p>

      <p className="technical__row">
        AI requests go to the service each connected account points at, and nowhere else.
      </p>
    </details>
  );
}

/**
 * Plain words for a health state.
 *
 * The state names are for the code. "Working normally" and "needs attention"
 * are what a person can act on, and the banner above already carries the
 * detail when there is any.
 */
function describeStorage(snapshot: HealthSnapshot | null): string {
  if (snapshot === null) return 'could not be checked';
  if (snapshot.blocked) return 'needs attention — see the message above';
  return snapshot.gating === 'HEALTHY'
    ? 'working normally'
    : 'working, with a past problem recorded';
}
