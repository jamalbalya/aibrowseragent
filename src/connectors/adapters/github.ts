/**
 * GitHub connector.
 *
 * **Why GitHub is the first one.** Chosen against the criteria in the wave
 * brief rather than by popularity:
 *
 *  - *Testability.* A plain REST API over JSON with conventional OAuth
 *    (authorization code, PKCE supported). A local mock can speak it
 *    faithfully over real sockets, which several of the alternatives cannot —
 *    Google's flows assume a web-server client and a consent screen that has
 *    no local equivalent.
 *  - *Least privilege.* Its scopes decompose cleanly: `public_repo` is write
 *    access limited to public repositories, and reading public issues needs
 *    no scope at all. A connector that can only be authorised at "all your
 *    files" granularity cannot demonstrate scope minimisation.
 *  - *A real read/write split.* Search and read are unambiguously read;
 *    creating an issue and commenting are unambiguously write, irreversible
 *    enough to be worth confirming, and have **no idempotency key** — which
 *    is what makes the duplicate-write protection load-bearing rather than
 *    decorative.
 *  - *Surface.* Four operations, no file transfer, no attachments, no
 *    mail-sending. Everything this connector can do is public and reversible
 *    by a person.
 *
 * Deliberately not implemented: repository writes, workflow dispatch, release
 * creation, anything touching Actions secrets. They are not needed to
 * establish the framework and each adds irreversible reach.
 *
 * **No live OAuth application exists for this project.** The client id is
 * configuration, supplied by whoever deploys it; without one the connector
 * reports as unconfigured and refuses rather than pretending.
 *
 * ## A correction, and why this connector authenticates with a token
 *
 * An earlier revision of the paragraph above said GitHub needs "no client
 * secret ... for a public client". **That is wrong**, and it was wrong in a way
 * that mattered: GitHub's web application flow lists `client_secret` as
 * *required* when exchanging the code at `/login/oauth/access_token`, PKCE or
 * not. `ConnectorOAuthConfig` deliberately carries no secret, so the flow this
 * build runs cannot be completed against GitHub at all — and registering an
 * application would not change that. It went unnoticed because no
 * authorization has ever been attempted: the deployment has no client id, so
 * the flow is refused before it starts, and the refusal looked like the only
 * thing missing was a registration.
 *
 * It is not GitHub-specific. Atlassian requires a secret and supports no PKCE
 * at all; Figma requires a secret even with PKCE. `docs/connectors.md` has the
 * table for all six Tier-1 services and the two mechanisms that do work
 * without one: the device authorization flow, and a token the user creates in
 * their own account.
 *
 * This adapter therefore supports both auth kinds. The OAuth configuration
 * stays — it is correct, and it is what a deployment holding a secret
 * elsewhere would use — and `authKind` is an option, so the deployment states
 * which mechanism it actually has. The shipped build says `api_token`, because
 * that is the one that can connect.
 */

import { z } from 'zod';
import { ToolError } from '@/types/result';
import { newEvidenceId } from '@/utils/ids';
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

export type { ConnectorCallContext };

export const GITHUB_CONNECTOR_ID = 'github';

/** Caps on what a read may bring back into model context. */
const MAX_ITEMS = 25;
const MAX_BODY_CHARS = 4000;

