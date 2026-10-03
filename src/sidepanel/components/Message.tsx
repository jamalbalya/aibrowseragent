/**
 * A result the person needs to read.
 *
 * ## Why this exists rather than a `<p className="message">`
 *
 * Six components rendered that `<p>` directly, and none of them was announced.
 * Every success and every refusal in Settings arrived there — "Connected",
 * "That token was refused", "Google would not renew this authorization" — so
 * somebody using a screen reader pressed a button, heard nothing, and had no
 * way to tell whether it had worked. In the one screen where every credential
 * and connector action happens, that is the whole flow.
 *
 * The fix is two ARIA roles and it has to be the same two everywhere, which is
 * why it is a component and not a convention:
 *
 *  - **`alert`** for an error. Assertive: it interrupts, because the person
 *    acted and the action did not happen, and discovering that later is worse
 *    than being interrupted now.
 *  - **`status`** for a success. Polite: it waits for a pause, because
 *    "Connected" is confirmation rather than news.
 *
 * The element is always present, even with nothing to say. A live region that
 * is added to the DOM at the same moment as its text is frequently not
 * announced at all — the assistive technology never saw an empty region to
 * watch — and that failure is invisible to anybody testing by eye.
 */

export interface MessageProps {
  readonly tone: 'ok' | 'error';
  /** Absent when there is nothing to report. The region stays mounted. */
  readonly text?: string | undefined;
  /** Forwarded for the tests that already locate specific notices. */
  readonly testId?: string | undefined;
}

export function Message({ tone, text, testId }: MessageProps): React.JSX.Element {
  return (
    <p
      className={text === undefined || text.length === 0 ? 'message' : `message message--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      // Redundant with the roles on every browser that matters, and harmless
      // where it is not: `alert` implies assertive and `status` implies
      // polite, and stating it costs nothing against an implementation that
      // reads one and not the other.
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {text ?? ''}
    </p>
  );
}
