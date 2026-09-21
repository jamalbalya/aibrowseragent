/**
 * Data exfiltration defence (specification sections 20, 32).
 *
 * The guard answers one question: is this tool call about to move data from a
 * private source to a destination that did not produce it?
 *
 * It operates on the *taint* recorded by the runtime — which sources the
 * current task has read from — rather than on model intent, so a model that is
 * convinced it has permission still cannot move the data.
 */

import { siteOf, parseOrigin } from '@/security/origin/origin-validator';
import { isSensitiveFieldName, DEFAULT_RULES } from '@/security/redaction/secret-redactor';

export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'secret';

const SENSITIVITY_RANK: Record<DataSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

export function maxSensitivity(a: DataSensitivity, b: DataSensitivity): DataSensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/** A source the current task has read data from. */
export interface TaintSource {
  readonly sourceType: string;
  /** Origin or connector site, used to decide whether a destination matches. */
  readonly site?: string;
  readonly sensitivity: DataSensitivity;
}

export interface ExfiltrationRequest {
  /** Where the data is about to go: a URL, or a connector site. */
  readonly destination: string;
  /** Payload being written out. */
  readonly payload: unknown;
  /** Sources this task has read from so far. */
  readonly taint: readonly TaintSource[];
}

export type ExfiltrationVerdict = 'allow' | 'confirm' | 'block';

export interface ExfiltrationDecision {
  readonly verdict: ExfiltrationVerdict;
  readonly reason: string;
  readonly sensitivity: DataSensitivity;
  readonly destinationSite: string | null;
  readonly matchedSources: readonly string[];
}

/** Detects credential-shaped values anywhere in a payload. */
export function payloadContainsSecret(payload: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof payload === 'string') {
    return DEFAULT_RULES.some((rule) => {
      rule.pattern.lastIndex = 0;
      const hit = rule.pattern.test(payload);
      rule.pattern.lastIndex = 0;
      return hit;
    });
  }
  if (payload === null || typeof payload !== 'object') return false;
  if (Array.isArray(payload)) {
    return payload.some((item) => payloadContainsSecret(item, depth + 1));
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isSensitiveFieldName(key) && value !== undefined && value !== null && value !== '') {
      return true;
    }
    if (payloadContainsSecret(value, depth + 1)) return true;
  }
  return false;
}

function destinationSiteOf(destination: string): string | null {
  const info = parseOrigin(destination);
  if (info) return info.site;
  // Bare host or connector identifier.
  const trimmed = destination.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return /^[a-z0-9.-]+$/.test(trimmed) ? siteOf(trimmed) : null;
}

/**
 * Evaluates whether a write may proceed.
 *
 * Rules, in order:
 *  1. Credentials never leave, regardless of destination. Hard block.
 *  2. Data tainted `confidential`/`secret` going to a site that is not one of
 *     its sources requires explicit elevated confirmation.
 *  3. `internal` data crossing sites requires confirmation.
 *  4. Everything else is allowed.
 */
export function evaluateExfiltration(request: ExfiltrationRequest): ExfiltrationDecision {
  const destinationSite = destinationSiteOf(request.destination);

  const sensitivity = request.taint.reduce<DataSensitivity>(
    (acc, source) => maxSensitivity(acc, source.sensitivity),
    'public',
  );

  if (payloadContainsSecret(request.payload)) {
    return {
      verdict: 'block',
      reason:
        'The payload contains credential-shaped data. Sending secrets to any destination is prohibited.',
      sensitivity: 'secret',
      destinationSite,
      matchedSources: [],
    };
  }

  const foreignSources = request.taint.filter((source) => {
    if (SENSITIVITY_RANK[source.sensitivity] < SENSITIVITY_RANK.internal) return false;
    if (!source.site || !destinationSite) return true;
    return source.site !== destinationSite;
  });

  if (foreignSources.length === 0) {
    return {
      verdict: 'allow',
      reason: 'No private data from a different source is involved in this write.',
      sensitivity,
      destinationSite,
      matchedSources: [],
    };
  }

  const matchedSources = foreignSources.map((s) => s.sourceType);
  const highest = foreignSources.reduce<DataSensitivity>(
    (acc, source) => maxSensitivity(acc, source.sensitivity),
    'public',
  );

  return {
    verdict: 'confirm',
    reason:
      `This task has read ${highest} data from ${matchedSources.join(', ')} and is about to send ` +
      `it to ${destinationSite ?? 'an unrecognised destination'}. Explicit approval is required.`,
    sensitivity,
    destinationSite,
    matchedSources,
  };
}
