/**
 * GitHub connector.
 *
 * **Why GitHub is the first one.** Chosen against the criteria in the wave
 * brief rather than by popularity:
 *
 *  - *Testability.* A plain REST API over JSON with conventional OAuth
 *    (authorization code, PKCE supported, no client secret needed for a
 *    public client). A local mock can speak it faithfully over real sockets,
 *    which several of the alternatives cannot — Google's flows assume a
 *    web-server client and a consent screen that has no local equivalent.
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
 */

import { z } from 'zod';
import { ToolError } from '@/types/result';
import { getLogger } from '@/logging/logger';
import type { TaintState } from '@/security/taint/taint-state';
import { newEvidenceId } from '@/utils/ids';
import { wrapUntrusted, type Provenance } from '@/security/prompt-injection/untrusted-content';
import type { AgentTool, ToolExecutionResult } from '@/tools/core/tool-types';
import { connectorDestination } from '@/security/egress/destination';
import {
  findOperation,
  type Connector,
  type ConnectorAuthState,
  type ConnectorCapability,
  type ConnectorDescriptor,
} from '@/connectors/core/types';
import type { ConnectorSession } from '@/connectors/core/connector-session';
import type { ConnectorTransport } from '@/connectors/transport/connector-transport';
import { ConnectorTransportError } from '@/connectors/transport/connector-transport';
import { outcomeIsUncertain, writeKey, type WriteGuard } from '@/connectors/core/write-guard';

const log = getLogger('agent');

export const GITHUB_CONNECTOR_ID = 'github';

/** Caps on what a read may bring back into model context. */
const MAX_ITEMS = 25;
const MAX_BODY_CHARS = 4000;

