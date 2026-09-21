/**
 * Centralised secret redaction (specification sections 21, 33, 63).
 *
 * Every piece of browser-derived data — DOM text, console output, network
 * records, screenshots metadata, tool results — passes through this module
 * before it is written to a log, persisted as evidence, or placed into an AI
 * provider request.
 *
 * Design notes:
 *
 * - Redaction is *lossy on purpose*. The replacement token keeps the shape of
 *   the data (so the model can still reason about "there was a token here")
 *   without carrying the value.
 * - Patterns are ordered from most specific to most general. A value matched by
 *   an earlier rule is already replaced when later rules run, which prevents a
 *   generic rule from re-splitting an already redacted token.
 * - Header and field redaction is name-driven and therefore independent of the
 *   value format; this catches credentials whose shape we do not recognise.
 */

export const REDACTED = '[REDACTED]';

export interface RedactionRule {
  readonly id: string;
  readonly pattern: RegExp;
  /** Replacement, may use capture groups to retain non-secret context. */
  readonly replacement: string;
}

/**
 * Header names whose entire value is a credential.
 * Compared case-insensitively.
 */
export const SENSITIVE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-session-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
];

/**
 * Object/query keys whose value is a credential regardless of format.
 * Compared case-insensitively against a normalised key (non-alphanumerics
 * stripped) so `api_key`, `apiKey` and `api-key` all match.
 */
export const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'apikey',
  'apitoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'sessionid',
  'authtoken',
  'token',
  'credentials',
  'privatekey',
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'ssn',
  'otp',
  'authorization',
  'cookie',
];

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

const SENSITIVE_FIELD_SET = new Set(SENSITIVE_FIELD_NAMES.map(normaliseKey));
const SENSITIVE_HEADER_SET = new Set(SENSITIVE_HEADER_NAMES.map((h) => h.toLowerCase()));

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_SET.has(name.trim().toLowerCase());
}

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_SET.has(normaliseKey(name));
}

/**
 * Value-shaped rules. Each pattern must be global so `String.replace` covers
 * every occurrence.
 */
export const DEFAULT_RULES: readonly RedactionRule[] = [
  // PEM private key blocks — matched first so their base64 body is never
  // re-examined by the generic long-token rule.
  {
    id: 'pem-private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  // JSON Web Tokens (three base64url segments).
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  // HTTP auth header written inline in text (logs, curl snippets, DOM).
  {
    id: 'authorization-header-inline',
    pattern: /\b(authorization|proxy-authorization)\s*[:=]\s*("|')?[^\r\n"',]+/gi,
    replacement: `$1: ${REDACTED}`,
  },
  {
    id: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    id: 'basic-auth',
    pattern: /\bBasic\s+[A-Za-z0-9+/=]{8,}/g,
    replacement: `Basic ${REDACTED}`,
  },
  // Credentials embedded in a URL userinfo component.
  {
    id: 'url-userinfo',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: `$1$2:${REDACTED}@`,
  },
  // Cookie header / document.cookie style pairs.
  {
    id: 'cookie-inline',
    pattern: /\b(set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi,
    replacement: `$1: ${REDACTED}`,
  },
  // Well-known provider key shapes.
  {
    id: 'openai-key',
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g,
    replacement: REDACTED,
  },
  {
    id: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replacement: REDACTED,
  },
  // Length is a range, not an exact count: an exact-length rule silently
  // misses any key whose format shifts, and a miss here leaks a credential.
  { id: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{30,45}/g, replacement: REDACTED },
  {
    id: 'github-token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
    replacement: REDACTED,
  },
  { id: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
  { id: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: REDACTED },
  {
    id: 'stripe-key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacement: REDACTED,
  },
  // `key = value` assignments where the key name marks the value as sensitive.
  // Bounded by quote/whitespace/comma/semicolon so we do not swallow a whole line.
  {
    id: 'named-secret-assignment',
    pattern: new RegExp(
      String.raw`\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_.-]?key|api[_.-]?token|access[_.-]?token|refresh[_.-]?token|id[_.-]?token|session[_.-]?token|auth[_.-]?token|private[_.-]?key)[A-Za-z0-9_.-]*)` +
        String.raw`(\s*[:=]\s*)("([^"\r\n]*)"|'([^'\r\n]*)'|[^\s,;&}\r\n]+)`,
      'gi',
    ),
    replacement: `$1$2${REDACTED}`,
  },
  // Payment card numbers (13-19 digits, optional separators).
  {
    id: 'credit-card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replacement: REDACTED,
  },
];

export interface RedactionResult {
  readonly text: string;
  /** Rule ids that fired, for audit + UI disclosure. */
  readonly appliedRules: readonly string[];
}

/** Redacts secret-shaped values from free text. */
export function redactText(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_RULES,
): RedactionResult {
  let text = input;
  const applied: string[] = [];

  for (const rule of rules) {
    // Reset lastIndex: module-level regexes with /g carry state across calls.
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, rule.replacement);
    applied.push(rule.id);
  }

  return { text, appliedRules: applied };
}

/** Convenience wrapper when the caller only needs the redacted string. */
export function redact(input: string): string {
  return redactText(input).text;
}

/** Redacts a header map by name, then redacts the remaining values by shape. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeaderName(name) ? REDACTED : redact(value);
  }
  return out;
}

const MAX_REDACTION_DEPTH = 12;

/**
 * Deep-redacts an arbitrary JSON-like value.
 *
 * Keys matching `SENSITIVE_FIELD_NAMES` have their value replaced wholesale;
 * every other string is redacted by shape. Cycles are broken, and recursion is
 * depth-bounded so a hostile page cannot cause unbounded work.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_REDACTION_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveFieldName(key) ? REDACTED : redactValue(entry, depth + 1, seen);
  }
  return out;
}
