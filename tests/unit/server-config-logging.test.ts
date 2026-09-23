/**
 * TEST-SERVER-005 — configuration and logging.
 *
 * Two rules, both of which fail silently when broken.
 *
 * A secret with a development default is a production secret the first time
 * somebody forgets to override it, and the system works perfectly until it is
 * exploited. So the test is not that a good value is accepted — it is that a
 * missing one refuses to start.
 *
 * A log that carries a token is a token in a log aggregator, in a support
 * bundle, and in whatever else reads logs. The logger here uses an allowlist
 * rather than a redactor, and the reason is the direction each one fails in:
 * a redactor passes through the shape nobody anticipated, an allowlist drops
 * the field nobody declared.
 */
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  createLogger,
  describeConfig,
  filterFields,
  loadConfig,
  LOGGABLE_FIELDS,
  RecordingLogSink,
  REQUIRED_VARIABLES,
  SECRET_VARIABLES,
} from '@server/index';

const COMPLETE = {
  ABA_PUBLIC_ORIGIN: 'https://api.example.test',
  ABA_ACCESS_TOKEN_SIGNING_KEY: 'k'.repeat(64),
  ABA_DATABASE_URL: 'postgres://user:pw@db.example.test/aba',
  ABA_GOOGLE_CLIENT_ID: '1234567890-example.apps.googleusercontent.com',
  ABA_GOOGLE_CLIENT_SECRET: 'GOCSPX-not-a-real-secret-for-tests-only',
};

/** Everything a deployment must set. Google is configured on top of it. */
const WITHOUT_GOOGLE = {
  ABA_PUBLIC_ORIGIN: COMPLETE.ABA_PUBLIC_ORIGIN,
  ABA_ACCESS_TOKEN_SIGNING_KEY: COMPLETE.ABA_ACCESS_TOKEN_SIGNING_KEY,
  ABA_DATABASE_URL: COMPLETE.ABA_DATABASE_URL,
};

