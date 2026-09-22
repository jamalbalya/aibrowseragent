/**
 * Structured egress destinations (Stage 3 B2, roadmap section 4K).
 *
 * A bare string is not enough to decide whether a transfer may happen. The
 * same hostname reached as an AI provider endpoint, as a page the agent is
 * filling in, and as a navigation target are three different security
 * questions, and the answer depends on the provider identity and the channel
 * as much as on the host.
 *
 * Canonicalisation reuses `parseOrigin`, so scheme, host and port all
 * participate in identity: a grant for `https://a.example` must not cover
 * `https://a.example:8443`, and case must not split one grant into two.
 */

import { BLOCKED_SCHEMES, parseOrigin } from '@/security/origin/origin-validator';
import type { DataSensitivity } from '@/security/exfiltration/exfiltration-guard';
import type { RiskLevel } from '@/policy/risk-classifier';

/**
 * How data leaves.
 *
 * `none` is an explicit assertion that a call transfers nothing, not the
 * absence of a declaration — an omitted field must never read as "no egress".
 */
export const EGRESS_CHANNELS = [
  'none',
  'ai_provider',
  'web_ai_provider',
  'page_write',
  'navigation',
  'clipboard',
  'download',
  'connector',
] as const;

export type EgressChannel = (typeof EGRESS_CHANNELS)[number];

/** Channels that reach outside the extension boundary. */
const EXTERNAL: ReadonlySet<EgressChannel> = new Set<EgressChannel>([
  'ai_provider',
  'web_ai_provider',
  'page_write',
  'navigation',
  'clipboard',
  'download',
  'connector',
]);

export function isExternalChannel(channel: EgressChannel): boolean {
  return EXTERNAL.has(channel);
}

export interface EgressDestination {
  readonly channel: EgressChannel;
  /**
   * Canonical identity used for consent and policy.
   *
   * `scheme://host[:port]` for a URL destination, `providerId@origin` for a
   * provider. `null` when it could not be determined, which denies.
   */
  readonly identity: string | null;
  readonly origin?: string;
  readonly providerId?: string;
  /**
   * The connected account this request belongs to.
   *
   * Separate from `identity`, and the reason is the whole point of having it.
   * `identity` is `providerId@origin`, which is a property of the *endpoint*:
   * two OpenAI accounts both resolve to `openai-compatible@https://api.openai.com`.
   * Without this field a task pinned to one account would match the other, so
   * consent granted for a personal key would silently authorise a work key —
   * different entitlements, different billing, different data agreement.
   */
  readonly connectionId?: string;
  readonly modelId?: string;
  /** Tab the transfer acts on, for evidence. Not part of the consent key. */
  readonly tabId?: number;
  readonly frameId?: number;
  /** Model-supplied description. Evidence only — never constrains anything. */
  readonly purpose?: string;
  readonly sensitivity?: DataSensitivity;
  readonly risk?: RiskLevel;
}

/**
 * Canonical identity for a URL.
 *
 * Returns `null` rather than a fallback string when the URL cannot be parsed.
 * An unparseable destination is unknown, and unknown denies; inventing an
 * identity here would manufacture a grant key that matches nothing real.
 */
export function canonicalUrlIdentity(url: string): string | null {
  const info = parseOrigin(url);
  if (!info) return null;
  // `javascript:`, `data:` and friends parse as URLs but are not destinations
  // — they are execution or inlining vectors. Treating one as an identity
  // would mint a consent key for something that cannot be reasoned about.
  if (BLOCKED_SCHEMES.includes(info.protocol)) return null;
  return info.origin.toLowerCase();
}

/** Canonical identity for a provider endpoint. */
export function canonicalProviderIdentity(providerId: string, baseUrl: string): string | null {
  const origin = canonicalUrlIdentity(baseUrl);
  if (!origin) return null;
  const id = providerId.trim().toLowerCase();
  if (id.length === 0) return null;
  return `${id}@${origin}`;
}

export function describeDestination(destination: EgressDestination): string {
  if (destination.identity === null) return 'an unrecognised destination';
  if (destination.providerId !== undefined) {
    return `${destination.providerId} (${destination.origin ?? destination.identity})`;
  }
  return destination.origin ?? destination.identity;
}

/** A navigation, page-write or download destination built from a URL. */
export function urlDestination(
  channel: Extract<EgressChannel, 'navigation' | 'page_write' | 'web_ai_provider' | 'download'>,
  url: string,
  extra: { tabId?: number; frameId?: number; purpose?: string } = {},
): EgressDestination {
  const info = parseOrigin(url);
  const identity = canonicalUrlIdentity(url);
  return {
    channel,
    identity,
    ...(info ? { origin: info.origin } : {}),
    ...(extra.tabId === undefined ? {} : { tabId: extra.tabId }),
    ...(extra.frameId === undefined ? {} : { frameId: extra.frameId }),
    ...(extra.purpose === undefined ? {} : { purpose: extra.purpose }),
  };
}

/** An AI provider destination. */
export function providerDestination(
  providerId: string,
  baseUrl: string,
  modelId?: string,
  connectionId?: string,
): EgressDestination {
  const info = parseOrigin(baseUrl);
  return {
    channel: 'ai_provider',
    identity: canonicalProviderIdentity(providerId, baseUrl),
    ...(info ? { origin: info.origin } : {}),
    providerId,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(modelId === undefined ? {} : { modelId }),
  };
}

/**
 * Canonical identity for a connector endpoint.
 *
 * `connectorId@origin`, the same shape a provider uses and deliberately in a
 * different channel. A connector must never collide with an AI provider on
 * identity: they are separate domains, a grant for one is never a grant for
 * the other, and only the `ai_provider` channel takes the task's provider
 * pin — so a connector call always falls through to the consent path rather
 * than inheriting the provider's standing authorization.
 */
export function canonicalConnectorIdentity(connectorId: string, url: string): string | null {
  const origin = canonicalUrlIdentity(url);
  if (!origin) return null;
  const id = connectorId.trim().toLowerCase();
  if (id.length === 0) return null;
  return `${id}@${origin}`;
}

/** An external service destination reached through a connector. */
export function connectorDestination(
  connectorId: string,
  url: string,
  extra: { purpose?: string; sensitivity?: DataSensitivity } = {},
): EgressDestination {
  const info = parseOrigin(url);
  return {
    channel: 'connector',
    identity: canonicalConnectorIdentity(connectorId, url),
    ...(info ? { origin: info.origin } : {}),
    ...(extra.purpose === undefined ? {} : { purpose: extra.purpose }),
    ...(extra.sensitivity === undefined ? {} : { sensitivity: extra.sensitivity }),
  };
}

/** A declaration that a call transfers nothing outward. */
export function noEgress(): EgressDestination {
  return { channel: 'none', identity: null };
}
