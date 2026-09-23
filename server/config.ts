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
  /**
   * Google OAuth, or `null` when this deployment has none.
   *
   * Optional as a whole and required as a group: a deployment either has both
   * halves of a Google client or has no Google sign-in. A client id with no
   * secret would start a server that fails at the one moment it matters, so
   * a partial configuration is a startup error rather than a runtime one.
   */
  readonly google: GoogleOAuthConfig | null;
}

export interface GoogleOAuthConfig {
  readonly clientId: string;
  /**
   * SECRET, and server-side only.
   *
   * Never reaches the extension, the manifest, `dist/`, Chrome storage or a
   * URL. The authorization-code flow exists precisely so this stays here: the
   * client redeems nothing, so it needs nothing to redeem with.
   */
  readonly clientSecret: string;
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
 * Google sign-in, configured as a group or not at all.
 *
 * Not in `REQUIRED_VARIABLES` because a backend without Google sign-in is a
 * working backend — it simply cannot sign anybody in that way, and the routes
 * that would are absent rather than broken.
 */
export const GOOGLE_VARIABLES = [
  { name: 'ABA_GOOGLE_CLIENT_ID', why: "This application's Google client id." },
  { name: 'ABA_GOOGLE_CLIENT_SECRET', why: 'Redeems authorization codes. Secret.' },
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
  'ABA_GOOGLE_CLIENT_SECRET',
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

  // All or nothing. A half-configured Google client is refused here rather
  // than producing a server that starts and then cannot complete a sign-in.
  const clientId = env.ABA_GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.ABA_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  if ((clientId.length === 0) !== (clientSecret.length === 0)) {
    throw new ConfigError(
      clientId.length === 0 ? ['ABA_GOOGLE_CLIENT_ID'] : ['ABA_GOOGLE_CLIENT_SECRET'],
    );
  }
  const google = clientId.length === 0 ? null : { clientId, clientSecret };

  return { publicOrigin, accessTokenSigningKey, databaseUrl, logLevel, google };
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
    // Whether, never which. A client id is not a secret, but printing it here
    // would put it in whatever this description is written to, and an
    // operator only needs to know that Google sign-in is switched on.
    google: config.google === null ? '[not configured]' : '[set]',
    // A length, not a prefix: a prefix of a connection string is a hostname.
    secretsConfigured: String(SECRET_VARIABLES.length),
  };
}
