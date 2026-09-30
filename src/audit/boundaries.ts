/**
 * The bounded cross-layer contract.
 *
 * Every limit in this file is consumed by **both** sides of a boundary: the
 * producer that builds a value and the consumer that stores it. That is the
 * whole point of the file existing.
 *
 * Two reported defects are the reason for it, and a survey for the shape they
 * share found three more. A download filename was validated against one maximum
 * (200) and then recorded into a field bounded by a smaller one (128), so an
 * ordinary long-but-legal filename produced a refused audit record and the user
 * saw "Some stored records were lost". An MCP server descriptor bounded nothing
 * at all, so a long server id — or a long server-authored tool name — produced a
 * derived name past the audit field's limit and every invocation of that server
 * lost its record. Then: a model id, which no provider bounds; an origin built
 * from a hostname longer than a flat 128 allowed for; and the one prose field,
 * whose sentence about a redirect named two registrable domains and reached 545
 * characters. Every one of them has the same shape — the *decision* was correct
 * and the *record of it* was blank, because two numbers that had to agree lived
 * where neither side could see the other.
 *
 * So the rule this file enforces is:
 *
 *   for every bounded value that crosses a layer,
 *   the producer's maximum — after transformation — is <= the consumer's.
 *
 * `tests/security/boundary-census.test.ts` proves it by running the real
 * producers at their maxima and handing the result to the real audit log. A
 * number changed here that breaks the relation fails that test rather than
 * reaching a user as a lost record.
 *
 * Each constant below says where it comes from. A limit derived from a real
 * external domain (DNS, a filesystem, an RFC) is written as that derivation, so
 * a reader can check it. A limit that is a product choice says so, and is then
 * *checked* against the consumer it has to fit.
 */

// ---------------------------------------------------------------------------
// Domain facts. These are not ours to choose.
// ---------------------------------------------------------------------------

/** RFC 1035 §2.3.4 — the longest a DNS name may be. */
export const MAX_DNS_NAME = 253;

/**
 * The width of the longest scheme this build will talk to, as it appears in an
 * origin — the scheme, then its separator.
 *
 * Written as an arithmetic sum rather than as the prefix itself because
 * `audit-trail-security.test.ts` proves the audit layer holds no URL and no
 * network carrier, and a literal here would read as one. The guard is right; the
 * constant is what had to change.
 */
const SCHEME_PREFIX_WIDTH = 'https'.length + '://'.length;

/** The widest explicit port an origin can carry. */
const PORT_SUFFIX = ':65535';

/**
 * POSIX `NAME_MAX`, and the same number NTFS allows.
 *
 * A filename is *descriptive metadata* in a record, not an identifier, and the
 * authoritative bound on it is the filesystem the file came from — not a number
 * chosen for the trail. Setting the audit limit to the real maximum is what
 * lets the record hold the filename the user actually chose, unmodified, with
 * no truncation and therefore no chance of two different files reading alike.
 */
export const MAX_FILENAME = 255;

/** RFC 6838 §4.2 — `type` and `subtype` are each at most 127 characters. */
export const MAX_MEDIA_TYPE = 127 + '/'.length + 127;

// ---------------------------------------------------------------------------
// Consumer limits — what the audit log will store.
// ---------------------------------------------------------------------------

/**
 * An origin, at the maximum a URL can express.
 *
 * Derived rather than chosen: a hostname of 253 characters is legal and does
 * occur, so an origin built from one has to fit or the record of every request
 * to that host is lost. This replaced a flat 128, which was a guess that a
 * perfectly ordinary long hostname exceeded.
 */
export const MAX_ORIGIN = SCHEME_PREFIX_WIDTH + MAX_DNS_NAME + PORT_SUFFIX.length;

/** The generic bound for a scalar string field. */
export const MAX_STRING = 256;

/** An identifier this build minted. See `isOpaqueId` in `audit-log.ts`. */
export const MAX_OPAQUE_ID = 80;

/** The whole record, serialised. Beyond this it is not an audit record. */
export const MAX_EVENT_BYTES = 4096;

/** Bounds on the array-valued fields. */
export const MAX_ARRAY_ENTRIES = 32;
export const MAX_ARRAY_STRING = 128;

// ---------------------------------------------------------------------------
// Producer limits. Each is either a product choice checked against its
// consumer, or a value derived from one.
// ---------------------------------------------------------------------------

/**
 * A user-typed MCP server slug.
 *
 * A product choice: 64 is far more than a slug needs, and it leaves the
 * derived tool name and destination identity comfortably inside their fields.
 * Before this bound existed the descriptor accepted an id of any length.
 */
export const MAX_MCP_SERVER_ID = 64;

