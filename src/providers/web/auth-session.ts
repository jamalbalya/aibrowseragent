/**
 * Human-in-the-loop authentication for web providers (Stage 3 D2).
 *
 * The extension opens the login page and then gets out of the way. The person
 * types the password, answers the second factor, solves the CAPTCHA, completes
 * whatever single sign-on their organisation uses. None of that is automated,
 * and none of it is observed beyond the coarse signals in `web-provider.ts`.
 *
 * The load-bearing property is that **waiting for a person is not a timeout**.
 * Every other wait in this system has a deadline because a stalled tool call
 * means something is wrong. A human reading a verification email is not
 * something going wrong, and cancelling their task after twenty-five seconds
 * would be a bug that looks like a policy. `deadlineFor` returns `null` for
 * this state, and the runtime maps it to `WAITING_FOR_USER`.
 */

import { getLogger } from '@/logging/logger';
import {
  initialStatus,
  transitionProvider,
  type ProviderStateReason,
  type ProviderStatus,
} from '@/providers/core/provider-kind';
import {
  assessAuthentication,
  corroborateOrigin,
  type AuthSignal,
  type WebProviderDefinition,
} from './web-provider';

const log = getLogger('provider');

export interface AuthSessionOptions {
  readonly now?: () => number;
}

/**
 * Tracks one task's relationship with one web provider.
 *
 * Per task rather than global: two tasks working with the same provider are
 * two independent authorisations, and one finishing a login does not silently
 * make the other ready.
 */
export class WebAuthSession {
  private status: ProviderStatus;
  private readonly now: () => number;

  constructor(
    readonly taskId: string,
    private readonly definition: WebProviderDefinition,
    options: AuthSessionOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.status = initialStatus(definition.id, 'web', this.now());
  }

  current(): ProviderStatus {
    return this.status;
  }

  /** The provider is selected but no session is known. */
  requireAuth(reason: ProviderStateReason = 'no_session'): ProviderStatus {
    return this.apply('NEEDS_AUTH', reason);
  }

  /**
   * The login page has been opened and the person is now in control.
   *
   * Returns the URL the caller should navigate to. The extension's part ends
   * here until a signal arrives.
   */
  beginAuthentication(): { status: ProviderStatus; loginUrl: string } {
    const status = this.apply('AUTHENTICATING', 'login_opened');
    return { status, loginUrl: this.definition.loginUrl };
  }

  /**
   * Offers an observation and lets the machine decide.
   *
   * The caller cannot declare success: it supplies what it saw, and only
   * `assessAuthentication` — which refuses every ambiguous case — can produce
   * the `authenticated` reason that the state table requires for `READY`.
   */
  observe(signal: AuthSignal): ProviderStatus {
    if (signal.tabClosed === true) {
      return this.apply('NEEDS_AUTH', 'tab_closed');
    }

    // An origin change during or after login is not a detail. It means the
    // page being observed is no longer the provider's, so nothing seen on it
    // says anything about the provider's session.
    if (corroborateOrigin(this.definition, signal.tabUrl) === 'mismatch') {
      log.warn('Provider tab left the provider origin; authentication is no longer established.', {
        providerId: this.definition.id,
        taskId: this.taskId,
      });
      return this.apply('NEEDS_AUTH', 'origin_changed');
    }

    const assessment = assessAuthentication(this.definition, signal);
    if (assessment.authenticated) {
      return this.apply('READY', 'authenticated', signal.tabUrl);
    }

    // Still inside the login flow: stay put and keep waiting for the person.
    if (this.status.state === 'AUTHENTICATING' && assessment.reason === 'ambiguous_signal') {
      return this.status;
    }
    return this.apply('NEEDS_AUTH', assessment.reason);
  }

  /** The provider could not be reached, or its tab is gone. */
  markUnavailable(reason: ProviderStateReason = 'provider_unreachable'): ProviderStatus {
    return this.apply('UNAVAILABLE', reason);
  }

  /** Access was refused. Terminal until the provider is reconfigured. */
  markDenied(reason: ProviderStateReason = 'access_refused'): ProviderStatus {
    return this.apply('DENIED', reason);
  }

  /** The user abandoned the login. */
  cancel(): ProviderStatus {
    return this.apply('NEEDS_AUTH', 'user_cancelled');
  }

  private apply(
    to: ProviderStatus['state'],
    reason: ProviderStateReason,
    origin?: string,
  ): ProviderStatus {
    const result = transitionProvider(this.status, to, reason, this.now(), origin);
    if (result.changed) {
      log.debug('Provider state changed.', {
        providerId: this.definition.id,
        taskId: this.taskId,
        from: this.status.state,
        to,
        reason,
      });
      this.status = result.status;
    }
    return this.status;
  }
}

/**
 * How long the runtime may wait in a given provider state.
 *
 * `null` means no deadline at all. That is not an oversight and must not be
 * "fixed" by supplying a large number: a person completing a login has no
 * bound, and any number chosen here would eventually cancel somebody's task
 * while they were reading a verification email.
 */
export function deadlineFor(status: ProviderStatus, defaultMs: number): number | null {
  return status.state === 'AUTHENTICATING' ? null : defaultMs;
}

/**
 * The task state a provider state corresponds to.
 *
 * Authentication rides the existing lifecycle rather than adding a parallel
 * one, so a task waiting for a login is paused in exactly the way every other
 * waiting task is, and the existing resume path works unchanged.
 */
export function taskStateFor(
  status: ProviderStatus,
): 'RUNNING' | 'WAITING_FOR_USER' | 'PAUSED' | 'BLOCKED' {
  switch (status.state) {
    case 'READY':
      return 'RUNNING';
    case 'AUTHENTICATING':
      return 'WAITING_FOR_USER';
    case 'NEEDS_AUTH':
    case 'UNAVAILABLE':
    case 'UNCONFIGURED':
      return 'PAUSED';
    case 'DENIED':
      return 'BLOCKED';
  }
}
