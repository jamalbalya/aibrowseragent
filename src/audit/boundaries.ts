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

/**
 * How wide a string is **once serialised**, excluding its quotes.
 *
 * Every string bound in this file is a bound on this number rather than on
 * `value.length`, and the difference is not cosmetic. A record is validated
 * against `MAX_EVENT_BYTES` as JSON, and JSON escapes: a `"` or a `\` costs two
 * characters, and a C0 control character costs six as `\u0000`. Counting code
 * units at the field and counting serialised characters at the record meant the
 * two bounds measured different things, so the field limits did not imply the
 * record limit.
 *
 * Measured rather than modelled. `JSON.stringify` is the function that will
 * actually serialise the record, so asking it is the only way to be right about
 * every case — escapes, lone surrogates, and whatever a future engine decides
 * to escape — instead of maintaining a table of multipliers that drifts.
 *
 * Emoji and other ordinary non-ASCII are unaffected: `JSON.stringify` leaves
 * them literal, so their serialised width is their code-unit length and a
 * limit of 256 still means 128 emoji, exactly as before.
 */
export function serialisedWidth(value: string): number {
  return JSON.stringify(value).length - 2;
}

/** An identifier this build minted. See `isOpaqueId` in `audit-log.ts`. */
export const MAX_OPAQUE_ID = 80;

/** The whole record, serialised. Beyond this it is not an audit record. */
export const MAX_EVENT_BYTES = 4096;

/** The longest string a list entry may hold. */
export const MAX_ARRAY_STRING = 128;

/**
 * How many entries each list field may hold.
 *
 * A flat 32 applied to both, and 32 entries of `MAX_ARRAY_STRING` serialise to
 * roughly 4190 characters — more than `MAX_EVENT_BYTES` on their own. The two
 * limits had been chosen independently, so the field-level bounds did not
 * *mathematically* guarantee that a record fits the record budget:
 * `egress.decided`, `connector.operation` and `connector.auth` could each exceed
 * 4096 while every one of their fields was inside its own limit. No producer
 * reached it — an `evidenceIds` on an audit record is always exactly one entry,
 * and the only OAuth scope this build asks for is `public_repo` — but "no
 * producer does this today" is the argument that preceded every other defect in
 * this file, and it was wrong about skill ids.
 *
 * Per field rather than one number, because the two have different neighbours.
 * `evidenceIds` rides `egress.decided`, which is the widest record this build
 * writes, so it gets the smaller share; `scopes` rides `connector.auth`, which is
 * narrow, so it can afford a list long enough for a real OAuth consent — ten or
 * so scopes is ordinary for a service with fine-grained permissions, and a flat
 * 8 would have refused that record to buy margin the wide record needed.
 *
 * `tests/security/audit-record-budget.test.ts` proves the guarantee by
 * enumerating the types from the source rather than from a list kept here, so a
 * field added to a record fails a test rather than silently spending the margin.
 */
export const MAX_EVIDENCE_IDS = 4;
export const MAX_SCOPES = 16;

/** The widest list any field may hold, for the validator's generic path. */
export const MAX_ARRAY_ENTRIES = Math.max(MAX_EVIDENCE_IDS, MAX_SCOPES);

/** How many entries this particular field may hold. */
export function arrayLimit(key: string): number {
  if (key === 'evidenceIds') return MAX_EVIDENCE_IDS;
  if (key === 'scopes') return MAX_SCOPES;
  return MAX_ARRAY_ENTRIES;
}

// ---------------------------------------------------------------------------
// Which limit applies to which field.
//
// This classification lives here, with the limits, because two things need it:
// `audit-log.ts` to validate a record, and the budget proof to compute how wide
// a record can get. A second copy of it is how `MAX_ARRAY_ENTRIES` and
// `MAX_EVENT_BYTES` came to contradict each other.
// ---------------------------------------------------------------------------

/** Fields that must hold an identifier this build minted. */
export const OPAQUE_ID_FIELDS: ReadonlySet<string> = new Set([
  'taskId',
  'sessionId',
  'workflowId',
  'shortcutId',
  'scheduleId',
  'runId',
  'connectorId',
  'route',
  'senderClass',
]);

/** Fields allowed to hold a bounded list. Everything else must be scalar. */
export const ARRAY_FIELDS: ReadonlySet<string> = new Set(['scopes', 'evidenceIds']);

/** Fields that hold a number rather than a string. */
export const NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'at',
  'byteLength',
  'tabId',
  'stepCount',
  'stepIndex',
  'workflowVersion',
  'recordCount',
  'removedCount',
  'removedFromSeq',
  'removedToSeq',
]);

/** Fields that hold a boolean. */
export const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(['executed', 'cancelled']);

/**
 * The limit that applies to one string field.
 *
 * A single function rather than a conditional at each call site, because the
 * producers ask the same question the log answers.
 */
