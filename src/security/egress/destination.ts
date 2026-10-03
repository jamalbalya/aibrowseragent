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
  /**
   * An external MCP server this build calls out to (P-026).
   *
   * A channel of its own rather than a reuse of `connector`, for the reason
   * `identity` is one: the rules differ. A connector is a descriptor this
   * project wrote, reaching origins that descriptor declares, with operations
   * this project named. An MCP server is chosen by the user at run time and
   * offers tools this project has never seen, so the origin is the *only*
   * thing known about it in advance and every tool name came from the far
   * side. Folding the two together would let a connector's declared-origin
   * reasoning read as though it applied here, where there is no descriptor to
   * declare anything.
   *
   * It never carries a credential of this build's own: `SECRET_LOCAL_ONLY`
   * data reaches no server, and the only authorization an MCP request carries
   * is one the user attached to that server.
   */
  'mcp',
  /**
   * The AI Browser Agent authentication backend, and nothing else.
   *
   * A channel of its own rather than a reuse of `connector`, because the two
   * are different domains with different rules: a connector is user-chosen
   * and reaches whatever origins its descriptor declares, while this reaches
   * exactly one pinned origin and carries a fixed, narrow payload — a
   * challenge id, an exchange code, a refresh token. It carries no task
   * context and no page-derived value, and there is no shape in which it
   * could: see `src/identity/identity-transport.ts`.
   */
  'identity',
  /**
   * Authorizing an AI provider account — one vendor's token endpoint.
   *
   * A channel of its own rather than a reuse of `ai_provider` or `identity`,
   * because it is neither. `ai_provider` carries task data to an inference
   * endpoint under a consent pin; this carries an authorization code and a
   * refresh token to a token endpoint and no task data at all. `identity`
   * reaches this project's own backend to establish a *product* account; this
   * reaches a third party to obtain a *provider* credential, and conflating
   * the two is exactly the confusion the product is trying to remove — a user
   * who authorizes Google for Gemini has not signed in to anything here.
   *
   * It carries no page-derived value and no secret of this build's own: a
   * Chrome Extension OAuth client has no client secret, so there is none to
   * send.
   */
  'provider_auth',
] as const;

export type EgressChannel = (typeof EGRESS_CHANNELS)[number];

/** Channels that reach outside the extension boundary. */
const EXTERNAL: ReadonlySet<EgressChannel> = new Set<EgressChannel>([
  // Authentication leaves the device, so it is external and is authorised
  // like everything else that does. Calling it internal would be the easy
  // mistake and would take the one request that carries a bearer token out
  // of the gate's sight.
  'identity',
  'ai_provider',
  'web_ai_provider',
  'page_write',
  'navigation',
  'clipboard',
  'download',
  'connector',
  'mcp',
  // Obtaining a provider credential leaves the device, so it is authorised
  // like everything else that does.
  'provider_auth',
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
/**
 * The authentication backend, pinned to one origin.
 *
 * The identity is the origin itself, with no per-caller component, because
 * there is exactly one destination and nothing chooses it. A URL that is not
 * on that origin yields a `null` identity, which the gate denies — so an
 * off-origin authentication request is refused by the same rule that refuses
 * any unrecognisable destination, rather than by a check somebody has to
 * remember to write.
 */
export function identityDestination(backendOrigin: string, url: string): EgressDestination {
  const info = parseOrigin(url);
  const expected = parseOrigin(backendOrigin);
  const matches = info !== null && expected !== null && info.origin === expected.origin;
  return {
    channel: 'identity',
    identity: matches ? `identity@${info.origin}` : null,
    ...(info ? { origin: info.origin } : {}),
    purpose: 'authentication',
  };
}

/**
 * The destination for a provider authorization request.
 *
 * Pinned the way `identityDestination` is pinned, and for the same reason: a
 * URL off the expected origin yields a `null` identity, which the gate denies —
 * so a token exchange aimed anywhere else is refused by the rule that refuses
 * every unrecognisable destination, rather than by a check somebody has to
 * remember to write.
 */
export function providerAuthDestination(
  providerId: string,
  expectedEndpoint: string,
  url: string,
): EgressDestination {
  const info = parseOrigin(url);
  const expected = parseOrigin(expectedEndpoint);
  const matches = info !== null && expected !== null && info.origin === expected.origin;
  return {
    channel: 'provider_auth',
    identity: matches ? `provider-auth:${providerId}@${info.origin}` : null,
    ...(info ? { origin: info.origin } : {}),
    purpose: 'account authorization',
  };
}

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

/**
 * Canonical identity for an MCP server endpoint.
 *
 * `mcp:<serverId>@<origin>`, so two servers at one origin are two identities
 * and one server moved to a new origin is a new identity. The prefix is there
 * so an MCP identity can never be mistaken for a connector's in a stored
 * consent record, which would otherwise be possible the moment a connector id
 * and a server id coincided — and server ids are user-chosen.
 */
export function canonicalMcpIdentity(serverId: string, url: string): string | null {
  const origin = canonicalUrlIdentity(url);
  if (!origin) return null;
  const id = serverId.trim().toLowerCase();
  if (id.length === 0) return null;
  return `mcp:${id}@${origin}`;
}

/**
 * The destination for one MCP request.
 *
 * `purpose` carries the JSON-RPC method rather than a tool name. A tool name
 * came from the server, and a server-authored string in a consent key or an
 * evidence record is a string the server chose — the method is this build's own
 * vocabulary and says as much about the call.
 */
export function mcpDestination(
  serverId: string,
  url: string,
  extra: { method?: string; sensitivity?: DataSensitivity } = {},
): EgressDestination {
  const info = parseOrigin(url);
  return {
    channel: 'mcp',
    identity: canonicalMcpIdentity(serverId, url),
    ...(info ? { origin: info.origin } : {}),
    ...(extra.method === undefined ? {} : { purpose: extra.method }),
    ...(extra.sensitivity === undefined ? {} : { sensitivity: extra.sensitivity }),
  };
}

/** A declaration that a call transfers nothing outward. */
export function noEgress(): EgressDestination {
  return { channel: 'none', identity: null };
}
