/**
 * Unified audit trail (Stage 3 Wave B).
 *
 * The gap this closes: permission decisions were recorded in one place, tool
 * executions in per-task step records, and egress decisions in evidence. Three
 * partial views meant "what did the agent do on this site last week" had no
 * answer, because answering it required joining three stores with different
 * shapes and different lifetimes.
 *
 * This is one append-only stream across tasks, and it is deliberately thin:
 * it records *that* something happened and *what was decided*, and points at
 * evidence for anything larger. It is not a second copy of the data.
 *
 * What it must never become is a place where payloads accumulate. Evidence
 * already solved that problem — keyed digests under a per-task salt, no
 * content — and an audit log that quietly stored the plaintext beside it would
 * undo that work while looking like an improvement. Every field here is a
 * label, an identifier, a decision or a reference.
 */

import { getLogger } from '@/logging/logger';
import { update, type StorageArea } from '@/storage/storage-area';
import { hashContent } from '@/evidence/evidence-model';
import { REDACTED, redactValue } from '@/security/redaction/secret-redactor';
import type { PersistenceHealthStore } from '@/storage/persistence-health';
/**
 * The limits live in `boundaries.ts` because the producers need them too.
 *
 * They used to be private constants here, which is how two of them drifted away
 * from the code that fills the fields: a filename bounded at 200 by the download
 * validator met a 128 here, and an unbounded MCP server id met a 256. Both times
 * the operation succeeded and the record of it was refused. A limit only one side
 * can see is a limit the other side will eventually cross.
 */
import {
  ARRAY_FIELDS,
  arrayLimit,
  fieldLimit,
  MAX_ARRAY_STRING,
  MAX_EVENT_BYTES,
  serialisedWidth,
  MAX_OPAQUE_ID,
  OPAQUE_ID_FIELDS,
} from './boundaries';

const log = getLogger('storage');

const INDEX_KEY = 'audit-index';

