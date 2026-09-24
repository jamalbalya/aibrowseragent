/**
 * Getting the code to the person, as a port.
 *
 * ## Why a port, and why it has no implementation here
 *
 * Sending mail needs a provider, and a provider needs a credential. This
 * repository contains no production credential of any kind — that is a rule
 * the configuration module already enforces, and it is not relaxed for this
 * feature. So the backend declares what it needs, and a deployment supplies
 * it.
 *
 * The consequence is stated plainly rather than papered over: **a build with
 * no delivery adapter cannot send an OTP, and therefore cannot sign anybody
 * in by email.** `unconfiguredDelivery` is what such a build gets, and it
 * reports `configured: false` so the failure is an answer rather than a
 * timeout. Every route that depends on it is absent, exactly as the Google
 * routes are absent without Google credentials.
 *
 * Nothing in this repository has been verified against a live mail provider,
 * because no live mail provider is configured. That is reported as such and
 * is not claimed as working.
 *
 * ## What may be in a message
 *
 * The code, and the minimum around it. Deliberately **not**: a link that
 * verifies on click (a magic link is a different flow with a different threat
 * model, and mixing them means the weaker one decides), the challenge id, an
 * `abaUserId`, a session token, or anything else that would make the email
 * itself a credential beyond the code it carries.
 */

/** One message. Assembled by the service; never by a caller's input. */
export interface EmailMessage {
  /** The canonical address. */
  readonly to: string;
  readonly subject: string;
  /** Plain text. No HTML, so there is no markup for anything to be injected into. */
  readonly text: string;
}

export interface EmailDelivery {
  /**
   * Whether a real transport stands behind this.
   *
   * Read at wiring time so that a deployment without one has no email routes
   * at all, rather than routes that accept a request and then fail.
   */
  readonly configured: boolean;
  /** Returns whether the message was handed off. Never throws. */
  send(message: EmailMessage): Promise<boolean>;
}

/**
 * The default: no transport.
 *
 * Refuses rather than pretending. A delivery adapter that silently discarded
 * messages would make an unconfigured deployment look like a working one
 * whose mail always goes missing, which is the worst of both.
 */
export const unconfiguredDelivery: EmailDelivery = {
  configured: false,
  send: () => Promise.resolve(false),
};

/** How the code is presented. One place, so the wording cannot drift. */
export function otpMessage(to: string, code: string, ttlMinutes: number): EmailMessage {
  return {
    to,
    subject: 'Your AI Browser Agent sign-in code',
    text: [
      `Your sign-in code is ${code}`,
      '',
      `It expires in ${ttlMinutes} minutes and can be used once.`,
      '',
      'If you did not ask to sign in to AI Browser Agent, ignore this message.',
      'Nobody can use this code without it.',
    ].join('\n'),
  };
}
