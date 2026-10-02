/**
 * Confluence Cloud connector — the fourth, and the last one that was reachable.
 *
 * ## Why it exists, and why now rather than earlier
 *
 * `docs/connectors.md` already claimed it: *"Confluence shares Atlassian's API
 * and is now reachable by the same mechanism."* That was a claim with no
 * evidence behind it, which in this repository is the kind of sentence that
 * gets found and corrected later. It is now exercised instead of asserted.
 *
 * It needed nothing new. The site binding, the credential header, the shared
 * runtime and the token path were all built for Jira; this adapter is the
 * Confluence half of the same arrangement, and if it had needed a framework
 * change it would not have been in scope for a closure audit.
 *
 * ## The same site, and deliberately not the same credential record
 *
 * Jira and Confluence live on one `*.atlassian.net` site and accept the same
 * email-and-API-token pair, so a user connecting both types the same thing
 * twice. That is a real cost and it is the right trade: a credential record
 * holds one token and one bound origin, and `connectorId` is what the consent
 * pin, the audit trail and the write guard key on. Sharing one record between
 * two connectors would make "which connector may reach where" a question with
 * two answers.
 *
 * ## Read-only, for the third time and the same reason
 *
 * Basic auth reports no scopes, so a write would declare a permission that
 * could never be established and be refused every time. A Confluence write is
 * also an edit to a page a team relies on, attributed to the user — the
 * conservative answer is the right first one even where the rule allowed
 * otherwise.
 *
 * ## One honest difference from Jira
 *
 * Jira's search is a POST, so the JQL travels in a body under the egress
 * gate's carrier rules. **Confluence's v1 search is GET only**, so the CQL
 * goes in a query string. That is the service's shape, not a choice here, and
 * it is stated rather than glossed: the request is a `fetch` from the service
 * worker to the user's own site over https, so it reaches no browser history
 * and no third party — but it is a URL, and a URL is a different kind of
 * place from a body.
 *
 * REST v1 (`/wiki/rest/api`) rather than v2, because v1 is what Atlassian's
 * own Basic-auth documentation demonstrates and because the two operations
 * here need nothing v2 adds.
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
import { JIRA_HOST_SUFFIX } from '@/connectors/adapters/jira';

export const CONFLUENCE_CONNECTOR_ID = 'confluence';

const MAX_RESULTS = 25;
const MAX_TEXT_CHARS = 4_000;

export function confluenceDescriptor(): ConnectorDescriptor {
  return {
    id: CONFLUENCE_CONNECTOR_ID,
    displayName: 'Confluence',
    authKind: 'api_token',
    site: 'atlassian.net',
    defaultSensitivity: 'internal',
    // Empty, because the origin comes from the credential. The validator
    // requires exactly one of this and `siteBinding`.
    apiOrigins: [],
    siteBinding: {
      // The same suffix Jira uses, imported rather than retyped: two
      // constants that must agree are one constant.
      hostSuffix: JIRA_HOST_SUFFIX,
      label: 'Your Atlassian site',
      example: 'https://your-team.atlassian.net',
    },
    scopeRationale: {},
    operations: [
      {
        id: 'search_pages',
        kind: 'read',
        description: 'Search Confluence pages with CQL. Returns titles, spaces and links.',
        sensitivity: 'internal',
        requiredScopes: [],
        risk: 'R1',
        requiresConfirmation: false,
      },
      {
        id: 'read_page',
        kind: 'read',
        description: 'Read one Confluence page as text.',
        sensitivity: 'internal',
        requiredScopes: [],
        risk: 'R1',
        requiresConfirmation: false,
      },
    ],
  };
}

export interface ConfluenceConnectorDeps {
  readonly descriptor: ConnectorDescriptor;
  readonly session: ConnectorSession;
  readonly transport: ConnectorTransport;
  readonly writes: WriteGuard;
  readonly egressFor: (taskId: string, operationId: string) => ConnectorCallContext | undefined;
}

/** Where a supplied Confluence credential is checked, on the user's own site. */
export function confluenceTokenProbeUrl(boundOrigin: string): string {
  // The current user, which is the smallest call that establishes the
  // credential works and whose account it is. It reads no page.
  return `${boundOrigin.replace(/\/+$/, '')}/wiki/rest/api/user/current`;
}

/**
 * Reads Confluence's answer about a supplied credential.
 *
 * Identical in shape to Jira's, and deliberately a separate function rather
 * than a shared one: the two services are free to diverge on which status
 * means what, and a shared reader would have to be changed for both the day
 * one of them does. The 403 message differs already — Confluence blocks on
 * site permissions where Jira blocks on a CAPTCHA challenge.
 */