export function githubDescriptor(options: {
  apiOrigin?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  redirectUri: string;
  /**
   * How this deployment authenticates.
   *
   * Defaults to `oauth2`, which is what the configuration below describes and
   * what a deployment holding a client secret somewhere other than the
   * extension would use. The shipped worker passes `api_token`, because no
   * such secret exists here and the code exchange cannot be completed without
   * one. See the module comment.
   */
  authKind?: 'oauth2' | 'api_token';
}): ConnectorDescriptor {
  const apiOrigin = options.apiOrigin ?? 'https://api.github.com';
  return {
    id: GITHUB_CONNECTOR_ID,
    displayName: 'GitHub',
    authKind: options.authKind ?? 'oauth2',
    site: 'github.com',
    defaultSensitivity: 'internal',
    apiOrigins: [apiOrigin],
    oauth: {
      authorizationEndpoint:
        options.authorizationEndpoint ?? 'https://github.com/login/oauth/authorize',
      tokenEndpoint: options.tokenEndpoint ?? 'https://github.com/login/oauth/access_token',
      redirectUri: options.redirectUri,
      readScopes: ['public_repo'],
      writeScopes: ['public_repo'],
    },
    scopeRationale: {
      public_repo:
        'Read and comment on issues in public repositories. Requested only when write ' +
        'operations are enabled; reading public issues needs no scope at all.',
    },
    operations: [
      {
        id: 'search_issues',
        kind: 'read',
        description: 'Search issues and pull requests.',
        sensitivity: 'internal',
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
      {
        id: 'create_issue',
        kind: 'write',
        description: 'Open a new issue.',
        sensitivity: 'internal',
        requiredScopes: ['public_repo'],
        // Visible to everyone who can see the repository, and attributed to
        // the user. Not something to do without being asked.
        risk: 'R3',
        requiresConfirmation: true,
      },
      {
        id: 'comment_issue',
        kind: 'write',
        description: 'Add a comment to an existing issue.',
        sensitivity: 'internal',
        requiredScopes: ['public_repo'],
        risk: 'R3',
        requiresConfirmation: true,
      },
    ],
  };
}

/**
 * What a user-supplied GitHub token is asked, and how its answer is read.
 *
 * Split into a URL and a reader, with nothing in between, because the send
 * itself must not happen here. The request carries the credential, and the
 * only place in this build that sends a credential-bearing request outside the
 * connector transport is the worker's authentication path — the same one the
 * token exchange uses, and for the same reasons: it belongs to no task, must
 * not be attributed to one, and must never be logged. The transport cannot do
 * it either, because the transport reads the credential out of the vault and
 * the whole point is to check this one *before* it is stored.
 *
 * So the service knowledge lives here and the sending lives there.
 */
export function githubTokenProbeUrl(apiOrigin: string): string {
  // `GET /user` is the smallest call that establishes a token is real and
  // whose account it belongs to. It reads no repository and writes nothing.
  return `${apiOrigin.replace(/\/+$/, '')}/user`;
}

/**
 * Reads GitHub's answer about a token.
 *
 * Three outcomes, and the difference between the last two is the point:
 *
 *  - **401 or 403** — the token is not valid, or not valid for this. Refused,
 *    as `TokenRejected`, so the user is told to supply another one.
 *  - **A classic token** — GitHub returns `x-oauth-scopes`, so the scopes are
 *    *known* and recorded exactly. A token lacking `public_repo` then cannot
 *    run a write: the refusal happens in the preflight, before anything is
 *    sent, and names the missing permission.
 *  - **A fine-grained token** — no `x-oauth-scopes` header comes back at all.
 *    The scopes are **unknown**, reported as `null`, and the session records
 *    none. Every write refuses. Claiming the scopes the descriptor wanted
 *    would assert a permission nobody established, and what it would buy is a
 *    write that fails at the service after the user approved it.
 *
 * An empty header value is `[]` and not `null`: GitHub sending the header with
 * nothing in it is GitHub saying the token has no scopes, which is an answer.
 */
export function readGitHubTokenProbe(response: {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly login?: unknown;
}): TokenIntrospection {
  if (response.status === 401 || response.status === 403) {
    throw new TokenRejected();
  }
  if (response.status < 200 || response.status >= 300) {
    // Not a refusal — a service that could not be asked. The session reports
    // these differently because they send the user to different actions.
    throw new Error(`github_token_probe_status_${response.status}`);
  }

  const header = response.headers.get('x-oauth-scopes');
  const scopes =
    header === null
      ? null
      : header
          .split(',')
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0);

  // The login is a public account name, not a credential. It is the one thing
  // shown in the panel so a user with two accounts can tell which is
  // connected, and it is length-capped because it arrives from the service.
  const login = typeof response.login === 'string' ? response.login.slice(0, 64) : '';

  return {
    scopes,
    ...(login.length === 0 ? {} : { accountLabel: login }),
  };
}

export interface GitHubConnectorDeps {
  readonly descriptor: ConnectorDescriptor;
  readonly session: ConnectorSession;
  readonly transport: ConnectorTransport;
  readonly writes: WriteGuard;
  /** Resolves the security context for the task making the call. */
  readonly egressFor: (taskId: string, operationId: string) => ConnectorCallContext | undefined;
}

// --- wire shapes ------------------------------------------------------------

interface WireIssue {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  body?: string | null;
  user?: { login?: string };
  comments?: number;
}

interface WireSearch {
  total_count?: number;
  items?: WireIssue[];
}

interface WireComment {
  id?: number;
  body?: string | null;
  user?: { login?: string };
}

const repoPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const searchInput = z.object({
  query: z.string().min(2).max(256).describe('GitHub issue search query.'),
  repository: z
    .string()
    .regex(repoPattern)
    .optional()
    .describe('Restrict to one repository, as owner/name.'),
});

const readInput = z.object({
  repository: z.string().regex(repoPattern).describe('Repository as owner/name.'),
  issueNumber: z.number().int().positive().describe('Issue or pull request number.'),
});

const createInput = z.object({
  repository: z.string().regex(repoPattern).describe('Repository as owner/name.'),
  title: z.string().min(1).max(256).describe('Issue title.'),
  body: z.string().max(16_000).describe('Issue body, in Markdown.'),
});

