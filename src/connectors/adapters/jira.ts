/**
 * Jira Cloud connector — the first whose API origin belongs to the user.
 *
 * ## Why it was unimplemented, and what changed
 *
 * It was recorded as unimplemented rather than attempted, and the reason was
 * precise: *"its API base is the user's own `*.atlassian.net` site, so the
 * connector's reachable origin would have to come from the credential, and
 * `apiOrigins` is fixed when a descriptor is registered. That is a framework
 * change with a real security surface."*
 *
 * The framework change is `site-binding.ts`, and it is a tightening rather
 * than a loosening: the origin is parsed at connect time, stored **with** the
 * credential, and is the single entry in the transport's allowlist on every
 * request. A fixed descriptor may declare several origins; this permits
 * exactly one. Read that file for the rule and for what it refuses.
 *
 * ## Why a token and not OAuth
 *
 * Atlassian OAuth 2.0 (3LO) requires a `client_secret` in its code exchange
 * and **supports no PKCE at all** — the only one of the six Tier 1 services
 * where that is true of both. A secret inside an extension is readable by
 * anyone who unzips it, so there is no authorization flow this build could
 * ever complete for Jira, with or without a registered application.
 *
 * What works is what Atlassian documents for scripts and manual calls: HTTP
 * Basic with the user's email address and an API token they create in their
 * own account. Nothing is registered, no secret exists anywhere, and the user
 * can revoke the token in the same page they made it in. Atlassian's own
 * documentation prefers 3LO for distributed integrations and says so; that
 * preference is not available here, and the reason is written down rather than
 * glossed.
 *
 * ## Read-only, for the same reason Figma is
 *
 * Basic auth with an API token reports **no scopes**: there is no header
 * naming what the token may do, and the token inherits whatever the person
 * can already see. Under this build's rule that an unestablished permission
 * grants nothing, a write operation would declare a scope, never satisfy it,
 * and be refused every single time. An operation that can only fail reads as
 * a broken feature rather than an absent one, so there is none.
 *
 * That is also the conservative answer to a real asymmetry: a Jira write is a
 * comment or a transition on somebody's actual tracker, visible to a team and
 * attributed to the user. Shipping it on a credential whose reach cannot be
 * established would be the wrong first move even if the rule permitted it.
 *
 * ## What it can reach
 *
 * Two reads: search by JQL, and one issue with its comments. No project
 * enumeration, no user directory, no attachments, no worklogs. A JQL string is
 * model output and is treated as such — it goes in the request body under the
 * egress gate's carrier rules, not into a URL.
 */

import { z } from 'zod';
import { newEvidenceId } from '@/utils/ids';
import { ToolError } from '@/types/result';
import type { AgentTool, ToolExecutionResult } from '@/tools/core/tool-types';
import { connectorDestination } from '@/security/egress/destination';
import type {
  Connector,
  ConnectorAuthState,
  ConnectorCapability,
  ConnectorDescriptor,
} from '@/connectors/core/types';
import {
  TokenRejected,
  type ConnectorSession,
  type TokenIntrospection,
} from '@/connectors/core/connector-session';
import type { ConnectorTransport } from '@/connectors/transport/connector-transport';
import type { WriteGuard } from '@/connectors/core/write-guard';
import {
  ConnectorRuntime,
  truncate,
  untrustedFromConnector,
  type ConnectorCallContext,
} from '@/connectors/core/connector-runtime';

export const JIRA_CONNECTOR_ID = 'jira';

/** Atlassian Cloud only. Data Center runs on arbitrary hosts; see the module comment. */
export const JIRA_HOST_SUFFIX = '.atlassian.net';

const MAX_ISSUES = 25;
const MAX_COMMENTS = 20;
const MAX_TEXT_CHARS = 2_000;

export function jiraDescriptor(): ConnectorDescriptor {
  return {
    id: JIRA_CONNECTOR_ID,
    displayName: 'Jira',
    authKind: 'api_token',
    site: 'atlassian.net',
    defaultSensitivity: 'internal',
    // Empty on purpose, and the validator requires it to be: the origin comes
    // from the credential, and two allowlists would be two that could
    // disagree.
    apiOrigins: [],
    siteBinding: {
      hostSuffix: JIRA_HOST_SUFFIX,
      label: 'Your Jira site',
      example: 'https://your-team.atlassian.net',
    },
    // Basic, because Atlassian's token auth is base64(email:token). The
    // assembly happens in the worker, which is the only place that already
    // holds both halves.
    scopeRationale: {},
    operations: [
      {
        id: 'search_issues',
        kind: 'read',
        description: 'Search issues with JQL. Returns keys, summaries and statuses.',
        sensitivity: 'internal',
        // None, like every other read on a token whose reach the service does
        // not report. See the module comment for why that means read-only
        // rather than declared-and-always-refused.
        requiredScopes: [],
        risk: 'R1',
        requiresConfirmation: false,
      },
      {
        id: 'read_issue',
        kind: 'read',
        description: 'Read one issue and its most recent comments.',
        sensitivity: 'internal',
        requiredScopes: [],
        risk: 'R1',
        requiresConfirmation: false,
      },
    ],
  };
}