export function readConfluenceTokenProbe(response: {
  readonly status: number;
  readonly displayName?: unknown;
  readonly email?: unknown;
}): TokenIntrospection {
  if (response.status === 401) {
    throw new TokenRejected('Confluence did not accept that email address and API token.');
  }
  if (response.status === 403) {
    throw new TokenRejected(
      'Confluence accepted the credential but refused the request. Check that this account ' +
        'has access to the site.',
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`confluence_token_probe_status_${response.status}`);
  }

  const label =
    typeof response.displayName === 'string' && response.displayName.length > 0
      ? response.displayName
      : typeof response.email === 'string'
        ? response.email
        : '';

  return {
    scopes: null,
    ...(label.length === 0 ? {} : { accountLabel: label.slice(0, 64) }),
  };
}

// --- wire shapes ------------------------------------------------------------

interface WireSearchResult {
  content?: { id?: string; title?: string; type?: string };
  title?: string;
  url?: string;
  excerpt?: string;
}

interface WirePage {
  id?: string;
  title?: string;
  type?: string;
  space?: { key?: string; name?: string };
  version?: { number?: number; when?: string };
  body?: { storage?: { value?: string } };
}

/**
 * A Confluence content id.
 *
 * Digits only, which is what Confluence mints. No slashes and no dots, so an
 * id cannot carry a path segment into the URL this builds — which matters here
 * for the same reason it does for Jira: the origin is the user's own site, so
 * a traversal would stay inside the allowlist.
 */
const contentIdPattern = /^[1-9][0-9]{0,18}$/;

const searchInput = z.object({
  cql: z
    .string()
    .min(2)
    .max(500)
    .describe('A CQL query, e.g. type = page AND space = ENG AND text ~ "release".'),
});

const readInput = z.object({
  pageId: z.string().regex(contentIdPattern).describe('A Confluence page id, e.g. 1234567.'),
});

