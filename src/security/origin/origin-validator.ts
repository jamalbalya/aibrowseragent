/**
 * Origin safety (specification sections 22, 31).
 *
 * Authorisation is never carried blindly across an origin change. Every
 * sensitive action re-reads the tab's live URL and compares it against the
 * origin recorded when the action was planned.
 */

export interface OriginInfo {
  /** `https://example.com` — scheme + host + port, no path. */
  readonly origin: string;
  readonly hostname: string;
  readonly protocol: string;
  /** Registrable-ish site used for same-site comparison, e.g. `example.com`. */
  readonly site: string;
}

/**
 * Schemes the agent must never automate, whatever the settings say.
 *
 * `chrome://` and friends host browser settings and other extensions;
 * `javascript:` and `data:` are script-injection vectors.
 *
 * `file:` and `ftp:` are here for a specific reason. The "allow insecure
 * origins" setting exists so a developer can automate an `http://` dev server,
 * and it would otherwise also unlock `file:` — turning a convenience toggle
 * into local filesystem reach. The agent has no legitimate need for either
 * scheme, so neither is reachable through that setting, or any other.
 */
export const BLOCKED_SCHEMES: readonly string[] = [
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
  'javascript:',
  'data:',
  'blob:',
  'filesystem:',
  'view-source:',
  'about:',
  'edge:',
  'brave:',
  'opera:',
  'file:',
  'ftp:',
];

/**
 * Hosts serving the Chrome Web Store and extension galleries. Content scripts
 * cannot run there and automating them is a privilege-escalation path.
 */
export const BLOCKED_HOSTS: readonly string[] = [
  'chrome.google.com',
  'chromewebstore.google.com',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com',
];

/**
 * Suffixes treated as a single site for same-site comparison. This is a small
 * curated list, not a full Public Suffix List: we deliberately fall back to a
 * conservative two-label heuristic rather than shipping a stale PSL copy.
 */
const MULTI_LABEL_SUFFIXES: readonly string[] = [
  'co.uk',
  'co.jp',
  'co.id',
  'co.in',
  'co.kr',
  'co.nz',
  'co.za',
  'com.au',
  'com.br',
  'com.cn',
  'com.mx',
  'com.sg',
  'com.tr',
  'ac.uk',
  'gov.uk',
  'org.uk',
  'net.au',
  'org.au',
  'go.id',
  'ac.id',
  'or.id',
  'github.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Derives the comparison "site" for a hostname. */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return host;
  if (IPV4.test(host) || host.includes(':') || host === 'localhost') return host;

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  for (const suffix of MULTI_LABEL_SUFFIXES) {
    if (host === suffix) return host;
    if (host.endsWith(`.${suffix}`)) {
      const suffixLabels = suffix.split('.').length;
      return labels.slice(-(suffixLabels + 1)).join('.');
    }
  }
  return labels.slice(-2).join('.');
}

export function parseOrigin(url: string): OriginInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  return {
    origin: parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin,
    hostname,
    protocol: parsed.protocol.toLowerCase(),
    site: siteOf(hostname),
  };
}

export type OriginRejectionReason =
  'INVALID_URL' | 'BLOCKED_SCHEME' | 'BLOCKED_HOST' | 'INSECURE_SCHEME';

export interface OriginCheck {
  readonly allowed: boolean;
  readonly info: OriginInfo | null;
  readonly reason?: OriginRejectionReason;
  readonly detail?: string;
}

export interface OriginCheckOptions {
  /** Permit `http:` and `file:` pages. Off by default. */
  readonly allowInsecure?: boolean;
}

/** Decides whether the agent may operate on a URL at all. */
export function checkNavigable(url: string, options: OriginCheckOptions = {}): OriginCheck {
  const info = parseOrigin(url);
  if (!info) {
    return {
      allowed: false,
      info: null,
      reason: 'INVALID_URL',
      detail: 'URL could not be parsed.',
    };
  }
  if (BLOCKED_SCHEMES.includes(info.protocol)) {
    return {
      allowed: false,
      info,
      reason: 'BLOCKED_SCHEME',
      detail: `The scheme ${info.protocol} is not automatable.`,
    };
  }
  if (BLOCKED_HOSTS.includes(info.hostname)) {
    return {
      allowed: false,
      info,
      reason: 'BLOCKED_HOST',
      detail: `${info.hostname} is a browser extension gallery and cannot be automated.`,
    };
  }
  const secure =
    info.protocol === 'https:' ||
    info.hostname === 'localhost' ||
    info.hostname === '127.0.0.1' ||
    info.hostname === '::1';
  if (!secure && !options.allowInsecure) {
    return {
      allowed: false,
      info,
      reason: 'INSECURE_SCHEME',
      detail: `${info.protocol} pages require the "allow insecure origins" setting.`,
    };
  }
  return { allowed: true, info };
}

export type OriginRelation = 'same-origin' | 'same-site' | 'cross-site' | 'unknown';

export function compareOrigins(before: string, after: string): OriginRelation {
  const a = parseOrigin(before);
  const b = parseOrigin(after);
  if (!a || !b) return 'unknown';
  if (a.origin === b.origin) return 'same-origin';
  if (a.site === b.site && a.site.length > 0) return 'same-site';
  return 'cross-site';
}

export interface OriginTransition {
  readonly relation: OriginRelation;
  readonly changed: boolean;
  /** True when the transition must force a fresh policy evaluation. */
  readonly requiresRevalidation: boolean;
  readonly from: string;
  readonly to: string;
}

/**
 * Classifies a navigation that happened between planning and execution.
 *
 * A same-origin change is benign. Anything else — including an unparseable
 * target — forces re-evaluation before a sensitive action proceeds.
 */
export function evaluateTransition(from: string, to: string): OriginTransition {
  const relation = compareOrigins(from, to);
  const changed = relation !== 'same-origin';
  return {
    relation,
    changed,
    requiresRevalidation: relation !== 'same-origin',
    from,
    to,
  };
}