export interface JiraConnectorDeps {
  readonly descriptor: ConnectorDescriptor;
  readonly session: ConnectorSession;
  readonly transport: ConnectorTransport;
  readonly writes: WriteGuard;
  readonly egressFor: (taskId: string, operationId: string) => ConnectorCallContext | undefined;
}

/**
 * Assembles the Basic credential from the two halves the user supplied.
 *
 * Here rather than in the panel because this is the one function that needs
 * both, and a credential assembled in a surface is a credential that exists
 * in one more place. The output is the header value with no scheme —
 * `tokenType` carries `Basic` separately — so the vault stores exactly what
 * the transport will send.
 *
 * `btoa` is given a Latin-1-safe string: an email address is ASCII by
 * specification for the local part Atlassian issues tokens against, and a
 * token is base64url. A non-Latin-1 byte would throw here rather than produce
 * a silently wrong header, which is the right direction.
 */
export function jiraBasicCredential(email: string, apiToken: string): string {
  return btoa(`${email}:${apiToken}`);
}

/** Where a supplied Jira credential is checked, on the user's own site. */
export function jiraTokenProbeUrl(boundOrigin: string): string {
  // `/myself` is the smallest call that establishes the credential works and
  // whose account it is. It reads no issue and writes nothing.
  return `${boundOrigin.replace(/\/+$/, '')}/rest/api/3/myself`;
}

/**
 * Reads Jira's answer about a supplied credential.
 *
 * Scopes are always `null`, and that is a fact about Basic auth rather than a
 * shortcut: nothing in the response says what the token may do, and the token
 * inherits whatever the person can already see. So the reach is never
 * established, which is why this adapter declares no write.
 *
 * 401 and 403 are both refusals. Jira answers 401 for a bad credential and
 * 403 for one that is real but blocked — by a CAPTCHA challenge after failed
 * attempts, or by a site policy. Neither is a credential this build should
 * store, and the two reach the user as different sentences because they lead
 * to different actions.
 */
export function readJiraTokenProbe(response: {
  readonly status: number;
  readonly displayName?: unknown;
  readonly emailAddress?: unknown;
}): TokenIntrospection {
  if (response.status === 401) {
    throw new TokenRejected('Jira did not accept that email address and API token.');
  }
  if (response.status === 403) {
    throw new TokenRejected(
      'Jira accepted the credential but refused the request. Sign in to your site in a ' +
        'browser once — repeated failed attempts can require it — and try again.',
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`jira_token_probe_status_${response.status}`);
  }

  const label =
    typeof response.displayName === 'string' && response.displayName.length > 0
      ? response.displayName
      : typeof response.emailAddress === 'string'
        ? response.emailAddress
        : '';

  return {
    scopes: null,
    ...(label.length === 0 ? {} : { accountLabel: label.slice(0, 64) }),
  };
}

// --- wire shapes ------------------------------------------------------------

interface WireIssue {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    description?: unknown;
    reporter?: { displayName?: string };
  };
}

interface WireComment {
  id?: string;
  author?: { displayName?: string };
  created?: string;
  body?: unknown;
}

/**
 * An issue key, as it appears in a Jira URL the user already has open.
 *
 * `ABC-123`. No slashes and no dots, so a key cannot carry a path segment into
 * the URL this builds — which matters more here than elsewhere, because the
 * origin is the user's own site and a traversal would stay inside the
 * allowlist.
 */
const issueKeyPattern = /^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/;

const searchInput = z.object({
  jql: z.string().min(2).max(500).describe('A JQL query, e.g. project = ABC AND status = Open.'),
});

const readInput = z.object({
  issueKey: z.string().regex(issueKeyPattern).describe('An issue key, e.g. ABC-123.'),
});