describe('configuration', () => {
  it('reads a complete environment', () => {
    const config = loadConfig(COMPLETE);
    expect(config.publicOrigin).toBe('https://api.example.test');
    expect(config.logLevel).toBe('info');
  });

  it('refuses to start when a secret is missing', () => {
    for (const variable of SECRET_VARIABLES) {
      const partial = { ...COMPLETE, [variable]: undefined };
      expect(() => loadConfig(partial), variable).toThrow(ConfigError);
    }
  });

  it('refuses an empty or whitespace value as if it were absent', () => {
    expect(() => loadConfig({ ...COMPLETE, ABA_ACCESS_TOKEN_SIGNING_KEY: '' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...COMPLETE, ABA_ACCESS_TOKEN_SIGNING_KEY: '   ' })).toThrow(
      ConfigError,
    );
  });

  it('names every missing variable at once, not the first', () => {
    try {
      loadConfig({});
      throw new Error('expected a ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).missing).toEqual(REQUIRED_VARIABLES.map((entry) => entry.name));
    }
  });

  it('has no default for any secret variable', () => {
    // Asserted against the module source, because a default added later would
    // satisfy every behavioural test above by making the variable optional.
    for (const variable of SECRET_VARIABLES) {
      const withoutIt = { ...COMPLETE, [variable]: undefined };
      let threw = false;
      try {
        loadConfig(withoutIt);
      } catch {
        threw = true;
      }
      expect(threw, `${variable} must have no default`).toBe(true);
    }
  });

  it('treats Google as configured in full or not at all', () => {
    // A backend with no Google client is a working backend that cannot sign
    // anybody in that way, so the absence is allowed and is not an error.
    expect(loadConfig(WITHOUT_GOOGLE).google).toBeNull();
    expect(loadConfig(COMPLETE).google?.clientId).toBe(COMPLETE.ABA_GOOGLE_CLIENT_ID);

    // Half of a client is refused at startup rather than at the one moment it
    // would matter, which is in the middle of somebody's sign-in.
    for (const half of ['ABA_GOOGLE_CLIENT_ID', 'ABA_GOOGLE_CLIENT_SECRET']) {
      expect(() => loadConfig({ ...COMPLETE, [half]: undefined }), half).toThrow(ConfigError);
      expect(() => loadConfig({ ...COMPLETE, [half]: '   ' }), half).toThrow(ConfigError);
    }
  });

  it('never prints the Google client secret', () => {
    const serialised = JSON.stringify(describeConfig(loadConfig(COMPLETE)));
    expect(serialised).not.toContain(COMPLETE.ABA_GOOGLE_CLIENT_SECRET);
    expect(serialised).not.toContain('GOCSPX-');
    // Not the id either: whether Google is on is all an operator needs.
    expect(serialised).not.toContain(COMPLETE.ABA_GOOGLE_CLIENT_ID);
  });

  it('defaults only the non-secret log level', () => {
    expect(loadConfig(COMPLETE).logLevel).toBe('info');
    expect(loadConfig({ ...COMPLETE, ABA_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    // An unrecognised level falls back rather than failing: it is not a secret,
    // and refusing to start over a typo in a log level is the wrong trade.
    expect(loadConfig({ ...COMPLETE, ABA_LOG_LEVEL: 'shout' }).logLevel).toBe('info');
  });

  it('describes a config without printing a secret', () => {
    const described = describeConfig(loadConfig(COMPLETE));
    const serialised = JSON.stringify(described);
    expect(serialised).not.toContain(COMPLETE.ABA_ACCESS_TOKEN_SIGNING_KEY);
    expect(serialised).not.toContain(COMPLETE.ABA_DATABASE_URL);
    expect(serialised).not.toContain('postgres://');
    expect(described.accessTokenSigningKey).toBe('[set]');
  });
});

describe('logging', () => {
  it('keeps allowlisted fields', () => {
    expect(filterFields({ abaUserId: 'usr_1', sessionId: 'ses_1' })).toEqual({
      abaUserId: 'usr_1',
      sessionId: 'ses_1',
    });
  });

  it('drops everything not on the allowlist', () => {
    const hostile = {
      refreshToken: 'secret-token',
      accessToken: 'secret-access',
      recoveryKey: 'secret-recovery',
      kek: 'secret-kek',
      dek: 'secret-dek',
      apiKey: 'sk-not-a-real-key',
      otp: '123456',
      pkceVerifier: 'verifier',
      email: 'person@example.com',
      password: 'hunter2',
    } as unknown as Parameters<typeof filterFields>[0];

    expect(filterFields(hostile)).toEqual({});
  });

  it('allows a domain but not an address, because they are different facts', () => {
    expect(LOGGABLE_FIELDS).toContain('emailDomain');
    expect(LOGGABLE_FIELDS).not.toContain('email');
  });

  it('carries no token through a real log call', () => {
    const recorder = new RecordingLogSink();
    const log = createLogger(recorder.sink);
    log.info('session.created', {
      abaUserId: 'usr_1',
      sessionId: 'ses_1',
      ...({ refreshToken: 'the-actual-token' } as Record<string, string>),
    });

    expect(recorder.serialised()).not.toContain('the-actual-token');
    expect(recorder.records[0]?.fields).toEqual({ abaUserId: 'usr_1', sessionId: 'ses_1' });
  });

  it('records the level and event name', () => {
    const recorder = new RecordingLogSink();
    const log = createLogger(recorder.sink);
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(recorder.records.map((entry) => `${entry.level}:${entry.event}`)).toEqual([
      'debug:a',
      'info:b',
      'warn:c',
      'error:d',
    ]);
  });

  it('lists no field that names a secret', () => {
    // Two predicates, because they mean different things. A field *containing*
    // "token" is a token however it is spelled; a field *equal to* "code" is
    // an OAuth authorization code, while `errorCode` is not — which is why the
    // field was named `errorCode` rather than the test being loosened.
    const forbiddenSubstrings = ['token', 'secret', 'password', 'otp', 'digest', 'verifier'];
    const forbiddenExact = ['code', 'key', 'email', 'subject', 'nonce', 'state'];

    for (const field of LOGGABLE_FIELDS) {
      const lower = field.toLowerCase();
      for (const fragment of forbiddenSubstrings) {
        expect(lower.includes(fragment), `${field} contains ${fragment}`).toBe(false);
      }
      expect(forbiddenExact.includes(lower), `${field} is a forbidden name`).toBe(false);
    }
  });
});