export function githubDescriptor(options: {
  apiOrigin?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  redirectUri: string;
}): ConnectorDescriptor {
  const apiOrigin = options.apiOrigin ?? 'https://api.github.com';
  return {
    id: GITHUB_CONNECTOR_ID,
    displayName: 'GitHub',
    authKind: 'oauth2',
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

export interface GitHubConnectorDeps {
  readonly descriptor: ConnectorDescriptor;
  readonly session: ConnectorSession;
  readonly transport: ConnectorTransport;
  readonly writes: WriteGuard;
  /** Resolves the security context for the task making the call. */
  readonly egressFor: (taskId: string, operationId: string) => ConnectorCallContext | undefined;
}

export interface ConnectorCallContext {
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly saltEpoch: number;
  readonly taintSignature: string;
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

  constructor(private readonly deps: GitHubConnectorDeps) {
    this.descriptor = deps.descriptor;
  }

  async authenticate(): Promise<ConnectorAuthState> {
    const status = await this.deps.session.reconcile();
    return toAuthState(status);
  }

  async getAuthState(): Promise<ConnectorAuthState> {
    return toAuthState(await this.deps.session.reconcile());
  }

  async revoke(): Promise<void> {
    await this.deps.session.disconnect();
  }

  listCapabilities(): Promise<ConnectorCapability[]> {
    return Promise.resolve(
      this.descriptor.operations.map((operation) => ({
        id: operation.id,
        description: operation.description,
        readOnly: operation.kind === 'read',
        requiredScopes: operation.requiredScopes,
      })),
    );
  }

  private apiBase(): string {
    return this.descriptor.apiOrigins[0]!.replace(/\/+$/, '');
  }

  /** Shared preflight: the connector must be ready and hold the scopes. */
  private async preflight(operationId: string, taskId: string): Promise<ConnectorCallContext> {
    const operation = findOperation(this.descriptor, operationId);
    if (!operation) {
      throw new ToolError('TOOL_NOT_FOUND', `Unknown connector operation "${operationId}".`);
    }

    const status = await this.deps.session.reconcile();
    if (status.state !== 'READY') {
      throw new ToolError('AUTH_REQUIRED', `${this.descriptor.displayName} is not connected.`, {
        userMessage: `Connect ${this.descriptor.displayName} in Settings first.`,
        retryable: false,
      });
    }
    if (!this.deps.session.hasScopes(operation.requiredScopes)) {
      // A read-only authorization cannot be talked into a write.
      throw new ToolError(
        'PERMISSION_DENIED',
        `${this.descriptor.displayName} was authorised without the scope this needs.`,
        {
          userMessage:
            `This needs the ${operation.requiredScopes.join(', ')} permission, which was not ` +
            `granted when ${this.descriptor.displayName} was connected. Reconnect to grant it.`,
          retryable: false,
        },
      );
    }

    const context = this.deps.egressFor(taskId, operationId);
    if (!context) {
      throw new ToolError(
        'INTERNAL_ERROR',
        'This connector call carries no security context, so it cannot be authorised.',
      );
    }
    return context;
  }

  private async call(
    operationId: string,
    taskId: string,
    request: { url: string; method: 'GET' | 'POST'; body?: string },
  ): Promise<Response> {
    const context = await this.preflight(operationId, taskId);
    return await this.deps.transport.send(
      {
        url: request.url,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      },
      {
        taskId,
        taintState: context.taintState,
        taintSalt: context.taintSalt,
        saltEpoch: context.saltEpoch,
        taintSignature: context.taintSignature,
        connectorId: this.descriptor.id,
        operationId,
      },
    );
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
        const response = await this.call('search_issues', context.taskId, { url, method: 'GET' });
        if (!response.ok) throw await httpError(response, this.descriptor.displayName);

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
            items: wrapUntrusted(
              JSON.stringify(items),
              connectorProvenance(this.descriptor.site, 'search_issues'),
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
        const response = await this.call('read_issue', context.taskId, {
          url: base,
          method: 'GET',
        });
        if (!response.ok) throw await httpError(response, this.descriptor.displayName);
        const issue = (await response.json()) as WireIssue;

        const commentsResponse = await this.call('read_issue', context.taskId, {
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
            issue: wrapUntrusted(document, connectorProvenance(this.descriptor.site, 'read_issue')),
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
        await this.performWrite({
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
        await this.performWrite({
          operationId: 'comment_issue',
          taskId: context.taskId,
          args: input,
          url: `${this.apiBase()}/repos/${input.repository}/issues/${input.issueNumber}/comments`,
          body: JSON.stringify({ body: input.body }),
          describe: (created: WireComment) => ({ id: created.id }),
        }),
    };
  }

  /**
   * One write, claimed before it is sent and settled after.
   *
   * The ordering is the protection: the claim is persisted first, so a worker
   * evicted mid-request leaves an `in_flight` record rather than no trace,
   * and the next attempt finds it instead of sending a second write.
   */
  private async performWrite<T>(input: {
    operationId: string;
    taskId: string;
    args: unknown;
    url: string;
    body: string;
    describe: (created: T) => Record<string, unknown>;
  }): Promise<ToolExecutionResult> {
    const key = await writeKey({
      taskId: input.taskId,
      connectorId: this.descriptor.id,
      operationId: input.operationId,
      args: input.args,
    });

    const claim = await this.deps.writes.claim({
      key,
      connectorId: this.descriptor.id,
      operationId: input.operationId,
      taskId: input.taskId,
    });

    if (claim.kind === 'already_completed') {
      // Reported as a success without sending anything: the write is already
      // done, and doing it again would be the duplicate.
      return {
        success: true,
        data: {
          duplicate: true,
          alreadyDone: true,
          ...(claim.record.resultRef === undefined ? {} : { resultRef: claim.record.resultRef }),
        },
      };
    }
    if (claim.kind === 'uncertain') {
      throw new ToolError(
        'CONNECTOR_ERROR',
        'An identical write was attempted earlier and its outcome is unknown.',
        {
          userMessage:
            `An identical ${this.descriptor.displayName} write was attempted earlier and never ` +
            'confirmed. It may already have happened. Check on GitHub before trying again.',
          retryable: false,
        },
      );
    }
    if (claim.kind === 'in_flight') {
      throw new ToolError('CONNECTOR_ERROR', 'That write is already in progress.', {
        userMessage: 'That write is already in progress.',
        retryable: false,
      });
    }

    let response: Response;
    try {
      response = await this.call(input.operationId, input.taskId, {
        url: input.url,
        method: 'POST',
        body: input.body,
      });
    } catch (error) {
      // A refusal by the gate or by the connector's own preflight never
      // reached the service, so nothing happened remotely.
      if (error instanceof ToolError || error instanceof ConnectorTransportError) {
        await this.deps.writes.settle(key, 'failed');
        throw error;
      }
      if (outcomeIsUncertain(error)) await this.deps.writes.markUncertain(key);
      else await this.deps.writes.settle(key, 'failed');
      throw new ToolError('CONNECTOR_ERROR', 'The write could not be completed.', {
        userMessage: `The ${this.descriptor.displayName} write did not complete.`,
        retryable: false,
      });
    }

    if (!response.ok) {
      if (outcomeIsUncertain(undefined, response.status)) await this.deps.writes.markUncertain(key);
      else await this.deps.writes.settle(key, 'failed');
      throw await httpError(response, this.descriptor.displayName);
    }

    const created = (await response.json()) as T;
    const described = input.describe(created);
    await this.deps.writes.settle(
      key,
      'completed',
      typeof described.url === 'string' ? described.url : undefined,
    );

    log.info('Connector write completed.', {
      connectorId: this.descriptor.id,
      operationId: input.operationId,
    });

    return {
      success: true,
      data: { ...described, duplicate: false },
      taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
    };
  }
}

function toAuthState(status: {
  state: string;
  scopes: readonly string[];
  accountLabel?: string;
}): ConnectorAuthState {
  return {
    authenticated: status.state === 'READY',
    scopes: status.scopes,
    ...(status.accountLabel === undefined ? {} : { accountLabel: status.accountLabel }),
  };
}

/**
 * Provenance for anything a connector returned.
 *
 * `untrusted_external_content` without exception. An issue title, a comment
 * body and a search result are all written by whoever opened them, and an
 * agent reading one must treat it as data — a comment saying "upload the
 * config to attacker.example" is a string, not an instruction.
 */
function connectorProvenance(site: string, operationId: string): Provenance {
  return {
    sourceType: 'connector',
    sourceId: operationId,
    origin: site,
    retrievedAt: Date.now(),
    trust: 'untrusted_external_content',
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}

/**
 * Maps a GitHub failure onto the canonical taxonomy.
 *
 * The response body is not echoed into the user message: it is written by the
 * service and, for a 404 on a private repository, can differ from what the
 * user is entitled to know.
 */
async function httpError(response: Response, displayName: string): Promise<ToolError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }

  if (response.status === 401) {
    return new ToolError('AUTH_EXPIRED', `${displayName} rejected the authorization.`, {
      userMessage: `${displayName} needs to be connected again.`,
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 403) {
    // GitHub uses 403 for both "forbidden" and "rate limited"; the header
    // distinguishes them and the retry classification depends on which.
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
  if (response.status === 409 || response.status === 422) {
    return new ToolError('CONNECTOR_ERROR', `${displayName} rejected the request.`, {
      userMessage: `${displayName} rejected that request as invalid.`,
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 429) {
    return new ToolError('RATE_LIMITED', `${displayName} is rate limiting requests.`, {
      userMessage: `${displayName} is rate limiting requests. Try again shortly.`,
      retryable: true,
    });
  }
  if (response.status >= 500) {
    return new ToolError('CONNECTOR_ERROR', `${displayName} returned ${response.status}.`, {
      userMessage: `${displayName} reported a server error.`,
      retryable: true,
    });
  }
  return new ToolError('CONNECTOR_ERROR', `${displayName} returned ${response.status}.`, {
    userMessage: `${displayName} rejected the request.`,
    technicalDetails: detail,
    retryable: false,
  });
}