export class JiraConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly runtime: ConnectorRuntime;
  /** Where this connector's credential says it may go. Read per call, never cached. */
  private readonly originFor: () => Promise<string | null>;

  constructor(deps: JiraConnectorDeps & { readonly boundOrigin: () => Promise<string | null> }) {
    this.descriptor = deps.descriptor;
    this.originFor = deps.boundOrigin;
    this.runtime = new ConnectorRuntime({
      ...deps,
      classifyStatus: classifyJiraStatus,
    });
  }

  authenticate(): Promise<ConnectorAuthState> {
    return this.runtime.authenticate();
  }

  getAuthState(): Promise<ConnectorAuthState> {
    return this.runtime.getAuthState();
  }

  revoke(): Promise<void> {
    return this.runtime.revoke();
  }

  listCapabilities(): Promise<ConnectorCapability[]> {
    return this.runtime.listCapabilities();
  }

  /**
   * The API base for this connection, or a refusal.
   *
   * Read on every call rather than captured, so a site that has been changed
   * or a credential that has been discarded cannot leave a previous origin in
   * use. The transport checks the same binding again independently — this is
   * what builds a URL, that is what permits one, and neither relies on the
   * other being right.
   */
  private async base(): Promise<string> {
    const origin = await this.originFor();
    if (origin === null) {
      throw new ToolError('AUTH_REQUIRED', 'Jira is not connected.', {
        userMessage: 'Connect Jira in Settings first.',
        retryable: false,
      });
    }
    return `${origin}/rest/api/3`;
  }

  createTools(): AgentTool[] {
    return [this.searchTool(), this.readTool()] as AgentTool[];
  }

  private searchTool(): AgentTool<typeof searchInput> {
    return {
      name: 'jira.search_issues',
      version: '1.0.0',
      description:
        'Search Jira issues with JQL. Returns keys, summaries and statuses, not descriptions.',
      inputSchema: searchInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      siteAuthorization: 'none',
      sideEffects: ['Sends the search query to your Jira site.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Search Jira for "${truncate(input.jql, 80)}".`,
        egress: {
          // The connector id and nothing site-specific: a destination
          // identity that carried the tenant would put the user's site name
          // into every consent record and audit row.
          destination: connectorDestination(this.descriptor.id, 'https://api.atlassian.com', {
            purpose: 'search_issues',
          }),
          // The query is model output and can carry anything the task read.
          carrier: { writesValue: true },
          payload: input.jql,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        // POST, so the JQL travels in a body under the gate's carrier rules
        // rather than in a URL that reaches logs and histories.
        const response = await this.runtime.call('search_issues', context.taskId, {
          url: `${await this.base()}/search/jql`,
          method: 'POST',
          body: JSON.stringify({
            jql: input.jql,
            maxResults: MAX_ISSUES,
            fields: ['summary', 'status', 'issuetype'],
          }),
        });
        if (!response.ok) throw await this.runtime.httpError(response);

        const body = (await response.json()) as { issues?: WireIssue[] };
        const issues = (body.issues ?? []).slice(0, MAX_ISSUES).map((issue) => ({
          key: issue.key,
          summary: truncate(issue.fields?.summary ?? '', 200),
          status: issue.fields?.status?.name,
          type: issue.fields?.issuetype?.name,
        }));

        return {
          success: true,
          data: {
            returned: issues.length,
            // The keys alone, typed and validated. Everything a person wrote
            // is in `items`, wrapped, and nothing reads it mechanically — an
            // issue key is an identifier the service assigned and cannot
            // carry an instruction.
            keys: issues.flatMap((issue) =>
              typeof issue.key === 'string' && issueKeyPattern.test(issue.key) ? [issue.key] : [],
            ),
            items: untrustedFromConnector(
              JSON.stringify(issues),
              this.descriptor.site,
              'search_issues',
            ),
          },
          taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
        };
      },
    };
  }

  private readTool(): AgentTool<typeof readInput> {
    return {
      name: 'jira.read_issue',
      version: '1.0.0',
      description: 'Read one Jira issue and its most recent comments.',
      inputSchema: readInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      siteAuthorization: 'none',
      sideEffects: ['Asks your Jira site for one issue.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Read Jira issue ${input.issueKey}.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, 'https://api.atlassian.com', {
            purpose: 'read_issue',
          }),
          carrier: { writesValue: false },
          payload: input.issueKey,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        const base = await this.base();
        const response = await this.runtime.call('read_issue', context.taskId, {
          url: `${base}/issue/${input.issueKey}?fields=summary,status,issuetype,description,reporter`,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);
        const issue = (await response.json()) as WireIssue;

        const commentsResponse = await this.runtime.call('read_issue', context.taskId, {
          url: `${base}/issue/${input.issueKey}/comment?maxResults=${MAX_COMMENTS}&orderBy=-created`,
          method: 'GET',
        });
        const comments = commentsResponse.ok
          ? (((await commentsResponse.json()) as { comments?: WireComment[] }).comments ?? [])
          : [];

        // Everything below is written by people on a team. It is flattened,
        // truncated, labelled and wrapped; it never becomes an instruction.
        const document = JSON.stringify({
          key: issue.key,
          summary: truncate(issue.fields?.summary ?? '', 200),
          status: issue.fields?.status?.name,
          type: issue.fields?.issuetype?.name,
          reporter: truncate(issue.fields?.reporter?.displayName ?? '', 64),
          description: truncate(flattenAdf(issue.fields?.description), MAX_TEXT_CHARS),
          comments: comments.slice(0, MAX_COMMENTS).map((comment) => ({
            author: truncate(comment.author?.displayName ?? '', 64),
            created: comment.created,
            body: truncate(flattenAdf(comment.body), MAX_TEXT_CHARS),
          })),
        });

        context.recordEvidence(
          {
            id: newEvidenceId(),
            type: 'API_RESPONSE',
            taskId: context.taskId,
            toolCallId: context.toolCallId,
            sourceTool: 'jira.read_issue',
            createdAt: Date.now(),
            sensitivity: 'internal',
            trust: 'untrusted_external_content',
            origin: this.descriptor.site,
            label: `Jira ${input.issueKey}`,
          },
          { content: document, encoding: 'utf8', mimeType: 'application/json' },
        );

        return {
          success: true,
          data: {
            issue: untrustedFromConnector(document, this.descriptor.site, 'read_issue'),
          },
          taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
        };
      },
    };
  }
}