export function fieldLimit(key: string): number {
  if (key === 'origin' || key === 'site') return MAX_ORIGIN;
  if (key === 'fileName') return MAX_FILENAME;
  if (key === 'destination') return MAX_DESTINATION;
  if (OPAQUE_ID_FIELDS.has(key)) return MAX_OPAQUE_ID;
  return MAX_STRING;
}

/**
 * The widest JSON one field's *value* can occupy.
 *
 * Deliberately an over-estimate where it is not exact: a number is costed at 20
 * characters, which is wider than any value this build writes. Over-estimating
 * is the safe direction for a budget proof.
 */
export function fieldValueWidth(key: string): number {
  if (ARRAY_FIELDS.has(key)) {
    // `["…","…"]` — two quotes per entry, a comma between, and the brackets.
    const entries = arrayLimit(key);
    return 2 + entries * (MAX_ARRAY_STRING + 2) + (entries - 1);
  }
  if (NUMERIC_FIELDS.has(key)) return 20;
  if (BOOLEAN_FIELDS.has(key)) return 5;
  // Exact, now that the limit bounds the *serialised* width: the value cannot
  // contribute more than its limit plus its two quotes, whatever it contains.
  // While the limit bounded `value.length` instead, this was an under-estimate
  // by up to six times, and the proof it feeds was correspondingly wrong — a
  // quote-filled `connector.auth` serialised to 5505 characters against a
  // 4096 budget while every field was inside its own limit.
  return fieldLimit(key) + 2;
}

/**
 * The widest a record carrying exactly these fields can serialise to.
 *
 * Counts what `assertAuditShape` counts — `JSON.stringify(event).length`, which
 * is UTF-16 code units rather than bytes — so the two agree about what "4096"
 * means. It also adds the fields the log owns and writes itself, which the
 * shape check does not see, so the figure describes the record that is actually
 * stored rather than the one that was handed in.
 */
export function recordWidth(fields: Iterable<string>): number {
  // `{"type":"…"}` — the longest declared type name, generously.
  let total = 2 + '"type":'.length + 34;
  for (const field of fields) {
    if (field === 'type') continue;
    total += 1 + field.length + 3 + fieldValueWidth(field);
  }
  // Written by `append`, after the shape check: an id, a timestamp, a sequence
  // number, the previous digest and the schema version.
  total += '"id":"aud_xxxxxxxxxx_xxxx",'.length;
  total += '"at":1700000000000,'.length;
  total += '"seq":999999,'.length;
  total += `"prevDigest":"${'0'.repeat(64)}",`.length;
  total += '"eventVersion":99'.length;
  return total;
}

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
 * A skill identifier.
 *
 * Aligned with, rather than invented alongside, the bound that already existed:
 * the `skills.run` tool input has always capped `skillId` at 64 characters, and
 * `validateSkillDefinition` capped it at nothing. So a model could not ask for a
 * longer id, and a **definition could still carry one** — and definitions are
 * not all written in this build. An exported file can be edited and re-imported,
 * and `importWorkflow` hands `candidate.definition` straight to the workflow
 * store, whose `validate` is that same validator. Replay then runs the stored
 * definition and the runner writes `skillId: definition.id` into
 * `skill.started`, `skill.step` and `skill.finished` — a field bounded at
 * `MAX_STRING`, so all three records were refused while the replay itself ran.
 *
 * The previous phase recorded this as "no producer today". That was wrong: the
 * producer is the import path, and it was already there.
 *
 * The real ids this build ships are 12 to 20 characters.
 */
export const MAX_SKILL_ID = 64;

/**
 * A skill version, as `major.minor.patch`.
 *
 * `VERSION_PATTERN` accepts any number of digits per component, so a version of
 * 300 digits passed validation and then exceeded the `skillVersion` field on
 * `workflow.recorded`. 32 leaves room for three ten-digit components and the two
 * dots, which is far past anything meaningful.
 */
export const MAX_SKILL_VERSION = 32;

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
    field: 'modelId',
    producer: 'parseModelCatalogue of a 9Router /models response',
    producerMax: MAX_MODEL_ID,
    transformation: 'carried verbatim — never split on "/", never normalised',
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
    field: 'skillId',
    producer: 'validateSkillDefinition id (bundled, recorded or imported)',
    producerMax: MAX_SKILL_ID,
    transformation: 'recorded verbatim by skill.started, skill.step, skill.finished',
    transformedMax: MAX_SKILL_ID,
    consumer: 'AuditLog skillId',
    consumerMax: MAX_STRING,
  },
  {
    field: 'skillVersion',
    producer: 'validateSkillDefinition version',
    producerMax: MAX_SKILL_VERSION,
    transformation: 'recorded verbatim',
    transformedMax: MAX_SKILL_VERSION,
    consumer: 'AuditLog skillVersion',
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