export const AUDIT_EVENT_TYPES = [
  'task.created',
  'task.state',
  'task.completed',
  'tool.invoked',
  'tool.refused',
  'permission.decided',
  'egress.decided',
  'provider.selected',
  'file.selected',
  'file.attached',
  'file.downloaded',
  'connector.configured',
  'connector.auth',
  'connector.operation',
  'skill.started',
  'skill.step',
  'skill.finished',
  'workflow.recorded',
  // The counterpart to `workflow.recorded`, and for a long time absent while
  // `schedule.deleted` existed. A recording going away is what makes a shortcut
  // pointing at it stop resolving, so without this the trail could show the
  // failure and not its cause.
  'workflow.removed',
  // A user switching a skill on or off (P-024). Recorded because it changes
  // what the agent can reach, which is the same class of fact as a site grant
  // being given or revoked.
  'skill.enablement',
  // A standing site grant being written or taken away.
  //
  // The authority surface this trail was missing. A standing grant is what
  // stops the agent asking again on a site, so its creation and its removal
  // are both authorization decisions — but neither reached the trail.
  // `permission.decided` records that a prompt was approved and flattens
  // `approve_once` and `approve_site` to the same `approved` code, so it
  // cannot say a standing grant was made; and revoking one wrote nothing at
  // all. "What was this task allowed to do, and when did that change" was
  // therefore unanswerable from the record, which is the question the trail
  // exists for. The comment on `skill.enablement` below already asserted this
  // was recorded "the same class of fact as a site grant being given or
  // revoked" — it was not, until now.
  'policy.site_rule',
  // A tab joined or left a workspace. Membership is scope, never authority —
  // the record exists so a change of scope is visible after the fact.
  'workspace.membership',
  'workflow.replay',
  'shortcut.resolved',
  'shortcut.launched',
  // A message refused because of who sent it. Holds a route name and a closed
  // sender class, never the sender's URL: a URL is page-derived, and
  // page-derived text does not enter this trail.
  'route.refused',
  // A person acknowledging that stored state was lost (D-3). Recorded because
  // it is the one action that lets work resume after a persistence failure.
  'persistence.health',
  // Scheduled execution (P-020). A schedule's lifecycle, and every firing of
  // it. `schedule.run_blocked` is the one this phase exists to produce: an
  // unattended run that reached an action needing a person and stopped.
  'schedule.created',
  'schedule.updated',
  'schedule.paused',
  'schedule.resumed',
  'schedule.deleted',
  'schedule.run_started',
  'schedule.run_completed',
  'schedule.run_failed',
  'schedule.run_blocked',
  'schedule.run_cancelled',
  'schedule.run_missed',
  // The Classic plan (Phase C). An approved plan authorises page actions for a
  // task's lifetime without asking again, so it is an authorization decision
  // and belongs in the same trail as `permission.decided`. One record per
  // approved site, so the trail answers "which sites was this task allowed to
  // work on" rather than only "a plan existed".
  //
  // `plan.revised` is recorded because declining a proposal is a decision as
  // much as accepting one, and a trail that held only the approvals would show
  // a task's second plan with no sign that there had been a first.
  'plan.approved',
  'plan.site_added',
  'plan.revised',
  /*
   * MCP server lifecycle (P-026).
   *
   * Two events, and only two, because only two things happen that a later
   * reader needs: the user added a third party whose tools the model may then
   * be offered, and the user took it away. There is deliberately no
   * "discovered" or "connected" event — a tool set is a fresh reading on every
   * registration rather than a state that changes, so such a record would fire
   * on every worker start and say nothing about a decision anybody made.
   *
   * `mcp.server.added` carries the server's URL as its `destination`, which is
   * the vocabulary the egress records already use. It never carries a tool
   * name: those come from the server, and a server-authored string in a
   * cross-task trail is the problem `taintKind` exists to avoid for taint
   * sources.
   */
  'mcp.server.added',
  'mcp.server.removed',
  /*
   * Authority-changing panel actions (Part 7 census).
   *
   * These five were found by asking the reverse of the question this file
   * already answered. `AUDIT_EVENT_TYPES` was guarded one way — every declared
   * type has a producer — and nothing asked the other way: that every action
   * which changes what the agent may later do has a type. Five did not.
   *
   * `session.permission_mode` is the most consequential of them. Switching to
   * `skip` removes the confirmation step from every subsequent action for as
   * long as it stays there, which is a broader grant than any single
   * `policy.site_rule` — and it wrote nothing, while revoking one site rule
   * wrote a record.
   *
   * `shortcut.configured` covers creation, retargeting and removal. A schedule
   * already recorded all three (`schedule.created`, `updated`, `deleted`) and a
   * shortcut recorded only its runs, which left the trail able to say a
   * shortcut launched and unable to say what it had been pointed at, or by
   * whom, or when that changed. Retargeting is the case that matters: a person
   * confirms a launch by the name they gave it, and the name is the only thing
   * they see.
   *
   * `storage.preference` is where records live, which decides what leaves the
   * device at all.
   *
   * `data.exported` and `data.imported` are the boundary itself. Import writes
   * workflows and shortcuts — standing-authority objects — from a file this
   * device did not author.
   *
   * All five carry counts and modes, never names: a shortcut's display name is
   * text a user typed and a workflow's steps are what it does, and neither has
   * ever been allowed into this trail.
   */
  /*
   * Local encryption's lifecycle (K1).
   *
   * The largest omission the census found, and the one furthest from a scope
   * decision: K1 is what protects the provider API keys and connector
   * credentials in this profile, and none of switching it on, switching it off,
   * changing its passphrase, locking or unlocking wrote anything at all.
   *
   * `k1.disable` is the action this type most exists for. It takes the
   * protection off the only SECRET_LOCAL_ONLY material this extension holds,
   * and it left no trace — so a profile found later with plaintext keys could
   * not be distinguished from one where protection was never switched on.
   *
   * A *failed* unlock is recorded too, with the closed `UnlockFailure` reason as
   * its code. Repeated `WRONG_PASSPHRASE` records against a profile are the one
   * observable sign of somebody working through passphrases, which is precisely
   * the scenario K1's own threat model names — a stolen laptop, a synced backup,
   * a shared machine. A trail that held only the successes would be silent
   * exactly when it was most worth reading.
   *
   * Never the passphrase, never its length, and never a digest of it: a record
   * that narrowed the guessing space would weaken the thing it reports on.
   */
  'k1.protection',
  'session.permission_mode',
  'shortcut.configured',
  'storage.preference',
  'data.exported',
  'data.imported',
  // Written only by the log itself, when eviction removes records. It exists
  // so a reader can tell a quiet period from a truncated one.
  'retention.compacted',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditOutcome = 'allowed' | 'denied' | 'confirmed' | 'failed' | 'info';

/**
 * One audit record.
 *
 * Every field is bounded and non-sensitive by construction. There is no
 * `payload`, no `content` and no free-text field drawn from a page or a model
 * reply — `detail` is written by the extension from its own vocabulary, which
 * is why it cannot quote what it describes.
 */
export interface AuditEvent {
  readonly id: string;
  /**
   * Schema version of this record.
   *
   * Written per event rather than per store, because a trail outlives the
   * build that wrote it: a reader meeting a higher version reports it and
   * does not interpret it, and a record written before versioning existed is
   * read as `v0` and shown as such.
   */
  readonly eventVersion: number;
  /**
   * Position in the one stream, allocated from what is persisted.
   *
   * Order is read from this and never from `at`. Clocks move — they are
   * adjusted, they drift, and two events in the same millisecond tie — so a
   * timestamp cannot carry ordering. A gap in `seq` means a record is
   * missing; a repeat means one was written twice.
   */
  readonly seq: number;
  /**
   * Digest of the previous record's canonical form.
   *
   * This gives **corruption and reordering detection**: a truncated write, a
   * dropped record or a reordered one breaks the chain and is reported. It is
   * deliberately *not* authenticated integrity. Anyone who can write this
   * extension's storage can also read it, so they can recompute the chain as
   * easily as they can edit a record — there is no key here that they would
   * not also hold. Calling it tamper protection would be a claim this
   * architecture cannot support.
   */
  readonly prevDigest: string;
  readonly at: number;
  readonly type: AuditEventType;
  readonly taskId?: string;
  readonly sessionId?: string;
  /** Canonical tool name, for tool events. */
  readonly tool?: string;
  /** Canonical destination identity, for egress events. */
  readonly destination?: string;
  readonly origin?: string;
  readonly site?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly providerState?: string;
  readonly taskState?: string;
  readonly risk?: string;
  readonly outcome: AuditOutcome;
  /** Policy or decision code, e.g. `EXFILTRATION_CONFIRM`. */
  readonly code?: string;
  /**
   * Basename of a file the event is about. Never a path, never contents.
   *
   * A filename is chosen by a user, a page or a model rather than by the
   * extension, so it goes through the same redaction every other field does —
   * a key pasted into a filename must not be preserved by the audit trail.
   */
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly byteLength?: number;
  /**
   * One sentence, written by this build, about what happened.
   *
   * Declared here because it was already being stored without being declared.
   * `FileAuditEvent` carries it and is handed to `record()` as a variable rather
   * than as a fresh object literal, so TypeScript's excess-property check never
   * fired and the field reached storage through a typing gap — while
   * `docs/audit.md` said it had been removed. A field the store keeps but the
   * schema denies cannot be bounded, reviewed, or reasoned about, so it is
   * declared.
   *
   * The constraint the earlier removal was protecting stands, and is the whole
   * contract of this field: **the extension's own vocabulary only.** Never page
   * text, never model output, never a tool result, never anything a caller
   * received from elsewhere. It says which of several known things happened —
   * "Saved under a different name because a file of that name already existed."
   * — and a summary drawn from a page belongs in evidence, which is separate,
   * digested and not exported with the trail.
   *
   * Bounded by `MAX_DETAIL`, and shortened with a visible ellipsis rather than
   * refused, because the sentences interpolate hostnames that are not bounded at
   * the source: a redirect between two 253-character domains produced a
   * 545-character sentence and the whole record of the download was refused.
   */
  readonly detail?: string;
  readonly connectorId?: string;
  /** Connector operation id, e.g. `create_issue`. Never its arguments. */
  readonly operation?: string;
  /** Scope names the user granted. Names only — never a token. */
  readonly scopes?: readonly string[];
  /** Connector authorization state, e.g. `READY`. */
  readonly connectorState?: string;
  /**
   * Recorded-workflow identity (P-022). An opaque id, never its steps.
   *
   * Paired with `skillVersion` for the record's version and `skillHash` for
   * the definition hash, so a reader can tell which stored definition ran
   * without the trail holding any of what it did.
   */
  readonly workflowId?: string;
  /** Skill identity, for a workflow run. Never its inputs or its results. */
  readonly skillId?: string;
  readonly skillVersion?: string;
  /**
   * The definition hash at the moment the run started.
   *
   * Recorded so a reader can tell that two runs executed the same definition,
   * and so an edited-but-unversioned skill is visible in the trail. It is
   * evidence, not authorization — see `skill-model.ts`.
   */
  readonly skillHash?: string;
  /** The step id within a skill. */
  readonly step?: string;
  /** What that step ran: a tool name, or a composed skill. */
  readonly ran?: string;
  /** Evidence ids that hold the detail this record deliberately omits. */
  readonly evidenceIds?: readonly string[];
  /** P-021 linkage. An opaque store id, never a name a user typed. */
  readonly shortcutId?: string;
  /**
   * P-020 linkage. The schedule, and the one firing of it.
   *
   * Opaque handles this extension minted, exactly like `shortcutId`. Never
   * the schedule's display name, which is free text a user chose, and never
   * its cadence — the trail says *that* a schedule fired, and the schedule
   * record says what it is.
   */
  readonly scheduleId?: string;
  readonly runId?: string;
  /** P-022 record version, alongside `skillHash` for the definition hash. */
  readonly workflowVersion?: number;
  /** Whether the call reached the tool at all. */
  readonly executed?: boolean;
  readonly cancelled?: boolean;
  /** The mode in force when the decision was made. */
  readonly permissionMode?: string;
  /**
   * The task's taint *kind* only.
   *
   * Never the sources. A source names a site the user visited, and a
   * cross-task trail listing those is a browsing history by another name.
   */
  readonly taintKind?: string;
  /** `api` or `none`. Web inference is gated and cannot appear here. */
  readonly providerMode?: string;
  readonly tabId?: number;
  readonly stepCount?: number;
  readonly stepIndex?: number;
  /**
   * The message route a refusal was about, on `route.refused` records.
   *
   * A route name this build registered, validated as an identifier like every
   * other one here — which structurally excludes a URL, since an identifier
   * has no slashes.
   */
  readonly route?: string;
  /**
   * What the refused sender was, from the closed set in `route-trust.ts`.
   *
   * A class, never the sender's origin or URL. Recording where a message came
   * from would put a page's address in a cross-task trail, which is the thing
   * `taintKind` exists to avoid for taint sources.
   */
  readonly senderClass?: string;
  /**
   * Where records are kept, on `storage.preference` records.
   *
   * The mode name from the closed set the preference itself allows — never a
   * device id, an account id or an endpoint.
   */
  readonly storageMode?: string;
  /**
   * How many records an export or an import moved.
   *
   * A count, which is what a later reader needs to tell a whole library
   * leaving from a single entry. Never which records, and never their names.
   */
  readonly recordCount?: number;
  /** Retention bookkeeping, on `retention.compacted` records only. */
  readonly removedCount?: number;
  readonly removedFromSeq?: number;
  readonly removedToSeq?: number;
}

/**
 * Field names that must never appear in a record.
 *
 * Belt and braces: the type above has nowhere to put a secret, but a caller
 * building an event from a wider object could spread one in. This rejects the
 * write rather than storing it and hoping redaction catches it later.
 */
const PROHIBITED_FIELD_NAMES = [
  // Connector credential material. The types above have nowhere to put any
  // of it, and this rejects a caller that spread a token response in.
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'code_verifier',
  'codeVerifier',
  'authorization_code',
  'authorizationCode',
  'id_token',
  'idToken',
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'cookies',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'credentials',
  'session',
  'payload',
  'content',
  'body',
  // A workflow's inputs and step results are the same kind of thing as a
  // payload: they can contain anything the task has read. The trail records
  // which skill ran and how it ended, never what passed through it.
  'inputs',
  'outputs',
  'result',
  'results',
  'arguments',
  'args',
  // A definition, or a reference that would carry one.
  'steps',
  'definition',
  'binding',
  'bindings',
  // Anything that would be read as a selector or an expression.
  'selector',
  'selectors',
  'xpath',
  'elementid',
  // Model-facing text, in either direction.
  'prompt',
  'completion',
  'message',
  'messages',
  // The generic carriers a value arrives in when a specific name is refused.
  'text',
  'value',
  'values',
  // Taint sources name sites the user visited; the signature is a consent key.
  'sources',
  'taintsignature',
];

/**
 * The same names, case-folded once.
 *
 * The comparison below lowercases the incoming key, so the list it is
 * compared against has to be lowercased too. It was not, which made every
 * camelCase entry above unreachable: `accessToken` case-folded to
 * `accesstoken` and matched nothing. Redaction still caught the value, but
 * the refusal that is supposed to be the primary control never fired.
 */
const PROHIBITED_FIELDS: ReadonlySet<string> = new Set(
  PROHIBITED_FIELD_NAMES.map((name) => name.toLowerCase()),
);

export class AuditShapeError extends Error {
  constructor(
    readonly field: string,
    readonly why: string,
  ) {
    super(`An audit record's "${field}" ${why}.`);
    this.name = 'AuditShapeError';
  }
}

export class ProhibitedAuditFieldError extends Error {
  constructor(readonly field: string) {
    super(
      `An audit record may not carry "${field}". The audit trail records decisions and ` +
        'references, never the data they were about.',
    );
    this.name = 'ProhibitedAuditFieldError';
  }
}

/** How deep the check walks before giving up and refusing outright. */
const MAX_AUDIT_DEPTH = 8;

/**
 * Rejects a record carrying anything the trail must not hold.
 *
 * Recursive, through objects and arrays alike. It was top-level only, which
 * made it trivially avoidable: `{ detail: { inputs: pageText } }` passed, and
 * so did `{ steps: [{ result: pageText }] }`. Redaction still caught anything
 * *credential*-shaped at any depth — that was never the gap — but a page's
 * text under a nested `inputs` is not credential-shaped and reached the store
 * verbatim.
 *
 * A nested prohibited name is reported with its path, so a caller that spread
 * a wider object in can see where it came from.
 */
export function assertAuditSafe(event: Record<string, unknown>): void {
  walkForProhibited(event, [], 0);
}

function walkForProhibited(value: unknown, path: readonly string[], depth: number): void {
  if (depth > MAX_AUDIT_DEPTH) {
    // A structure this deep is not an audit record. Refusing beats walking
    // an unbounded graph, and beats silently stopping the check partway.
    throw new ProhibitedAuditFieldError(path.join('.') || '(root)');
  }
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkForProhibited(item, [...path, String(index)], depth + 1);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new ProhibitedAuditFieldError([...path, key].join('.'));
    }
    walkForProhibited(nested, [...path, key], depth + 1);
  }
}