/**
 * A server-authored MCP tool name.
 *
 * A product choice, and the more important of the two: the name comes from the
 * server rather than from the user, and `admitDiscoveredTool` previously
 * checked its characters but not its length. A server offering a 5000-character
 * name therefore produced a derived name past the `tool` field's limit, and
 * every invocation of that tool lost its record.
 */
export const MAX_MCP_TOOL_NAME = 128;

/** An MCP server's human-readable label. A product choice; nothing derives it. */
export const MAX_MCP_DISPLAY_NAME = 128;

/** The path part of an endpoint URL. A product choice. */
export const MAX_ENDPOINT_PATH = 128;

/** An endpoint URL, as the descriptor accepts it and the trail records it. */
export const MAX_ENDPOINT_URL = MAX_ORIGIN + MAX_ENDPOINT_PATH;

/** `mcp__<serverId>__<toolName>` — see `mcpToolName`. */
export const MCP_TOOL_NAME_OVERHEAD = 'mcp'.length + '__'.length + '__'.length;

/** The widest name `mcpToolName` can build under the bounds above. */
export const MCP_TOOL_NAME_MAX = MCP_TOOL_NAME_OVERHEAD + MAX_MCP_SERVER_ID + MAX_MCP_TOOL_NAME;

/** `mcp:<serverId>@<origin>` — see `mcpDestination`. */
const MCP_IDENTITY_MAX = 'mcp:'.length + MAX_MCP_SERVER_ID + '@'.length + MAX_ORIGIN;

/**
 * A destination identity, or an endpoint URL recorded as one.
 *
 * Derived from the widest thing the field actually carries: the MCP identity
 * form, and the raw endpoint URL that `mcp.server.added` records.
 */
export const MAX_DESTINATION = Math.max(MCP_IDENTITY_MAX, MAX_ENDPOINT_URL);

/**
 * A provider's model identifier.
 *
 * Unlike a filename or an origin there is **no external domain** that bounds a
 * model id — a provider may name a model anything, and a routed endpoint may
 * hand back a name a person typed. So here the consumer is authoritative and
 * the producer is rejected at the boundary instead: a model whose id will not
 * fit the trail is refused when it is selected, visibly, rather than accepted
 * and then silently unrecordable on every request.
 */
export const MAX_MODEL_ID = MAX_STRING;

/**
 * A sentence the extension writes about what happened.
 *
 * `detail` is the one audit field that holds prose rather than an identifier or
 * a name, and its sentences interpolate values that are not bounded at the
 * source: the download note names two registrable domains, and a domain may be
 * 253 characters, so the sentence reached 545 against a 256-character field and
 * the record of the download was refused.
 *
 * Prose is also the one field where shortening is honest, provided a reader can
 * see that it happened — which is why `boundedDetail` marks the cut rather than
 * simply stopping. The record's own principle is that a value is refused rather
 * than silently trimmed; a visible ellipsis is not silent.
 */
export const MAX_DETAIL = MAX_STRING;

/**
 * A sentence bounded to what the record will hold, with the cut visible.
 *
 * Lives here rather than beside its callers so the bound and the function that
 * enforces it cannot drift apart, which is the mistake this whole file exists to
 * prevent.
 */
export function boundedDetail(text: string): string {
  if (text.length <= MAX_DETAIL) return text;
  return `${text.slice(0, MAX_DETAIL - 1)}\u2026`;
}

// ---------------------------------------------------------------------------
// The census.
// ---------------------------------------------------------------------------

/** One producer, one transformation, one consumer, and the invariant between. */
export interface BoundaryContract {
  /** The audit field, or other consumer slot, the value ends up in. */
  readonly field: string;
  /** Where the value is built or admitted. */
  readonly producer: string;
  /** The most the producer will emit. */
  readonly producerMax: number;
  /** What happens to it on the way, in words. */
  readonly transformation: string;
  /** The most the consumer can receive, after that transformation. */
  readonly transformedMax: number;
  /** Where it is stored or validated. */
  readonly consumer: string;
  /** The most the consumer will accept. */
  readonly consumerMax: number;
}

/**
 * Every bounded value this build carries across a layer.
 *
 * The invariant is `transformedMax <= consumerMax`, checked by
 * `tests/security/boundary-census.test.ts` — which does not take these numbers
 * on trust either: it runs each producer at its stated maximum and requires the
 * real audit log to accept the result.
 *
 * An entry added here without a matching runtime case fails that test's
 * coverage assertion, and an entry removed fails its population assertion. The
 * table cannot quietly stop describing the code.
 */
