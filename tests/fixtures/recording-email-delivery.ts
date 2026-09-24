/**
 * A mail transport that keeps every message instead of sending it.
 *
 * **Test-only, and it lives here for that reason.** Nothing under `server/`
 * or `src/` may expose an OTP to a caller, so the only place a test can read
 * one is the thing that stood in for the mail provider. `server/app/
 * email-delivery.ts` ships a port and an unconfigured default and no
 * implementation at all, which is what makes "the code never leaves the
 * process except by email" checkable rather than asserted.
 *
 * The suite that scans production modules for an OTP-revealing export is
 * `tests/security/email-otp-boundary.test.ts`, and this file is deliberately
 * outside what it scans.
 */
import type { EmailDelivery, EmailMessage } from '../../server/app/email-delivery';

export class RecordingEmailDelivery implements EmailDelivery {
  readonly sent: EmailMessage[] = [];
  /** Flip to make the next send fail, so the delivery-failure path is real. */
  failing = false;

  constructor(readonly configured: boolean = true) {}

  send(message: EmailMessage): Promise<boolean> {
    if (this.failing) return Promise.resolve(false);
    this.sent.push(message);
    return Promise.resolve(true);
  }

  /** The most recent message, or `null`. */
  last(): EmailMessage | null {
    return this.sent.at(-1) ?? null;
  }

  /**
   * The code out of the most recent message.
   *
   * Parsed from the body rather than captured separately, so a test reads
   * exactly what a person would read — and a message that somehow stopped
   * carrying a code would fail here rather than silently pass.
   */
  lastCode(): string {
    const body = this.last()?.text ?? '';
    const found = /\b([0-9]{6})\b/.exec(body);
    if (found?.[1] === undefined) {
      throw new Error('No six-digit code in the most recent message.');
    }
    return found[1];
  }

  /** Every message sent to one address, oldest first. */
  to(address: string): EmailMessage[] {
    return this.sent.filter((message) => message.to === address);
  }

  clear(): void {
    this.sent.length = 0;
    this.failing = false;
  }
}

/** A transport that reports itself unconfigured, for the "no email routes" case. */
export const unconfiguredRecordingDelivery = new RecordingEmailDelivery(false);