/**
 * What a caller may supply.
 *
 * `id`, `at`, `seq`, `prevDigest` and `eventVersion` are the log's to
 * assign, and are deliberately not in this type: a caller that could set a
 * sequence number or a chain digest could write a record that looks like it
 * came from somewhere else in the stream. There is no path for a caller to
 * provide them.
 */
export type RecordableAuditEvent = Omit<
  AuditEvent,
  'id' | 'at' | 'seq' | 'prevDigest' | 'eventVersion'
> & { readonly at?: number };

/**
 * Re-exported from the contract, which owns it.
 *
 * It used to live here, and the budget proof needs the same answer, so keeping
 * one copy was the point: `MAX_ARRAY_ENTRIES` and `MAX_EVENT_BYTES` contradicted
 * each other precisely because two files each held part of the decision.
 */
export { fieldLimit };

/**
 * Refuses a record whose shape is wrong, rather than trimming it to fit.
 *
 * Silent trimming is the failure mode worth avoiding: a reader cannot tell a
 * truncated field from a short one, so a record that was too big becomes a
 * record that quietly says something else. Everything here refuses.
 *
 * The schema is flat by contract. `assertAuditSafe` still walks recursively
 * as defence in depth, but a nested object is not a shape this record has, so
 * one arriving means something spread a wider value in.
 */