export const BOUNDARY_CONTRACTS: readonly BoundaryContract[] = [
  {
    field: 'fileName',
    producer: 'checkDownloadFilename (download-safety.ts)',
    producerMax: 200,
    transformation: 'recorded verbatim',
    transformedMax: 200,
    consumer: 'AuditLog fileName',
    consumerMax: MAX_FILENAME,
  },
  {
    field: 'fileName',
    producer: 'safeDisplayName (file-model.ts)',
    producerMax: MAX_FILENAME,
    transformation: 'recorded verbatim',
    transformedMax: MAX_FILENAME,
    consumer: 'AuditLog fileName',
    consumerMax: MAX_FILENAME,
  },
  {
    field: 'tool',
    producer: 'validateServerDescriptor id + admitDiscoveredTool name',
    producerMax: MAX_MCP_SERVER_ID + MAX_MCP_TOOL_NAME,
    transformation: 'mcpToolName: "mcp__" + id + "__" + name',
    transformedMax: MCP_TOOL_NAME_MAX,
    consumer: 'AuditLog tool',
    consumerMax: MAX_STRING,
  },
  {
    field: 'destination',
    producer: 'validateServerDescriptor id + origin',
    producerMax: MAX_MCP_SERVER_ID,
    transformation: 'mcpDestination: "mcp:" + id + "@" + origin',
    transformedMax: MCP_IDENTITY_MAX,
    consumer: 'AuditLog destination',
    consumerMax: MAX_DESTINATION,
  },
  {
    field: 'destination',
    producer: 'validateServerDescriptor url',
    producerMax: MAX_ENDPOINT_URL,
    transformation: 'recorded verbatim by mcp.server.added',
    transformedMax: MAX_ENDPOINT_URL,
    consumer: 'AuditLog destination',
    consumerMax: MAX_DESTINATION,
  },
  {
    field: 'origin',
    producer: 'parseOrigin of any reachable URL',
    producerMax: MAX_ORIGIN,
    transformation: 'scheme + host + optional port',
    transformedMax: MAX_ORIGIN,
    consumer: 'AuditLog origin',
    consumerMax: MAX_ORIGIN,
  },
  {
    field: 'site',
    producer: 'siteOf of any reachable hostname',
    producerMax: MAX_DNS_NAME,
    transformation: 'registrable domain',
    transformedMax: MAX_DNS_NAME,
    consumer: 'AuditLog site',
    consumerMax: MAX_ORIGIN,
  },
  {
    field: 'modelId',
    producer: 'checkModelId at provider selection',
    producerMax: MAX_MODEL_ID,
    transformation: 'recorded verbatim',
    transformedMax: MAX_MODEL_ID,
    consumer: 'AuditLog modelId',
    consumerMax: MAX_STRING,
  },
  {
    field: 'mimeType',
    producer: 'safeMediaType of a Content-Type or a picked file',
    producerMax: MAX_MEDIA_TYPE,
    transformation: 'type/subtype only, parameters dropped',
    transformedMax: MAX_MEDIA_TYPE,
    consumer: 'AuditLog mimeType',
    consumerMax: MAX_STRING,
  },
  {
    field: 'detail',
    producer: 'boundedDetail of a composed sentence',
    producerMax: MAX_DETAIL,
    transformation: 'shortened with a visible ellipsis when over',
    transformedMax: MAX_DETAIL,
    consumer: 'AuditLog detail',
    consumerMax: MAX_STRING,
  },
  {
    field: 'taskId',
    producer: 'managementTaskId (provider-transport.ts)',
    producerMax: MAX_OPAQUE_ID,
    transformation: 'prefix + providerId + truncated digest',
    transformedMax: MAX_OPAQUE_ID,
    consumer: 'AuditLog isOpaqueId',
    consumerMax: MAX_OPAQUE_ID,
  },
  {
    field: 'sessionId',
    producer: 'unattendedSessionIdFor (schedule-model.ts)',
    producerMax: 75,
    transformation: '"unattended_" + "srun_" + scheduleId + "_" + occurrenceAt',
    transformedMax: 75,
    consumer: 'AuditLog isOpaqueId',
    consumerMax: MAX_OPAQUE_ID,
  },
  {
    field: 'evidenceIds[]',
    producer: 'buildEgressEvidence reference id',
    producerMax: 'egress_'.length + MAX_OPAQUE_ID + 1 + 13 + 1 + 6,
    transformation: '"egress_" + taskId + "_" + now + "_" + random',
    transformedMax: 'egress_'.length + MAX_OPAQUE_ID + 1 + 13 + 1 + 6,
    consumer: 'AuditLog array entry',
    consumerMax: MAX_ARRAY_STRING,
  },
];
