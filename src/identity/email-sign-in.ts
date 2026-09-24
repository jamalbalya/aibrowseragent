/**
 * Email sign-in, from the extension's side.
 *
 * Two steps and no browser driving: the person types an address, the backend
 * mails a code, the person types the code. There is no tab, no redirect and
 * no authorization URL, which is why this is a separate module from
 * `google-sign-in.ts` rather than a branch inside it — the two share a
 * transport and a result shape and nothing else.
 *
 * ## What the extension never has
 *
 * **The code is not a thing this module stores.** It arrives as an argument
 * to `verify`, goes into a request body, and the local reference is gone when
 * the call returns. It is never written to `chrome.storage.local`, never to
 * `chrome.storage.session`, never to the session store, never to the identity
 * profile, never onto a task, a workflow or an audit record, and never into a
 * log line. The panel holds it in React state while it is being typed, which
 * is memory belonging to a view that closes.
 *
 * **The extension verifies nothing.** It does not decide whether a code is
 * right, whether an address is known, or whether a challenge has expired. It
 * sends what it was given and reports what came back. A modified extension
 * that skipped every check here would gain exactly nothing, because none of
 * the checks are here.
 *
 * ## The challenge id is not a credential
 *
 * `start` returns one and the panel holds it until the code is typed. It is
 * an opaque server-minted value that names an in-flight sign-in; presenting
 * it without the code does nothing, and it is not stored anywhere durable
 * either — a worker restart loses the in-flight sign-in, and the person asks
 * for a new code. That is the correct trade: the alternative is persisting a
 * handle to a live authentication across restarts.
 */
import { getLogger } from '@/logging/logger';
import { IDENTITY_PATHS } from './identity-config';
import type { IdentityTransport } from './identity-transport';
import type { SignInResult } from './google-sign-in';

const log = getLogger('security');

/** Six ASCII digits. The same shape the server mints, checked before sending. */
const CODE_SHAPE = /^[0-9]{6}$/;

/**
 * Why a code was not sent.
 *
 * None of these says whether an account exists, because the server never
 * looked: an account is created when a code is verified, not when one is
 * requested.
 */
export type EmailStartFailure =
  'NOT_CONFIGURED' | 'INVALID_EMAIL' | 'RATE_LIMITED' | 'DELIVERY_FAILED' | 'UNREACHABLE';

export type EmailStartResult =
  | {
      readonly ok: true;
      readonly challengeId: string;
      readonly expiresAt: number;
      readonly resendAvailableAt: number;
    }
  | {
      readonly ok: false;
      readonly failure: EmailStartFailure;
      /** Set for `RATE_LIMITED`. Milliseconds. */
      readonly retryAfterMs: number | null;
    };

/**
 * Why a code was not accepted.
 *
 * Every one of these describes **this** sign-in attempt. `UNAVAILABLE` is the
 * server's collapse of the outcomes that would otherwise say something about
 * an account, and it is passed through unexamined.
 */
export type EmailVerifyFailure =
  | 'NOT_CONFIGURED'
  | 'INVALID_CODE'
  | 'EXPIRED'
  | 'ATTEMPTS_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'UNREACHABLE';

export type EmailVerifyResult =
  | (SignInResult & { readonly ok: true })
  | {
      readonly ok: false;
      readonly failure: EmailVerifyFailure;
      /** Attempts left on this challenge, when the server said. */
      readonly remainingAttempts: number | null;
      readonly retryAfterMs: number | null;
    };

export interface EmailSignInOptions {
  /**
   * The transport, which already pins the backend origin.
   *
   * There is deliberately no `IdentityConfig` here. This module names no URL
   * of its own — only the two relative paths — so there is nothing for an
   * origin to be compared against and nothing a second copy of it could
   * drift from.
   */
  readonly transport: IdentityTransport;
  /** This installation's device id. Read at verification, never at start. */
  readonly deviceId?: () => Promise<string>;
}