export function assertAuditShape(event: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (!ARRAY_FIELDS.has(key)) {
        throw new AuditShapeError(key, 'may not be a list');
      }
      const entries = arrayLimit(key);
      if (value.length > entries) {
        throw new AuditShapeError(key, `holds more than ${entries} entries`);
      }
      for (const entry of value) {
        if (typeof entry !== 'string') throw new AuditShapeError(key, 'holds a non-string entry');
        // Serialised width, not code units — see `serialisedWidth`. Sixteen
        // scope strings of quotes measured 128 each by `length` and 256 each
        // once written, which is how `connector.auth` could pass every field
        // check and then exceed the record budget.
        if (serialisedWidth(entry) > MAX_ARRAY_STRING) {
          throw new AuditShapeError(key, `holds an entry longer than ${MAX_ARRAY_STRING}`);
        }
      }
      continue;
    }

    if (typeof value === 'object') {
      // Depth beyond one is refused outright: a nested object in a flat
      // schema is the shape a payload arrives in.
      throw new AuditShapeError(key, 'may not be a nested object');
    }

    if (typeof value === 'string') {
      const limit = fieldLimit(key);
      // The width this value will occupy in the stored record, which is what
      // the record budget below is measured in. A model id of 256 quote
      // characters is 256 code units and 512 serialised, and the gap between
      // those two numbers is what made the field bounds fail to imply the
      // record bound.
      if (serialisedWidth(value) > limit) {
        throw new AuditShapeError(key, `is longer than ${limit} characters`);
      }
    }
  }

  // The same serialiser the fields were measured with, so the implication
  // "every field inside its limit" ⇒ "the record inside its budget" is an
  // arithmetic fact rather than an observation that happened to hold for ASCII.
  const size = JSON.stringify(event)?.length ?? 0;
  if (size > MAX_EVENT_BYTES) {
    throw new AuditShapeError('(record)', `is larger than ${MAX_EVENT_BYTES} bytes`);
  }
}

/**
 * Removes any field the redactor would have altered.
 *
 * Dropped rather than replaced with a marker. A `[REDACTED]` left in an audit
 * record tells a reader that a secret was there, which is itself information
 * — and in an exportable artefact it is information that travels. A field
 * whose value cannot be kept is a field the record does not have.
 */
function dropRedactedFields<T extends Record<string, unknown>>(event: T): T {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (typeof value !== 'string' || value.length === 0) {
      kept[key] = value;
      continue;
    }
    const redacted = redactValue(value);
    if (redacted !== value || (typeof redacted === 'string' && redacted.includes(REDACTED))) {
      log.warn('An audit field was dropped because it looked like a credential.', { field: key });
      continue;
    }
    kept[key] = value;
  }
  return kept as T;
}

/**
 * What a reader may filter the trail by.
 *
 * Every correlation a record carries, not just the two it started with. The
 * gap this closes was recorded rather than hidden: *"the route filters on task
 * and site, while a record also carries workflow, shortcut, schedule, run,
 * connector and skill correlations. A reader of the export can use them; a
 * route caller cannot yet."* An audit trail whose questions can only be asked
 * by exporting it and grepping is a trail the product cannot show anybody.
 *
 * Every field is an exact match on an identifier the extension minted, except
 * `site`, which is compared case-insensitively because a host is. None is a
 * pattern, a range or an expression: a query language over the audit trail
 * would be a second thing to get right, and the questions people actually ask
 * are "what did this connector do" and "what happened in that scheduled run".
 */