const commentInput = z.object({
  repository: z.string().regex(repoPattern).describe('Repository as owner/name.'),
  issueNumber: z.number().int().positive().describe('Issue or pull request number.'),
  body: z.string().min(1).max(16_000).describe('Comment body, in Markdown.'),
});

export class GitHubConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly runtime: ConnectorRuntime;

  constructor(deps: GitHubConnectorDeps) {
    this.descriptor = deps.descriptor;
    this.runtime = new ConnectorRuntime({
      ...deps,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      classifyStatus: classifyGitHubStatus,
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

  private apiBase(): string {
    return this.runtime.apiBase();
  }

  createTools(): AgentTool[] {
    return [
      this.searchTool(),
      this.readTool(),
      this.createIssueTool(),
      this.commentTool(),
    ] as AgentTool[];
  }

  // --- read -----------------------------------------------------------------

  private searchTool(): AgentTool<typeof searchInput> {
    return {
      name: 'github.search_issues',
      version: '1.0.0',
      description:
        'Search GitHub issues and pull requests. Returns titles, numbers and links, not bodies.',
      inputSchema: searchInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      // A connector call reaches an API over the network, not a page in a
      // tab. Its authorization is the connector's own OAuth grant and the
      // egress gate; no browser site governs it.
      siteAuthorization: 'none',
      sideEffects: ['Sends the search terms to GitHub.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Search GitHub issues for "${input.query}".`,
        egress: {
          destination: connectorDestination(this.descriptor.id, this.apiBase(), {
            purpose: 'search_issues',
          }),
          // The query is model output and can carry anything the task has read.
          carrier: { writesValue: true },
          payload: input.query,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        const q = input.repository ? `${input.query} repo:${input.repository}` : input.query;
        const url = `${this.apiBase()}/search/issues?q=${encodeURIComponent(q)}&per_page=${MAX_ITEMS}`;
        const response = await this.runtime.call('search_issues', context.taskId, {
          url,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);

        const body = (await response.json()) as WireSearch;
        const items = (body.items ?? []).slice(0, MAX_ITEMS).map((issue) => ({
          number: issue.number,
          title: truncate(issue.title ?? '', 200),
          state: issue.state,
          url: issue.html_url,
        }));

        return {
          success: true,
          // Wrapped as untrusted: an issue title is written by whoever opened
          // the issue, and an agent reading one must not act on what it says.
          data: {
            totalCount: body.total_count ?? items.length,
            returned: items.length,
            // The issue numbers on their own, typed and validated.
            //
            // Everything a stranger wrote is in `items`, wrapped, and nothing
            // may be read out of it mechanically. An issue number is not
            // something a stranger wrote in any meaningful sense: it is an
            // integer the service assigned, and an integer cannot carry an
            // instruction. Publishing them separately is what lets a workflow
            // say "read the first match" without any part of it parsing
            // untrusted text.
            numbers: items.flatMap((issue) =>
              typeof issue.number === 'number' && Number.isInteger(issue.number) && issue.number > 0
                ? [issue.number]
                : [],
            ),
            items: untrustedFromConnector(
              JSON.stringify(items),
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
      name: 'github.read_issue',
      version: '1.0.0',
      description: 'Read one GitHub issue and its most recent comments.',
      inputSchema: readInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      // A connector call reaches an API over the network, not a page in a
      // tab. Its authorization is the connector's own OAuth grant and the
      // egress gate; no browser site governs it.
      siteAuthorization: 'none',
      sideEffects: ['Asks GitHub for one issue.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Read ${input.repository}#${input.issueNumber} from GitHub.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, this.apiBase(), {
            purpose: 'read_issue',
          }),
          // The repository and issue number are the only task-derived values
          // in the request, and both are already public identifiers.
          carrier: { writesValue: false },
          payload: `${input.repository}#${input.issueNumber}`,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        const base = `${this.apiBase()}/repos/${input.repository}/issues/${input.issueNumber}`;
        const response = await this.runtime.call('read_issue', context.taskId, {
          url: base,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);
        const issue = (await response.json()) as WireIssue;

        const commentsResponse = await this.runtime.call('read_issue', context.taskId, {
          url: `${base}/comments?per_page=10`,
          method: 'GET',
        });
        const comments = commentsResponse.ok
          ? ((await commentsResponse.json()) as WireComment[])
          : [];

        // Everything below is written by strangers. It is truncated, labelled
        // and wrapped; it never becomes an instruction.
        const document = JSON.stringify({
          number: issue.number,
          title: truncate(issue.title ?? '', 200),
          state: issue.state,
          author: issue.user?.login,
          body: truncate(issue.body ?? '', MAX_BODY_CHARS),
          comments: comments.slice(0, 10).map((comment) => ({
            author: comment.user?.login,
            body: truncate(comment.body ?? '', 1000),
          })),
        });

        context.recordEvidence(
          {
            id: newEvidenceId(),
            type: 'API_RESPONSE',
            taskId: context.taskId,
            toolCallId: context.toolCallId,
            sourceTool: 'github.read_issue',
            createdAt: Date.now(),
            sensitivity: 'internal',
            trust: 'untrusted_external_content',
            origin: this.descriptor.site,
            label: `GitHub ${input.repository}#${input.issueNumber}`,
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

  // --- write ----------------------------------------------------------------

  private createIssueTool(): AgentTool<typeof createInput> {
    return {
      name: 'github.create_issue',
      version: '1.0.0',
      description: 'Open a new GitHub issue. Visible to anyone who can see the repository.',
      inputSchema: createInput,
      risk: 'R3',
      executionMode: 'requires_connector',
      // A connector call reaches an API over the network, not a page in a
      // tab. Its authorization is the connector's own OAuth grant and the
      // egress gate; no browser site governs it.
      siteAuthorization: 'none',
      sideEffects: ['Creates a public issue attributed to your GitHub account.'],
      timeoutMs: 30_000,
      idempotent: false,
      classify: (input) => ({
        summary: `Open an issue titled "${truncate(input.title, 80)}" in ${input.repository}.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, this.apiBase(), {
            purpose: 'create_issue',
          }),
          carrier: { writesValue: true },
          payload: `${input.title}\n${input.body}`,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> =>
        await this.runtime.performWrite({
          operationId: 'create_issue',
          taskId: context.taskId,
          args: input,
          url: `${this.apiBase()}/repos/${input.repository}/issues`,
          body: JSON.stringify({ title: input.title, body: input.body }),
          describe: (created: WireIssue) => ({
            number: created.number,
            url: created.html_url,
          }),
        }),
    };
  }

  private commentTool(): AgentTool<typeof commentInput> {
    return {
      name: 'github.comment_issue',
      version: '1.0.0',
      description: 'Comment on a GitHub issue. Visible to anyone who can see the repository.',
      inputSchema: commentInput,
      risk: 'R3',
      executionMode: 'requires_connector',
      // A connector call reaches an API over the network, not a page in a
      // tab. Its authorization is the connector's own OAuth grant and the
      // egress gate; no browser site governs it.
      siteAuthorization: 'none',
      sideEffects: ['Posts a public comment attributed to your GitHub account.'],
      timeoutMs: 30_000,
      idempotent: false,
      classify: (input) => ({
        summary: `Comment on ${input.repository}#${input.issueNumber}.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, this.apiBase(), {
            purpose: 'comment_issue',
          }),
          carrier: { writesValue: true },
          payload: input.body,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> =>
        await this.runtime.performWrite({
          operationId: 'comment_issue',
          taskId: context.taskId,
          args: input,
          url: `${this.apiBase()}/repos/${input.repository}/issues/${input.issueNumber}/comments`,
          body: JSON.stringify({ body: input.body }),
          describe: (created: WireComment) => ({ id: created.id }),
        }),
    };
  }
}

/**
 * The two statuses the shared mapping would read wrongly for GitHub.
 *
 * **403.** GitHub answers both "forbidden" and "rate limited" with it, and the
 * header is what distinguishes them. The difference is not cosmetic: a rate
 * limit is retryable and a refusal is not, so collapsing them either loops
 * against a permanent refusal or gives up on a wait.
 *
 * **404.** The shared message is correct and vague; this one names what was
 * looked for. GitHub returns 404 rather than 403 for a private repository the
 * token cannot see, which is deliberate on their side and worth not
 * contradicting — "not found, or not visible to this account" is true of both
 * cases and claims neither.
 *
 * Everything else falls through, because nothing else about GitHub's status
 * usage differs from the common reading.
 */
function classifyGitHubStatus(
  response: Response,
  displayName: string,
  detail: string,
): ToolError | undefined {
  if (response.status === 403) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return new ToolError('RATE_LIMITED', `${displayName} is rate limiting requests.`, {
        userMessage: `${displayName} is rate limiting requests. Try again shortly.`,
        retryable: true,
      });
    }
    return new ToolError('PERMISSION_DENIED', `${displayName} refused this operation.`, {
      userMessage: `Your ${displayName} authorization does not permit that.`,
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 404) {
    return new ToolError('CONNECTOR_ERROR', 'Not found.', {
      userMessage: 'That repository or issue was not found, or is not visible to this account.',
      retryable: false,
    });
  }
  return undefined;
}
