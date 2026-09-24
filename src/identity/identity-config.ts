/**
 * Where the authentication backend is, and what may be sent to it.
 *
 * One origin, configured at build time and never at run time. A backend
 * origin that could be set from a message would be a backend origin an
 * attacker could set, and the whole value of pinning it is that nothing can.
 *
 * **There is no default.** A build with no configured origin has no
 * authentication, which is the honest state for this phase: the backend is
 * not deployed. `isIdentityConfigured` is what the panel reads to decide
 * whether to offer sign-in at all, so the absence surfaces as a disabled
 * button rather than as a request to nowhere.
 */

export interface IdentityConfig {
  /** `https://…`, origin only. Every identity request must be on it. */
  readonly backendOrigin: string;
}

/**
 * Read from the build-time environment.
 *
 * `import.meta.env` is inlined by Vite at build time, so this is a constant
 * in the shipped bundle rather than something the extension looks up.
 */
function configuredOrigin(): string | null {
  const raw: unknown = (import.meta as { env?: Record<string, unknown> }).env
    ?.VITE_ABA_BACKEND_ORIGIN;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    // https only. An authentication request over http is a bearer token in
    // clear text, and a localhost exception here would ship to everybody.
    if (url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function loadIdentityConfig(): IdentityConfig | null {
  const origin = configuredOrigin();
  return origin === null ? null : { backendOrigin: origin };
}

export function isIdentityConfigured(): boolean {
  return loadIdentityConfig() !== null;
}

/** The endpoints this phase uses. Relative, so the origin stays pinned. */
export const IDENTITY_PATHS = {
  googleStart: '/v1/auth/start',
  emailStart: '/v1/auth/email/start',
  emailVerify: '/v1/auth/email/verify',
  exchange: '/v1/auth/exchange',
  refresh: '/v1/auth/refresh',
  logout: '/v1/auth/logout',
  me: '/v1/me',
  devices: '/v1/devices',
} as const;