export interface AuditQuery {
  readonly taskId?: string;
  readonly site?: string;
  readonly workflowId?: string;
  readonly skillId?: string;
  readonly shortcutId?: string;
  readonly scheduleId?: string;
  readonly runId?: string;
  readonly connectorId?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/**
 * The correlations a query may filter on, and the field each reads.
 *
 * A table rather than a chain of comparisons, so adding a correlation to the
 * record and forgetting the filter is one missing entry rather than something
 * nobody notices. `tests/unit/audit*` asserts that every optional identifier
 * on the record is either in here or deliberately named as excluded.
 */
const EXACT_MATCH_FIELDS = [
  'taskId',
  'workflowId',
  'skillId',
  'shortcutId',
  'scheduleId',
  'runId',
  'connectorId',
] as const satisfies readonly (keyof AuditQuery)[];

export interface AuditPage {
  readonly events: readonly AuditEvent[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  /** Non-null when a write failed; the trail has a gap the reader should see. */
  readonly degraded: string | null;
}

function matches(event: AuditEvent, query: AuditQuery): boolean {
  for (const field of EXACT_MATCH_FIELDS) {
    const wanted = query[field];
    if (wanted === undefined) continue;
    // An exact match on an identifier this extension minted. A record that
    // does not carry the field at all does not match a query for it — which
    // is the right answer: "show me what this connector did" must not return
    // every event that has no connector.
    if ((event as unknown as Record<string, unknown>)[field] !== wanted) return false;
  }
  // A host, so case does not distinguish two sites.
  if (query.site !== undefined && (event.site ?? '').toLowerCase() !== query.site.toLowerCase()) {
    return false;
  }
  return true;
}

export interface AuditLogOptions {
  /** Retained events. Older ones are dropped first. */
  readonly maxEvents?: number;
  /** Total serialised size of the trail. */
  readonly maxBytes?: number;
  /** How long a record is kept, whichever bound is reached first. */
  readonly retentionMs?: number;
  /**
   * Whether a tool name is one this build registered.
   *
   * A tool name has model-controlled reach: a model can propose any string,
   * and the registry refuses it — but the refusal is exactly the event worth
   * recording, so the name arrives here. Without this the trail would be a
   * model-writable free-text field. An unrecognised name is stored as
   * `(unknown)` and the proposed string is dropped.
   */
  /**
   * Decides whether a tool name is one this build registered.
   *
   * Optional, and its absence means **no name is verified** — every one is
   * recorded as `(unknown)`. That is the honest reading: a log with no way to
   * check a name cannot vouch for one, and a default that vouched anyway
   * would make the check look present while doing nothing.
   */
  readonly knownTool?: (name: string) => boolean;
  /**
   * Where a persistence failure is recorded durably (D-3).
   *
   * Optional, and deliberately not required: a log constructed without one
   * behaves exactly as before. What it changes is that a lost record survives
   * worker eviction as a fact, instead of only as a flag this instance holds.
   *
   * Reporting is fire-and-forget and never gates anything here. A gap in the
   * audit trail is a gap in the record of an execution that already happened;
   * turning it into a stopped execution is the one thing P-038 forbids.
   */
  readonly health?: PersistenceHealthStore;
  readonly now?: () => number;
}

/** What a reader can be told about the state of the stream. */
export type IntegrityVerdict =
  | 'ok'
  | 'empty'
  | 'gap'
  | 'reordered'
  | 'chain-broken'
  | 'truncated'
  | 'future-version'
  | 'corrupt';

export interface IntegrityReport {
  readonly verdict: IntegrityVerdict;
  readonly checked: number;
  /** The first sequence number at which something is wrong. */
  readonly atSeq?: number;
  readonly note: string;
}

/** Recorded in place of a tool name this build does not recognise. */
export const UNKNOWN_TOOL = '(unknown)';

/**
 * Names this build itself originates, and the record types they belong to.
 *
 * A provider request is a real, auditable action with a destination and a
 * decision, and it is deliberately *not* a registered tool: registering it
 * would put it in the set the model is offered, which is the opposite of what
 * it is. So `knownTool` correctly said no, and the trail recorded every
 * provider request as `(unknown)` — losing the one thing the record was for.
 *
 * **Keyed by record type, not just by name, and that pairing is the control.**
 * A bare name exemption was the first attempt and it opened a hole: a model
 * emits whatever tool name it likes, `fromWireName` passes a name containing a
 * dot straight through, and the registry observes the refusal — so a model
 * calling `provider.request` would have had its refused call recorded under the
 * build's own reserved name instead of as `(unknown)`. Requiring the type as
 * well closes it. `egress.decided` with this source is written only by the
 * guarded transport; a model-driven call is `tool.invoked` or `tool.refused`,
 * where the name stays unverified.
 *
 * A closed table here rather than a widening of `knownTool`, because these
 * names are written in the build where nothing a model or a page reaches. A
 * prefix or pattern would not have that property — an MCP method name is
 * authored by the server, so `mcp.<server>.<method>` stays unverified and keeps
 * becoming `(unknown)`, which is that control working rather than failing.
 */
export const INTERNAL_AUDIT_SOURCES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['provider.request', new Set(['egress.decided'])],
]);

/** Bumped when the stored record shape changes. Written on every record. */
export const AUDIT_EVENT_VERSION = 1;

/** The chain's starting value, for the first record in a stream. */
const GENESIS_DIGEST = '0'.repeat(64);

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = [
  'allowed',
  'denied',
  'confirmed',
  'failed',
  'info',
];

/**
 * Types that must name the task they belong to.
 *
 * Left off this list are the events that genuinely have no task: connector
 * authorization happens before any task, provider selection is a setting, and
 * a retention marker is the log talking about itself. Requiring a task id for
 * those would mean inventing one, which is worse than admitting there is none.
 */
const TASK_SCOPED: ReadonlySet<string> = new Set([
  'task.created',
  'task.state',
  'task.completed',
  'tool.invoked',
  'tool.refused',
  'permission.decided',
  'egress.decided',
  'skill.started',
  'skill.step',
  'skill.finished',
  'workflow.replay',
  'shortcut.launched',
]);

/** The bound comes from the contract, so a producer can be checked against it. */
const OPAQUE_ID_PATTERN = new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_OPAQUE_ID}}$`);

/** An identifier this extension minted, rather than a value from elsewhere. */
function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && OPAQUE_ID_PATTERN.test(value);
}

function mintId(at: number, seq: number): string {
  return `aud_${at.toString(36)}_${seq.toString(36)}`;
}

/**
 * The canonical form a record is hashed over.
 *
 * Keys sorted and the digest field itself excluded, so the same record always
 * produces the same digest and a reformat never reads as a change.
 */
function canonicalForm(event: AuditEvent): string {
  const entries = Object.entries(event as unknown as Record<string, unknown>)
    .filter(([key, value]) => key !== 'prevDigest' && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value) ?? 'null'}`);
  return `{${entries.join(',')}}`;
}

async function digestOf(event: AuditEvent): Promise<string> {
  return await hashContent(canonicalForm(event));
}

/** Whether a stored record still has the shape this build can read. */
function isUsableEvent(value: unknown): value is AuditEvent {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<AuditEvent>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.at === 'number' &&
    typeof entry.seq === 'number' &&
    Number.isInteger(entry.seq) &&
    typeof entry.prevDigest === 'string' &&
    typeof entry.eventVersion === 'number' &&
    typeof entry.type === 'string'
  );
}

interface AuditIndex {
  readonly events: readonly AuditEvent[];
}

/**
 * Append-only audit trail.
 *
 * Held as one indexed record rather than a key per event: the trail is read
 * whole far more often than it is read by id, and the existing storage mutex
 * makes a single-key read-modify-write both atomic and simple.
 */
export class AuditLog {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  /**
   * Whether the last write reached storage.
   *
   * Read by the panel so a person can see that the trail is incomplete. It is
   * never used to change what a tool did: a write that failed is a gap in the
   * record of an execution that already happened, not a failed execution.
   */
  private degraded: string | null = null;

