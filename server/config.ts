/**
 * Configuration, injected from the environment.
 *
 * Two rules, and the second is the one that matters:
 *
 *  - **No secret has a default.** A missing signing key is a startup failure,
 *    not a fallback to a development value. A development default is a
 *    production secret the first time someone forgets to set the real one,
 *    and it is indistinguishable from a working system until it is exploited.
 *  - **Nothing is committed.** `.env` and `.env.*` are already gitignored, and
 *    `.env.example` carries names with empty values so the required set is
 *    discoverable without any value being present.
 *
 * The repository had no configuration mechanism before this: the extension has
 * no server secrets, and provider credentials live in `chrome.storage.local`.
 * This is therefore the first one, and it is deliberately minimal — a plain
 * reader over a caller-supplied environment record, with no file loading, no
 * network lookup and no dependency.
 */

export interface ServerConfig {
  /** Where the backend believes it is reachable. Used to build redirect URIs. */
  readonly publicOrigin: string;
  /** Signs access tokens. Required; never defaulted. */
  readonly accessTokenSigningKey: string;
  /** Postgres connection string. Required; never defaulted. */
  readonly databaseUrl: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Missing required configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Every variable that must be present, with the reason it is required. */
export const REQUIRED_VARIABLES = [
  { name: 'ABA_PUBLIC_ORIGIN', why: 'The origin the backend is reachable at.' },
  { name: 'ABA_ACCESS_TOKEN_SIGNING_KEY', why: 'Signs access tokens. Secret.' },
  { name: 'ABA_DATABASE_URL', why: 'Database connection string. Secret.' },
] as const;

/**
 * Variables whose value is a secret.
 *
 * Named so the invariant suite can assert that no secret variable has a
 * default anywhere in this module, and so an operator can see at a glance
 * which values need a secret store rather than a config map.
 */
export const SECRET_VARIABLES: readonly string[] = [
  'ABA_ACCESS_TOKEN_SIGNING_KEY',
  'ABA_DATABASE_URL',
];

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function isLogLevel(value: string): value is ServerConfig['logLevel'] {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads configuration, or throws naming every missing variable at once.
 *
 * All of them, not the first: an operator fixing one variable per restart is
 * an operator who will eventually paste a value into the wrong place.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      missing.push(name);
      return '';
    }
    return value;
  };

  const publicOrigin = read('ABA_PUBLIC_ORIGIN');
  const accessTokenSigningKey = read('ABA_ACCESS_TOKEN_SIGNING_KEY');
  const databaseUrl = read('ABA_DATABASE_URL');
  if (missing.length > 0) throw new ConfigError(missing);

  // Non-secret, so a default is safe and useful.
  const rawLevel = env.ABA_LOG_LEVEL ?? 'info';
  const logLevel = isLogLevel(rawLevel) ? rawLevel : 'info';

  return { publicOrigin, accessTokenSigningKey, databaseUrl, logLevel };
}

/**
 * Redacts a config for display.
 *
 * Returns the **names** of secret variables and never their values, so
 * "what is configured?" is answerable without printing anything.
 */
export function describeConfig(config: ServerConfig): Record<string, string> {
  return {
    publicOrigin: config.publicOrigin,
    logLevel: config.logLevel,
    accessTokenSigningKey: '[set]',
    databaseUrl: '[set]',
    // A length, not a prefix: a prefix of a connection string is a hostname.
    secretsConfigured: String(SECRET_VARIABLES.length),
  };
}