export class ConfluenceConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly runtime: ConnectorRuntime;
  private readonly originFor: () => Promise<string | null>;

  constructor(
    deps: ConfluenceConnectorDeps & { readonly boundOrigin: () => Promise<string | null> },
  ) {
    this.descriptor = deps.descriptor;
    this.originFor = deps.boundOrigin;
    this.runtime = new ConnectorRuntime({
      ...deps,
      classifyStatus: classifyConfluenceStatus,
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
   * use. The transport checks the same binding again independently.
   */
  private async base(): Promise<string> {
    const origin = await this.originFor();
    if (origin === null) {
      throw new ToolError('AUTH_REQUIRED', 'Confluence is not connected.', {
        userMessage: 'Connect Confluence in Settings first.',
        retryable: false,
      });
    }
    return `${origin}/wiki/rest/api`;
  }

  createTools(): AgentTool[] {
    return [this.searchTool(), this.readTool()] as AgentTool[];
  }

  private searchTool(): AgentTool<typeof searchInput> {
    return {
      name: 'confluence.search_pages',
      version: '1.0.0',
      description:
        'Search Confluence with CQL. Returns page titles, spaces and links, not page bodies.',
      inputSchema: searchInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      siteAuthorization: 'none',
      sideEffects: ['Sends the search query to your Confluence site.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Search Confluence for "${truncate(input.cql, 80)}".`,
        egress: {
          // The connector id and nothing site-specific: a destination identity
          // carrying the tenant would put the user's own company name into
          // every consent record and audit row.
          destination: connectorDestination(this.descriptor.id, 'https://api.atlassian.com', {
            purpose: 'search_pages',
          }),
          // The query is model output and can carry anything the task read.
          carrier: { writesValue: true },
          payload: input.cql,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        // GET, because Confluence's v1 search has no POST form. The CQL
        // therefore travels in a query string — see the module comment for why
        // that is the service's shape rather than a choice, and what it does
        // and does not expose.
        const url =
          `${await this.base()}/search` +
          `?cql=${encodeURIComponent(input.cql)}&limit=${MAX_RESULTS}`;
        const response = await this.runtime.call('search_pages', context.taskId, {
          url,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);

        const body = (await response.json()) as { results?: WireSearchResult[] };
        const results = (body.results ?? []).slice(0, MAX_RESULTS).map((result) => ({
          id: result.content?.id,
          title: truncate(result.content?.title ?? result.title ?? '', 200),
          type: result.content?.type,
          excerpt: truncate(result.excerpt ?? '', 300),
        }));

        return {
          success: true,
          data: {
            returned: results.length,
            // The ids alone, typed and validated. Everything a person wrote is
            // in `items`, wrapped, and nothing reads it mechanically — an id is
            // a number the service assigned and cannot carry an instruction.
            ids: results.flatMap((result) =>
              typeof result.id === 'string' && contentIdPattern.test(result.id) ? [result.id] : [],
            ),
            items: untrustedFromConnector(
              JSON.stringify(results),
              this.descriptor.site,
              'search_pages',
            ),
          },
          taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
        };
      },
    };
  }

  private readTool(): AgentTool<typeof readInput> {
    return {
      name: 'confluence.read_page',
      version: '1.0.0',
      description: 'Read one Confluence page as text.',
      inputSchema: readInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      siteAuthorization: 'none',
      sideEffects: ['Asks your Confluence site for one page.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Read Confluence page ${input.pageId}.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, 'https://api.atlassian.com', {
            purpose: 'read_page',
          }),
          carrier: { writesValue: false },
          payload: input.pageId,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        const url =
          `${await this.base()}/content/${input.pageId}` + `?expand=body.storage,space,version`;
        const response = await this.runtime.call('read_page', context.taskId, {
          url,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);

        const page = (await response.json()) as WirePage;

        // Everything below is written by people on a team. The body is
        // Confluence storage format — XHTML-ish markup — so it is stripped to
        // text, truncated, labelled and wrapped; it never becomes an
        // instruction and no markup reaches the model to be interpreted.
        const document = JSON.stringify({
          id: page.id,
          title: truncate(page.title ?? '', 200),
          space: truncate(page.space?.name ?? page.space?.key ?? '', 120),
          version: page.version?.number,
          updated: page.version?.when,
          text: truncate(stripStorageMarkup(page.body?.storage?.value ?? ''), MAX_TEXT_CHARS),
        });

        context.recordEvidence(
          {
            id: newEvidenceId(),
            type: 'API_RESPONSE',
            taskId: context.taskId,
            toolCallId: context.toolCallId,
            sourceTool: 'confluence.read_page',
            createdAt: Date.now(),
            sensitivity: 'internal',
            trust: 'untrusted_external_content',
            origin: this.descriptor.site,
            label: `Confluence page ${input.pageId}`,
          },
          { content: document, encoding: 'utf8', mimeType: 'application/json' },
        );

        return {
          success: true,
          data: {
            page: untrustedFromConnector(document, this.descriptor.site, 'read_page'),
          },
          taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
        };
      },
    };
  }
}

/**
 * Confluence storage format, reduced to the text it contains.
 *
 * A page body is XHTML with Confluence's own macro elements in it. Handing
 * that to a model means handing it markup to interpret, and handing it to any
 * HTML parser here would mean parsing a stranger's document — so this does
 * neither: it removes tags and decodes the five XML entities, which is the
 * whole of what a reader needs.
 *
 * Bounded by construction. The input is already length-limited by the caller's
 * truncation afterwards, and this does one pass with no backtracking-prone
 * pattern — `[^>]*` cannot backtrack across a `>`, which is the shape that
 * makes a tag-stripping regex expensive on hostile input.
 */
export function stripStorageMarkup(value: string): string {
  if (value.length === 0) return '';
  return (
    value
      // Drop whole elements whose contents are not prose.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // Then every remaining tag, including Confluence's `ac:` macros.
      .replace(/<[^>]*>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Ampersand last, so a doubly-encoded entity does not become a tag.
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      // A tag became a space, so `<strong>monthly</strong>.` left one before the
      // full stop. Inline emphasis before punctuation is ordinary prose, and
      // every such sentence would otherwise be quoted back as "monthly .". Run
      // after the collapse above, so this matches a single space and cannot
      // backtrack over a run of them.
      .replace(/ ([.,;:!?)\]])/g, '$1')
      .trim()
  );
}

/**
 * The statuses the shared mapping would read wrongly for Confluence.
 *
 * **400** is how Confluence reports invalid CQL, which is the most likely
 * failure here and is the model's mistake to correct rather than the user's.
 *
 * **403** is a real credential without access to the site or the space, which
 * the shared message attributes to the authorization's scope — something Basic
 * auth does not have.
 *
 * **404** on a page means it does not exist *or* is not visible, and
 * Confluence uses the same answer for both. The message claims neither.
 */
function classifyConfluenceStatus(
  response: Response,
  displayName: string,
  detail: string,
): ToolError | undefined {
  if (response.status === 400) {
    return new ToolError('INVALID_ARGUMENT', `${displayName} rejected the query.`, {
      userMessage:
        'Confluence rejected that search. The CQL is not valid — check the field and space names.',
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 403) {
    return new ToolError('PERMISSION_DENIED', `${displayName} refused this operation.`, {
      userMessage:
        'Confluence refused that. The connected account may not have access to this space — ' +
        'ask whoever administers the site.',
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 404) {
    return new ToolError('CONNECTOR_ERROR', 'Not found.', {
      userMessage: 'That page was not found, or is not visible to the connected account.',
      retryable: false,
    });
  }
  return undefined;
}