  constructor(
    private readonly area: StorageArea,
    private readonly options: AuditLogOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? 5000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** What the last write did, for the panel to show. `null` when healthy. */
  degradedReason(): string | null {
    return this.degraded;
  }

  /**
   * Records a persistence failure where it will outlive this worker.
   *
   * Fire-and-forget, and its own failure is swallowed: this runs on the path
   * that is already failing, and a reporter that threw would replace the
   * failure being reported with a different one.
   */
  private reportHealth(state: 'DEGRADED' | 'CORRUPT', reason: string): void {
    void this.options.health?.report('audit', state, reason).catch(() => undefined);
  }

  /**
   * Appends one event.
   *
   * Inside the storage mutator, so two tool calls finishing together cannot
   * drop one of their records — the same reason taint is appended that way.
   */
  async record(event: RecordableAuditEvent): Promise<AuditEvent | null> {
    let prepared: RecordableAuditEvent;
    try {
      prepared = this.prepare(event);
    } catch (error) {
      // Refused, and the refusal is *not* itself an audit event: recording a
      // failure to record would be a recursion whose base case is the same
      // validator that just said no. It goes to the redacted worker log.
      //
      // The field is named, in the reason and in the log, because it was not.
      // "a record could not be shaped" was true of a filename over its limit, a
      // model id over its limit and an MCP tool name over its limit, and told
      // whoever read it none of that — which is why one of those reached a user
      // before it reached a test. A field name is safe to surface: it is the
      // schema's own vocabulary, never the value.
      const field = error instanceof AuditShapeError ? error.field : null;
      const because = field === null ? '' : `: ${field}`;
      this.degraded = `A record was refused because its shape was not usable${because}.`;
      this.reportHealth('CORRUPT', `a record could not be shaped${because}`);
      log.error('An audit record was refused.', {
        type: String(event.type),
        ...(field === null ? {} : { field }),
        error: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }

    try {
      return await this.append(prepared);
    } catch (error) {
      // One retry, after a compaction, because quota is the failure this is
      // most likely to be. A second failure is reported as a gap rather than
      // pretended away — and neither changes what the tool already did.
      log.warn('An audit write failed; compacting and retrying once.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      try {
        await this.compact();
        return await this.append(prepared);
      } catch {
        this.degraded = 'The audit trail could not be written to; records are missing.';
        this.reportHealth('DEGRADED', 'a record could not be written');
        log.error('An audit write failed after compaction; the trail has a gap.');
        return null;
      }
    }
  }

  /**
   * Validates and normalises what a caller supplied.
   *
   * Everything here can refuse. Nothing here writes, so a refusal costs
   * nothing and leaves no partial record.
   */
  private prepare(event: RecordableAuditEvent): RecordableAuditEvent {
    // A caller cannot supply the log's own fields — the type forbids it — but
    // a plain object cast through `unknown` could, so they are stripped.
    const supplied = { ...event } as Record<string, unknown>;
    for (const owned of ['id', 'seq', 'prevDigest', 'eventVersion']) {
      if (owned in supplied) {
        log.warn('An audit record tried to supply a field the log owns.', { field: owned });
        delete supplied[owned];
      }
    }

    if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(String(supplied['type']))) {
      throw new AuditShapeError('type', 'is not one this build records');
    }
    if (!AUDIT_OUTCOMES.includes(supplied['outcome'] as AuditOutcome)) {
      throw new AuditShapeError('outcome', 'is not a known outcome');
    }

    // A tool name is the one field with model-controlled reach, and the
    // default when nobody supplies a check is **closed**: a name that nothing
    // verified is recorded as unverified.
    //
    // It used to default the other way — no validator meant the proposed
    // string was kept — which quietly contradicted what this control is for
    // and what the documentation says it does. A caller that cannot say
    // whether a name is real should not have the trail assert that it is.
    const internal = (name: string): boolean =>
      INTERNAL_AUDIT_SOURCES.get(name)?.has(String(supplied['type'])) ?? false;
    const verified = (name: string): boolean =>
      internal(name) || (this.options.knownTool?.(name) ?? false);
    if (typeof supplied['tool'] === 'string' && !verified(supplied['tool'])) {
      supplied['tool'] = UNKNOWN_TOOL;
    }
    if (typeof supplied['ran'] === 'string' && !verified(supplied['ran'])) {
      supplied['ran'] = UNKNOWN_TOOL;
    }

    // Identifiers are opaque handles this extension minted. Anything that is
    // not one is a value that arrived from somewhere it should not have.
    for (const field of OPAQUE_ID_FIELDS) {
      const value = supplied[field];
      if (value !== undefined && !isOpaqueId(value)) {
        throw new AuditShapeError(field, 'is not a usable identifier');
      }
    }
    if (TASK_SCOPED.has(String(supplied['type'])) && !isOpaqueId(supplied['taskId'])) {
      // Without this a task-scoped record could not be filtered out of a
      // cross-task view, which is the whole isolation story.
      throw new AuditShapeError('taskId', 'is required for this kind of record');
    }

    assertAuditSafe(supplied);
    const kept = dropRedactedFields(supplied);
    assertAuditShape(kept);
    return kept as unknown as RecordableAuditEvent;
  }

  /**
   * Appends one record, atomically.
   *
   * Everything that has to agree happens inside a single storage
   * transaction: the sequence is allocated from what is persisted, eviction
   * decides what leaves, the retention marker is written with the eviction
   * that caused it, the record is appended, and the chain digest is computed
   * over the canonical form. There is no committed state in which records
   * have been removed and the marker explaining it does not exist.
   *
   * The sequence comes from storage and never from a module-scope counter,
   * because this worker is evicted constantly and a counter in memory would
   * restart at zero beside a trail that did not.
   */
  private async append(event: RecordableAuditEvent): Promise<AuditEvent> {
    let written: AuditEvent | null = null;

    await update<AuditIndex>(this.area, INDEX_KEY, { events: [] }, async (index) => {
      const existing = index.events;
      const at = event.at ?? this.now();

      // Eviction first, so the sequence is allocated against the trail that
      // will actually hold this record.
      //
      // Compaction happens in batches rather than one record at a time. A
      // trail at its limit would otherwise evict on every append and write a
      // marker each time, and a stream that is half retention markers is a
      // worse record than one with occasional, larger gaps described
      // precisely.
      const cutoff = at - this.retentionMs;
      const expired = existing.filter((entry) => entry.at < cutoff);
      const fresh = existing.filter((entry) => entry.at >= cutoff);
      const overCapacity = fresh.length + 2 > this.maxEvents;
      // Two slots are always reserved: one for the record being appended and
      // one for the marker explaining what left. Without the reserve a
      // compaction down to 90% could still overflow on a small cap.
      const headroom = Math.max(0, this.maxEvents - 2);
      const keepCount = overCapacity
        ? Math.min(Math.floor(this.maxEvents * 0.9), headroom)
        : Math.min(fresh.length, headroom);

      const survivors = fresh.slice(0, keepCount);
      const evicted = [...fresh.slice(keepCount), ...expired];

      // `events` is newest-first, so the tail of the array is the oldest and
      // the head carries the highest sequence.
      const highest = Math.max(0, ...existing.map((entry) => entry.seq));
      let seq = highest;
      let prevDigest = existing[0]?.prevDigest ?? GENESIS_DIGEST;
      if (existing[0]) prevDigest = await digestOf(existing[0]);

      const additions: AuditEvent[] = [];

      if (evicted.length > 0) {
        // Written with the eviction, in the same transaction, so a reader can
        // always tell a quiet period from a truncated one.
        seq += 1;
        const removedSeqs = evicted.map((entry) => entry.seq);
        const marker: AuditEvent = {
          type: 'retention.compacted',
          outcome: 'info',
          removedCount: evicted.length,
          removedFromSeq: Math.min(...removedSeqs),
          removedToSeq: Math.max(...removedSeqs),
          eventVersion: AUDIT_EVENT_VERSION,
          seq,
          prevDigest,
          id: mintId(at, seq),
          at,
        };
        prevDigest = await digestOf(marker);
        additions.push(marker);
      }

      seq += 1;
      const full: AuditEvent = {
        ...(event as Omit<AuditEvent, 'id' | 'at' | 'seq' | 'prevDigest' | 'eventVersion'>),
        eventVersion: AUDIT_EVENT_VERSION,
        seq,
        prevDigest,
        id: mintId(at, seq),
        at,
      };
      additions.push(full);
      written = full;

      // Newest first, and the additions are in ascending sequence, so they go
      // on the front in reverse.
      const events = [...additions.reverse(), ...survivors];
      return { events: this.withinBytes(events) };
    });

    if (!written) throw new Error('audit_append_produced_nothing');
    // The in-memory note clears; the durable record does not. A write that
    // works now says nothing about the one that did not, and the earlier
    // records are still missing.
    this.degraded = null;
    return written;
  }

  /** Drops the oldest records until the trail fits its byte bound. */
  private withinBytes(events: readonly AuditEvent[]): AuditEvent[] {
    let kept = [...events];
    while (kept.length > 1 && (JSON.stringify(kept)?.length ?? 0) > this.maxBytes) {
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.9)));
    }
    return kept;
  }

  /** Forces an eviction pass, used once before a retried write. */
  private async compact(): Promise<void> {
    await update<AuditIndex>(this.area, INDEX_KEY, { events: [] }, (index) => ({
      events: index.events.slice(0, Math.floor(this.maxEvents / 2)),
    }));
  }

  /**
   * Reports what the stream looks like, without repairing anything.
   *
   * This is **corruption and reordering detection**, not authenticated
   * integrity: the chain is an unkeyed digest, so anything that can rewrite
   * storage can rewrite the chain with it. What it catches is a partial
   * write, a dropped or duplicated record, a reordered one, and a record from
   * a format this build cannot read — which is what actually goes wrong.
   */
  async verifyIntegrity(): Promise<IntegrityReport> {
    const index = (await this.area.get<AuditIndex>(INDEX_KEY)) ?? { events: [] };
    const events = index.events;
    if (events.length === 0) {
      return { verdict: 'empty', checked: 0, note: 'The trail holds no records.' };
    }

    // Oldest first, which is the order the chain was built in.
    const ordered = [...events].reverse();
    let previous: AuditEvent | undefined;

    for (const entry of ordered) {
      if (!isUsableEvent(entry)) {
        return {
          verdict: 'corrupt',
          checked: ordered.length,
          note: 'A stored record is not a record this build can read.',
        };
      }
      if (entry.eventVersion > AUDIT_EVENT_VERSION) {
        return {
          verdict: 'future-version',
          checked: ordered.length,
          atSeq: entry.seq,
          note: 'A record was written by a newer version and is not interpreted here.',
        };
      }
      if (previous) {
        if (entry.seq === previous.seq) {
          return {
            verdict: 'reordered',
            checked: ordered.length,
            atSeq: entry.seq,
            note: 'Two records share a sequence number.',
          };
        }
        if (entry.seq < previous.seq) {
          return {
            verdict: 'reordered',
            checked: ordered.length,
            atSeq: entry.seq,
            note: 'Records are not in sequence order.',
          };
        }
        if (entry.seq !== previous.seq + 1) {
          return {
            verdict: 'gap',
            checked: ordered.length,
            atSeq: entry.seq,
            note: `Records between ${previous.seq} and ${entry.seq} are missing.`,
          };
        }
        if (entry.prevDigest !== (await digestOf(previous))) {
          return {
            verdict: 'chain-broken',
            checked: ordered.length,
            atSeq: entry.seq,
            note: 'A record does not follow the one before it.',
          };
        }
      }
      previous = entry;
    }

    // The oldest retained record naturally does not chain to anything once
    // eviction has run, which is expected rather than a fault.
    const truncated = ordered[0] !== undefined && ordered[0].seq > 1;
    return {
      verdict: truncated ? 'truncated' : 'ok',
      checked: ordered.length,
      ...(truncated ? { atSeq: ordered[0]?.seq ?? 0 } : {}),
      note: truncated
        ? 'Older records have been evicted; retention markers record what left.'
        : 'Every retained record follows the one before it.',
    };
  }

  /** Newest first. */
  async list(limit = 200): Promise<AuditEvent[]> {
    const index = (await this.area.get<AuditIndex>(INDEX_KEY)) ?? { events: [] };
    return [...index.events].filter(isUsableEvent).slice(0, limit);
  }

  /**
   * One page, newest first, with the total so a reader knows what they have.
   *
   * Scanning is bounded by the retained trail, which is itself bounded — the
   * alternative, a secondary index per task and per site, is a second source
   * of truth about what happened, and those diverge.
   */
  async page(query: AuditQuery): Promise<AuditPage> {
    const index = (await this.area.get<AuditIndex>(INDEX_KEY)) ?? { events: [] };
    const usable = index.events.filter(isUsableEvent);
    const matching = usable.filter((event) => matches(event, query));
    const offset = Math.max(0, query.offset ?? 0);
    const size = Math.min(Math.max(1, query.limit ?? 50), 200);
    return {
      events: matching.slice(offset, offset + size),
      total: matching.length,
      offset,
      limit: size,
      degraded: this.degraded,
    };
  }

  async forTask(taskId: string, limit = 200): Promise<AuditEvent[]> {
    const all = await this.list(this.maxEvents);
    return all.filter((event) => event.taskId === taskId).slice(0, limit);
  }

  /** Answers "what happened on this site", which is why the trail is unified. */
  async forSite(site: string, limit = 200): Promise<AuditEvent[]> {
    const needle = site.toLowerCase();
    const all = await this.list(this.maxEvents);
    return all.filter((event) => (event.site ?? '').toLowerCase() === needle).slice(0, limit);
  }

  async clear(): Promise<void> {
    await this.area.set(INDEX_KEY, { events: [] });
    log.info('Audit trail cleared.');
  }
}