function readString(body: unknown, field: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(body: unknown, field: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The set of refusals the verify route may name. Anything else is unusable. */
const VERIFY_REASONS: ReadonlySet<string> = new Set([
  'INVALID_CODE',
  'EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'RATE_LIMITED',
  'UNAVAILABLE',
]);

export class EmailSignIn {
  constructor(private readonly options: EmailSignInOptions) {}

  /**
   * Asks the backend to mail a code.
   *
   * The address is sent as typed apart from surrounding whitespace, which is
   * never part of an address. **Nothing else is changed here**: no case
   * folding, no dot stripping, no `+tag` removal, no Unicode normalisation.
   * Canonicalisation is one rule in one place, on the server, and a client
   * that pre-normalised would be a second place it could drift.
   */
  async start(email: string): Promise<EmailStartResult> {
    const address = email.trim();
    if (address.length === 0 || address.length > 320) {
      return { ok: false, failure: 'INVALID_EMAIL', retryAfterMs: null };
    }

    let response: { status: number; body: unknown };
    try {
      response = await this.options.transport.send({
        path: IDENTITY_PATHS.emailStart,
        body: { email: address },
      });
    } catch {
      return { ok: false, failure: 'UNREACHABLE', retryAfterMs: null };
    }

    if (response.status === 200) {
      const challengeId = readString(response.body, 'challengeId');
      const expiresAt = readNumber(response.body, 'expiresAt');
      const resendAvailableAt = readNumber(response.body, 'resendAvailableAt');
      if (challengeId === null || expiresAt === null || resendAvailableAt === null) {
        return { ok: false, failure: 'UNREACHABLE', retryAfterMs: null };
      }
      // No address, no code, no challenge id. The ids are correlation values
      // and none of them has a field on the logger's allowlist anyway.
      log.info('A sign-in code was requested.', {});
      return { ok: true, challengeId, expiresAt, resendAvailableAt };
    }

    if (response.status === 429) {
      return {
        ok: false,
        failure: 'RATE_LIMITED',
        retryAfterMs: readNumber(response.body, 'retryAfterMs') ?? 0,
      };
    }
    if (response.status === 400) {
      return { ok: false, failure: 'INVALID_EMAIL', retryAfterMs: null };
    }
    if (response.status === 404) {
      // This deployment has no email sign-in, which is what an absent route
      // means everywhere else in this API.
      return { ok: false, failure: 'NOT_CONFIGURED', retryAfterMs: null };
    }
    if (response.status === 502 || response.status === 503) {
      return { ok: false, failure: 'DELIVERY_FAILED', retryAfterMs: null };
    }
    return { ok: false, failure: 'UNREACHABLE', retryAfterMs: null };
  }

  /**
   * Presents a code.
   *
   * The shape is checked here purely to save a round trip on an obvious
   * typo — the server checks it again and spends an attempt on anything that
   * reaches it, so this is a convenience and not a control. Refusing locally
   * costs the person nothing and does not consume one of their five tries.
   */
  async verify(challengeId: string, code: string): Promise<EmailVerifyResult> {
    const presented = code.trim();
    if (!CODE_SHAPE.test(presented)) {
      return {
        ok: false,
        failure: 'INVALID_CODE',
        remainingAttempts: null,
        retryAfterMs: null,
      };
    }

    const deviceId = await this.readDeviceId();

    let response: { status: number; body: unknown };
    try {
      response = await this.options.transport.send({
        path: IDENTITY_PATHS.emailVerify,
        body: {
          challengeId,
          code: presented,
          ...(deviceId === null ? {} : { deviceId }),
        },
      });
    } catch {
      return {
        ok: false,
        failure: 'UNREACHABLE',
        remainingAttempts: null,
        retryAfterMs: null,
      };
    }

    if (response.status === 200) {
      const abaUserId = readString(response.body, 'abaUserId');
      const accessToken = readString(response.body, 'accessToken');
      const refreshToken = readString(response.body, 'refreshToken');
      const accessExpiresAt = readNumber(response.body, 'accessExpiresAt');
      const refreshExpiresAt = readNumber(response.body, 'refreshExpiresAt');
      if (
        abaUserId === null ||
        accessToken === null ||
        refreshToken === null ||
        accessExpiresAt === null ||
        refreshExpiresAt === null
      ) {
        return {
          ok: false,
          failure: 'UNREACHABLE',
          remainingAttempts: null,
          retryAfterMs: null,
        };
      }
      log.info('An email sign-in completed.', {});
      return {
        ok: true,
        abaUserId,
        accessToken,
        accessExpiresAt,
        refreshToken,
        refreshExpiresAt,
        email: readString(response.body, 'email'),
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        failure: 'RATE_LIMITED',
        remainingAttempts: null,
        retryAfterMs: readNumber(response.body, 'retryAfterMs') ?? 0,
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        failure: 'NOT_CONFIGURED',
        remainingAttempts: null,
        retryAfterMs: null,
      };
    }
    if (response.status === 401) {
      const reason = readString(response.body, 'reason');
      // An unrecognised reason is treated as an expiry rather than as a bad
      // code: "ask for a new one" is the recovery that always works, and
      // guessing "try again" would burn the person's remaining attempts on
      // a state the client does not understand.
      const failure: EmailVerifyFailure =
        reason !== null && VERIFY_REASONS.has(reason) ? (reason as EmailVerifyFailure) : 'EXPIRED';
      return {
        ok: false,
        failure,
        remainingAttempts: readNumber(response.body, 'remainingAttempts'),
        retryAfterMs: null,
      };
    }
    return {
      ok: false,
      failure: 'UNREACHABLE',
      remainingAttempts: null,
      retryAfterMs: null,
    };
  }

  /** The device id, or `null` when there is none and when reading one fails. */
  private async readDeviceId(): Promise<string | null> {
    if (this.options.deviceId === undefined) return null;
    try {
      const value = await this.options.deviceId();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
}
