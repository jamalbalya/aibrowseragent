/**
 * Structured logging with a field allowlist.
 *
 * The usual approach is to log freely and redact on the way out. This module
 * does the opposite: a log call may only carry fields named in
 * `LOGGABLE_FIELDS`, and anything else is dropped before the record is built.
 *
 * An allowlist is the stronger construction, and the reason is the failure
 * mode each one has. A redactor fails **open**: a secret in a shape nobody
 * anticipated is passed through, and the log looks normal. An allowlist fails
 * **closed**: a field nobody thought about is dropped, and the worst outcome
 * is a missing diagnostic.
 *
 * What may therefore never be logged, because none of it is on the list:
 * tokens, token digests, the recovery key, any K1 key material, provider
 * credentials, OAuth authorization codes, PKCE verifiers, OTP values, and raw
 * identity payloads. The identifiers that *are* allowed are stable, opaque,
 * server-minted correlation values — which is exactly what debugging an
 * authentication flow needs.
 *
 * `emailDomain` deserves a note: the domain alone is on the list because
 * "deliveries to this domain are failing" is a real operational question,
 * and the domain is not the address. The address itself is not loggable.
 */

export const LOGGABLE_FIELDS = [
  'abaUserId',
  'sessionId',
  'familyId',
  'identityId',
  'deviceId',
  // The `login_challenge` row id, which the client already holds and which
  // authorises nothing on its own. It is what makes a sign-in traceable from
  // start to exchange. The secrets on that row — state, nonce, the PKCE
  // verifier, the exchange code — have no entry here and must never get one.
  'challengeId',
  'kind',
  'reason',
  'revoked',
  'sessionsRevoked',
  'count',
  // `errorCode`, not `code`: an OAuth authorization code is also a "code",
  // and a field name a future reader could misread as permission to log one
  // is a field name worth spending three characters on.
  'errorCode',
  'durationMs',
  'emailDomain',
] as const;

export type LoggableField = (typeof LOGGABLE_FIELDS)[number];
export type LogFields = Partial<Record<LoggableField, string | number | boolean>>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export interface ServerLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const ALLOWED: ReadonlySet<string> = new Set(LOGGABLE_FIELDS);

/**
 * Keeps only allowlisted fields.
 *
 * Exported because the invariant suite asserts it directly: handing it a
 * record full of secrets must produce an empty one.
 */
export function filterFields(
  fields: LogFields | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!fields) return out;
  for (const [name, value] of Object.entries(fields)) {
    if (!ALLOWED.has(name)) continue;
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

export type LogSink = (record: LogRecord) => void;

export function createLogger(sink: LogSink): ServerLogger {
  const at = (level: LogLevel) => (event: string, fields?: LogFields) => {
    sink({ level, event, fields: filterFields(fields) });
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** Discards everything. The default, so nothing logs unless a sink is wired. */
export const silentLogger: ServerLogger = createLogger(() => undefined);

/** Collects records. For tests that assert what was and was not written. */
export class RecordingLogSink {
  readonly records: LogRecord[] = [];
  readonly sink: LogSink = (record) => {
    this.records.push(record);
  };
  /** Everything written, flattened, for a "does this contain a secret" scan. */
  serialised(): string {
    return JSON.stringify(this.records);
  }
}