export type AuditExportScope =
  { readonly kind: 'task'; readonly taskId: string } | { readonly kind: 'all' };

/**
 * Why a scope was not usable. A closed vocabulary, so a caller's message can
 * say what was wrong without echoing what they sent.
 */
export type AuditScopeProblem =
  'missing' | 'not-an-object' | 'unknown-kind' | 'bad-task-id' | 'unexpected-fields';

export type AuditScopeVerdict =
  | { readonly ok: true; readonly scope: AuditExportScope }
  | { readonly ok: false; readonly problem: AuditScopeProblem };

/**
 * Validates an export scope, refusing anything it cannot recognise exactly.
 *
 * Nothing here infers. An omitted scope is not "probably the current task" —
 * this module has no notion of which task the caller is looking at, and
 * inventing one would make a cross-task artefact turn on a guess. An
 * unrecognised scope is not narrowed to something safer either, because a
 * caller who asked for the wrong thing should be told, not quietly given a
 * different thing.
 *
 * The union is closed, so an object carrying extra keys is refused rather
 * than trimmed: a field this build does not know is a field whose meaning it
 * cannot honour, and honouring the rest would be answering a question nobody
 * asked.
 */
export function parseAuditExportScope(value: unknown): AuditScopeVerdict {
  if (value === undefined || value === null) return { ok: false, problem: 'missing' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problem: 'not-an-object' };
  }

  const record = value as Record<string, unknown>;
  const kind = record['kind'];

  if (kind === 'all') {
    if (Object.keys(record).length !== 1) return { ok: false, problem: 'unexpected-fields' };
    return { ok: true, scope: { kind: 'all' } };
  }

  if (kind === 'task') {
    const keys = Object.keys(record);
    if (keys.length !== 2 || !keys.includes('taskId')) {
      return { ok: false, problem: 'unexpected-fields' };
    }
    const taskId = record['taskId'];
    // The same identifier rule the records themselves are held to, so a scope
    // cannot name something a record never could.
    if (!isOpaqueId(taskId)) return { ok: false, problem: 'bad-task-id' };
    return { ok: true, scope: { kind: 'task', taskId } };
  }

  return { ok: false, problem: 'unknown-kind' };
}