/**
 * Atlassian Document Format, flattened to the text it contains.
 *
 * Jira v3 returns rich text as a nested node tree. This walks it and keeps
 * only `text` leaves, which is the whole of what a reader needs and avoids
 * handing the model a structure it would try to interpret. Depth-limited,
 * because the input is a stranger's document and a cyclic or pathologically
 * deep one must cost a bounded amount rather than a stack.
 *
 * Anything it cannot read becomes the empty string. A partial read of somebody
 * else's rich text is better than a guess at it, and the result is wrapped as
 * untrusted either way.
 */
export function flattenAdf(node: unknown, depth = 0): string {
  if (depth > 12 || node === null || typeof node !== 'object') return '';
  const record = node as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof record.text === 'string') return record.text;
  if (!Array.isArray(record.content)) return '';
  const parts: string[] = [];
  for (const child of record.content) {
    const text = flattenAdf(child, depth + 1);
    if (text.length > 0) parts.push(text);
    // A bounded total, so one enormous document cannot be walked in full
    // before being truncated afterwards.
    if (parts.join(' ').length > MAX_TEXT_CHARS * 2) break;
  }
  return parts.join(' ');
}

/**
 * The statuses the shared mapping would read wrongly for Jira.
 *
 * **400** is how Jira reports invalid JQL, which is the single most likely
 * failure here and is the model's mistake to correct rather than the user's.
 * The shared message — "rejected that request as invalid" — does not say which
 * part was invalid or that it can be retried differently.
 *
 * **403** is a real credential that was blocked, commonly by a CAPTCHA
 * challenge after failed sign-ins. The shared message blames the
 * authorization's scope, which Basic auth does not have.
 *
 * **404** on an issue means it does not exist *or* is not visible, and Jira
 * uses the same answer for both deliberately. The message claims neither.
 */
function classifyJiraStatus(
  response: Response,
  displayName: string,
  detail: string,
): ToolError | undefined {
  if (response.status === 400) {
    return new ToolError('INVALID_ARGUMENT', `${displayName} rejected the query.`, {
      userMessage:
        'Jira rejected that search. The JQL is not valid — check the field and project names.',
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 403) {
    return new ToolError('PERMISSION_DENIED', `${displayName} refused this operation.`, {
      userMessage:
        'Jira refused that. Sign in to your site in a browser once — repeated failed attempts ' +
        'can require it — or ask whoever administers the site about your permissions.',
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 404) {
    return new ToolError('CONNECTOR_ERROR', 'Not found.', {
      userMessage: 'That issue was not found, or is not visible to the connected account.',
      retryable: false,
    });
  }
  return undefined;
}
