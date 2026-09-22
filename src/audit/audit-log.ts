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
import { redactValue } from '@/security/redaction/secret-redactor';

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
  'provider.state',
  'recovery',
  'file.selected',
  'file.attached',
  'file.downloaded',
  'connector.configured',
  'connector.auth',
  'connector.operation',
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
  /** Short extension-authored description. Never page or model text. */
  readonly detail?: string;
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
  readonly connectorId?: string;
  /** Connector operation id, e.g. `create_issue`. Never its arguments. */
  readonly operation?: string;
  /** Scope names the user granted. Names only — never a token. */
  readonly scopes?: readonly string[];
  /** Connector authorization state, e.g. `READY`. */
  readonly connectorState?: string;
  /** Evidence ids that hold the detail this record deliberately omits. */
  readonly evidenceIds?: readonly string[];
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

export class ProhibitedAuditFieldError extends Error {
  constructor(readonly field: string) {
    super(
      `An audit record may not carry "${field}". The audit trail records decisions and ` +
        'references, never the data they were about.',
    );
    this.name = 'ProhibitedAuditFieldError';
  }
}

/** Rejects a record carrying anything the trail must not hold. */
export function assertAuditSafe(event: Record<string, unknown>): void {
  for (const key of Object.keys(event)) {
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new ProhibitedAuditFieldError(key);
    }
  }
}

export interface AuditLogOptions {
  /** Retained events. Older ones are dropped first. */
  readonly maxEvents?: number;
  readonly now?: () => number;
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
  private readonly now: () => number;

  constructor(
    private readonly area: StorageArea,
    options: AuditLogOptions = {},
  ) {
    this.maxEvents = options.maxEvents ?? 2000;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Appends one event.
   *
   * Inside the storage mutator, so two tool calls finishing together cannot
   * drop one of their records — the same reason taint is appended that way.
   */
  async record(event: Omit<AuditEvent, 'id' | 'at'> & { at?: number }): Promise<AuditEvent> {
    assertAuditSafe(event);

    const at = event.at ?? this.now();
    const full: AuditEvent = {
      ...(redactValue(event) as Omit<AuditEvent, 'id' | 'at'>),
      id: `aud_${at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at,
    };

    await update<AuditIndex>(this.area, INDEX_KEY, { events: [] }, (index) => {
      const events = [full, ...index.events];
      return { events: events.slice(0, this.maxEvents) };
    });

    return full;
  }

  /** Newest first. */
  async list(limit = 200): Promise<AuditEvent[]> {
    const index = (await this.area.get<AuditIndex>(INDEX_KEY)) ?? { events: [] };
    return [...index.events].slice(0, limit);
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

export interface AuditExport {
  readonly format: 'aiba-audit/1';
  readonly exportedAt: number;
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
export function buildAuditExport(events: readonly AuditEvent[], at: number): AuditExport {
  for (const event of events) {
    assertAuditSafe(event as unknown as Record<string, unknown>);
  }
  return {
    format: 'aiba-audit/1',
    exportedAt: at,
    eventCount: events.length,
    events,
    notice: EXPORT_NOTICE,
  };
}