/** What to tell a caller whose scope was refused. Never echoes their input. */
export function describeScopeProblem(problem: AuditScopeProblem): string {
  switch (problem) {
    case 'missing':
      return 'An export needs an explicit scope: one task, or every task.';
    case 'not-an-object':
      return 'The export scope was not a scope.';
    case 'unknown-kind':
      return 'The export scope named a kind this build does not know.';
    case 'bad-task-id':
      return 'The export scope named a task id that is not a usable identifier.';
    case 'unexpected-fields':
      return 'The export scope carried fields this build does not recognise.';
  }
}

export interface AuditExport {
  readonly format: 'aiba-audit/2';
  readonly exportedAt: number;
  /**
   * What was asked for, stated in the artefact.
   *
   * A file holding one task's records and a file holding every task's are
   * very different things to be handed, and a reader must not have to infer
   * which one they have.
   */
  readonly scope: AuditExportScope;
  /** The oldest and newest record retained, so a gap is visible as a gap. */
  readonly window: { readonly fromSeq: number; readonly toSeq: number } | null;
  /**
   * What the chain says about the stream, carried with the records.
   *
   * Corruption and reordering detection, not authenticated integrity — see
   * `AuditEvent.prevDigest`.
   */
  readonly integrity: IntegrityReport;
  readonly eventCount: number;
  readonly events: readonly AuditEvent[];
  /**
   * Stated in the artefact itself so a reader knows what they are not holding.
   *
   * Someone opening this file months later should not have to infer that the
   * absence of page text was deliberate.
   */
  readonly notice: string;
}

const EXPORT_NOTICE =
  'Decisions and references only. This file contains no page content, no model output, ' +
  'no request or response bodies, no file contents, and no credentials. File entries name ' +
  'a file and its size; they do not carry it. Evidence ids refer to records held inside ' +
  'the extension, whose digests are keyed per task and cannot be recomputed from this file.';

/**
 * Builds the export document.
 *
 * Pure: it produces a value and writes nothing anywhere. Whether that value
 * then crosses the extension boundary is the caller's decision and the egress
 * gate's to authorise — keeping the two apart is what stops "export" from
 * becoming an unguarded way out.
 */
export function buildAuditExport(
  events: readonly AuditEvent[],
  at: number,
  scope: AuditExportScope,
  integrity: IntegrityReport,
): AuditExport {
  // Re-run on the way out as well as on the way in. The records were checked
  // when they were written, but an export is the one artefact that leaves,
  // and checking it again costs nothing against a record that was edited
  // underneath the store.
  for (const event of events) {
    assertAuditSafe(event as unknown as Record<string, unknown>);
    assertAuditShape(event as unknown as Record<string, unknown>);
  }
  const sequences = events.map((event) => event.seq);
  return {
    format: 'aiba-audit/2',
    exportedAt: at,
    scope,
    window:
      sequences.length === 0
        ? null
        : { fromSeq: Math.min(...sequences), toSeq: Math.max(...sequences) },
    integrity,
    eventCount: events.length,
    events,
    notice: EXPORT_NOTICE,
  };
}
