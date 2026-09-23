/**
 * What a new installation says for itself before anything is connected.
 *
 * A person who has just installed this sees an empty panel and a composer
 * that will not accept anything, and the question they are actually asking is
 * "what do I have to sign up for". The answer is nothing, so this says so
 * first and puts the one real next step — connecting an AI account they
 * already have — after it.
 *
 * **Order is the whole design.** Reassurance, then the ask. Reversed, the
 * first thing a standalone product says is that something is missing.
 *
 * It is shown only while no AI account is connected, and it disappears once
 * one is, because a permanent explanation is a permanent apology.
 *
 * ## The precision that is not optional
 *
 * "Nothing leaves this device" would be a comfortable sentence and a false
 * one: an AI request has to reach whichever AI service the user connects.
 * So this draws the line where it really is — the extension keeps your work
 * here, and your requests go straight to the service you chose, not through
 * anything of ours. Overclaiming privacy is worse than explaining it.
 */
interface WelcomeNoticeProps {
  /** Opens Settings, where an AI account is connected. */
  readonly onConnect: () => void;
}

export function WelcomeNotice({ onConnect }: WelcomeNoticeProps): React.JSX.Element {
  return (
    <section className="welcome" aria-label="Getting started" data-testid="welcome-notice">
      <h2 className="welcome__title">Ready to use on this device</h2>

      <p className="welcome__body">
        AI Browser Agent works here without an account. Your tasks, workflows and settings are
        stored on this device.
      </p>

      <p className="welcome__body">
        To have it read a page and act on it, connect an AI account you already have. You keep the
        account, and the key stays on this device.
      </p>

      <button type="button" className="button" data-testid="welcome-connect" onClick={onConnect}>
        Connect AI account
      </button>

      <p className="welcome__note">
        Your requests go directly to the AI service you connect. Nothing goes to AI Browser Agent —
        there is no service of ours for it to go to.
      </p>
    </section>
  );
}
