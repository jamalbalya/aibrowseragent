/**
 * Figma connector — the second one, and the second that needs no registration.
 *
 * ## Why Figma, and why now
 *
 * The Tier 1 roadmap names six services. Checked against each vendor's own
 * documentation, four of them cannot be built as sign-in connectors here at
 * all: GitHub's web flow, Atlassian 3LO and Figma's OAuth all require a
 * `client_secret` in the code exchange, and this extension must not carry one.
 * `docs/connectors.md` has the table.
 *
 * What is left is the mechanism that works: a token the user creates in their
 * own account. GitHub was the first. Figma is the second, and it is the only
 * other one of the six that needs **nothing from the owner** — no registered
 * application, no client id, no deployed anything. Jira could also work this
 * way and cannot yet, for a reason that is recorded rather than worked around:
 * its API base is the user's own `*.atlassian.net` site, so the connector's
 * reachable origin would have to come from the credential, and `apiOrigins` is
 * fixed when a descriptor is registered. That is a framework change, not an
 * adapter.
 *
 * ## Read-only, deliberately, and not for caution's sake
 *
 * Figma reports nothing about what a personal access token may do — there is
 * no response header naming its scopes, the way GitHub's `x-oauth-scopes`
 * does for a classic token. Under this build's rule that an unestablished
 * permission grants nothing, a write operation would declare
 * `file_comments:write`, never be able to satisfy it, and be **refused every
 * time**. Shipping an operation that can only fail is worse than shipping
 * none: it reads as a broken feature rather than an absent one.
 *
 * So the two read operations declare **no required scopes** — exactly as
 * GitHub's reads do — and there is no write. If Figma later reports a token's
 * scopes, a write becomes implementable and the reason to add it will be
 * evidence rather than symmetry.
 *
 * ## The credential does not go in `Authorization`
 *
 * Figma's REST API reads `X-Figma-Token` and ignores `Authorization`, and that
 * header's syntax is the token with no scheme. Both facts are on the
 * descriptor — `credentialHeader` and a stored `tokenType` of `null` — so the
 * transport still applies the credential last, still strips every spelling of
 * it *and* of `Authorization` from caller headers first, and still never hands
 * it back. A connector that sent `Bearer <token>` to `Authorization` here
 * would be an unauthenticated request with the user's token attached to it.
 *
 * ## What it can reach
 *
 * Two reads: a file's structure, and a file's comments. No image exports, no
 * team or project listing, no version history, no webhooks. A file key is
 * something the user pastes from a URL they already have open; nothing here
 * searches, enumerates or discovers a file the user did not name.
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

export const FIGMA_CONNECTOR_ID = 'figma';

/** The header Figma reads a personal access token from. */
export const FIGMA_CREDENTIAL_HEADER = 'X-Figma-Token';

/** Caps on what one read may bring back into model context. */
const MAX_COMMENTS = 25;
const MAX_COMMENT_CHARS = 1_000;
const MAX_NODES = 200;

export function figmaDescriptor(options: { apiOrigin?: string } = {}): ConnectorDescriptor {
  const apiOrigin = options.apiOrigin ?? 'https://api.figma.com';
  return {
    id: FIGMA_CONNECTOR_ID,
    displayName: 'Figma',
    // A token the user issues. Figma's OAuth needs a client secret this
    // extension must not hold, so there is no `oauth` block to describe.
    authKind: 'api_token',
    site: 'figma.com',
    defaultSensitivity: 'internal',
    apiOrigins: [apiOrigin],
    credentialHeader: FIGMA_CREDENTIAL_HEADER,
    scopeRationale: {},
    operations: [
      {
        id: 'read_file',
        kind: 'read',
        description: 'Read the structure of one Figma file: its name, pages and layer names.',
        sensitivity: 'internal',
        // None, like GitHub's reads. Figma reports nothing about what a
        // personal access token may do, so a declared scope here could never
        // be satisfied and the operation could never run. See the module
        // comment for why that means read-only rather than
        // declared-and-always-refused.
        requiredScopes: [],
        risk: 'R1',
        requiresConfirmation: false,
      },
      {
        id: 'read_comments',
        kind: 'read',
        description: 'Read the comments on one Figma file.',
        sensitivity: 'internal',
        requiredScopes: [],
        risk: 'R1',
        requiresConfirmation: false,
      },
    ],
  };
}

export interface FigmaConnectorDeps {
  readonly descriptor: ConnectorDescriptor;
  readonly session: ConnectorSession;
  readonly transport: ConnectorTransport;
  readonly writes: WriteGuard;
  readonly egressFor: (taskId: string, operationId: string) => ConnectorCallContext | undefined;
}

// --- the token probe --------------------------------------------------------

/**
 * Where a supplied Figma token is checked.
 *
 * `GET /v1/me` is the smallest call that establishes a token is real and whose
 * account it belongs to. It reads no file and writes nothing.
 */
export function figmaTokenProbeUrl(apiOrigin: string): string {
  return `${apiOrigin.replace(/\/+$/, '')}/v1/me`;
}

/**
 * Reads Figma's answer about a token.
 *
 * **Scopes are always `null` here, and that is a fact about Figma rather than
 * a shortcut.** It returns no header naming what a personal access token may
 * do. So the reach is never established, every operation needing a scope would
 * refuse, and the only operations this adapter declares are the ones that need
 * none.
 *
 * 401 and 403 are both refusals of the token. That is deliberately
 * conservative: Figma's `/v1/me` needs the `current_user:read` scope, so a
 * token without it could in principle produce a 403 while still being valid
 * for reading files. Accepting a 403 would mean accepting whatever a wrong
 * token produces, which is the worse error of the two — so the token hint tells
 * the user to include `current_user:read`, and this refuses rather than guesses.
 * If the distinction is ever established against a real account, this is the
 * one place to change.
 */
export function readFigmaTokenProbe(response: {
  readonly status: number;
  readonly handle?: unknown;
  readonly email?: unknown;
}): TokenIntrospection {
  if (response.status === 401 || response.status === 403) {
    throw new TokenRejected();
  }
  if (response.status < 200 || response.status >= 300) {
    // Not a refusal — a service that could not be asked. The session reports
    // these differently because they send the user to different actions.
    throw new Error(`figma_token_probe_status_${response.status}`);
  }

  // A handle or an email is a name shown in the panel so a user with two
  // accounts can tell which is connected. Capped, because it arrives from the
  // service; preferring the handle because it is the less personal of the two.
  const label =
    typeof response.handle === 'string' && response.handle.length > 0
      ? response.handle
      : typeof response.email === 'string'
        ? response.email
        : '';

  return {
    scopes: null,
    ...(label.length === 0 ? {} : { accountLabel: label.slice(0, 64) }),
  };
}

// --- wire shapes ------------------------------------------------------------

interface WireNode {
  name?: string;
  type?: string;
  children?: WireNode[];
}

interface WireFile {
  name?: string;
  lastModified?: string;
  editorType?: string;
  document?: WireNode;
}

interface WireComment {
  id?: string;
  message?: string;
  created_at?: string;
  user?: { handle?: string };
  resolved_at?: string | null;
}

/**
 * A Figma file key, as it appears in a URL the user already has open.
 *
 * Validated by shape rather than by length, because Figma has changed the
 * length at least once and a build that pinned it would start refusing valid
 * keys. No slashes, so a key cannot carry a path segment into the URL this
 * builds.
 */
const fileKeyPattern = /^[A-Za-z0-9]{10,64}$/;

const fileInput = z.object({
  fileKey: z
    .string()
    .regex(fileKeyPattern)
    .describe('The file key from a Figma URL: figma.com/design/<fileKey>/…'),
});

const commentsInput = fileInput;

export class FigmaConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  private readonly runtime: ConnectorRuntime;

  constructor(deps: FigmaConnectorDeps) {
    this.descriptor = deps.descriptor;
    this.runtime = new ConnectorRuntime({
      ...deps,
      classifyStatus: classifyFigmaStatus,
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
    return [this.readFileTool(), this.readCommentsTool()] as AgentTool[];
  }

  private readFileTool(): AgentTool<typeof fileInput> {
    return {
      name: 'figma.read_file',
      version: '1.0.0',
      description:
        'Read the structure of a Figma file: its name, its pages and the names of the layers ' +
        'on them. Returns no image and no design content.',
      inputSchema: fileInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      // A connector call reaches an API over the network, not a page in a
      // tab. Its authorization is the connector's own credential and the
      // egress gate; no browser site governs it.
      siteAuthorization: 'none',
      sideEffects: ['Asks Figma for one file’s structure.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Read the structure of Figma file ${input.fileKey}.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, this.apiBase(), {
            purpose: 'read_file',
          }),
          // The file key is the only task-derived value in the request, and it
          // is an identifier the user pasted rather than content.
          carrier: { writesValue: false },
          payload: input.fileKey,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        // `depth=2` keeps this to the pages and their top-level layers. The
        // whole document tree of a real design file is enormous and would be
        // truncated into uselessness anyway; asking for less is cheaper for
        // the user's account as well as for the context window.
        const url = `${this.apiBase()}/v1/files/${input.fileKey}?depth=2`;
        const response = await this.runtime.call('read_file', context.taskId, {
          url,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);

        const file = (await response.json()) as WireFile;
        const pages = (file.document?.children ?? []).slice(0, MAX_NODES).map((page) => ({
          name: truncate(page.name ?? '', 120),
          type: page.type,
          layers: (page.children ?? []).slice(0, MAX_NODES).map((layer) => ({
            name: truncate(layer.name ?? '', 120),
            type: layer.type,
          })),
        }));

        // Everything below is written by whoever made the file. It is
        // truncated, labelled and wrapped; it never becomes an instruction.
        const document = JSON.stringify({
          name: truncate(file.name ?? '', 200),
          lastModified: file.lastModified,
          editorType: file.editorType,
          pages,
        });

        context.recordEvidence(
          {
            id: newEvidenceId(),
            type: 'API_RESPONSE',
            taskId: context.taskId,
            toolCallId: context.toolCallId,
            sourceTool: 'figma.read_file',
            createdAt: Date.now(),
            sensitivity: 'internal',
            trust: 'untrusted_external_content',
            origin: this.descriptor.site,
            label: `Figma file ${input.fileKey}`,
          },
          { content: document, encoding: 'utf8', mimeType: 'application/json' },
        );

        return {
          success: true,
          data: {
            pageCount: pages.length,
            file: untrustedFromConnector(document, this.descriptor.site, 'read_file'),
          },
          taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
        };
      },
    };
  }

  private readCommentsTool(): AgentTool<typeof commentsInput> {
    return {
      name: 'figma.read_comments',
      version: '1.0.0',
      description: 'Read the comments on a Figma file.',
      inputSchema: commentsInput,
      risk: 'R1',
      executionMode: 'requires_connector',
      siteAuthorization: 'none',
      sideEffects: ['Asks Figma for one file’s comments.'],
      timeoutMs: 30_000,
      idempotent: true,
      classify: (input) => ({
        summary: `Read the comments on Figma file ${input.fileKey}.`,
        egress: {
          destination: connectorDestination(this.descriptor.id, this.apiBase(), {
            purpose: 'read_comments',
          }),
          carrier: { writesValue: false },
          payload: input.fileKey,
        },
      }),

      execute: async (input, context): Promise<ToolExecutionResult> => {
        const url = `${this.apiBase()}/v1/files/${input.fileKey}/comments`;
        const response = await this.runtime.call('read_comments', context.taskId, {
          url,
          method: 'GET',
        });
        if (!response.ok) throw await this.runtime.httpError(response);

        const body = (await response.json()) as { comments?: WireComment[] };
        const comments = (body.comments ?? []).slice(0, MAX_COMMENTS).map((comment) => ({
          author: truncate(comment.user?.handle ?? '', 64),
          createdAt: comment.created_at,
          resolved: comment.resolved_at !== null && comment.resolved_at !== undefined,
          message: truncate(comment.message ?? '', MAX_COMMENT_CHARS),
        }));

        const document = JSON.stringify({ returned: comments.length, comments });

        context.recordEvidence(
          {
            id: newEvidenceId(),
            type: 'API_RESPONSE',
            taskId: context.taskId,
            toolCallId: context.toolCallId,
            sourceTool: 'figma.read_comments',
            createdAt: Date.now(),
            sensitivity: 'internal',
            trust: 'untrusted_external_content',
            origin: this.descriptor.site,
            label: `Figma comments on ${input.fileKey}`,
          },
          { content: document, encoding: 'utf8', mimeType: 'application/json' },
        );

        return {
          success: true,
          data: {
            returned: comments.length,
            comments: untrustedFromConnector(document, this.descriptor.site, 'read_comments'),
          },
          taint: [{ sourceType: 'connector', site: this.descriptor.site, sensitivity: 'internal' }],
        };
      },
    };
  }
}

/**
 * The statuses the shared mapping would read wrongly for Figma.
 *
 * **403.** Figma uses it for a token whose scopes do not cover the endpoint
 * *and* for a file the account cannot see. The shared message — "your
 * authorization does not permit that" — is right for the first and misleading
 * for the second, and a user who has pasted a file key from somebody else's
 * URL hits the second. Naming both is the honest version.
 *
 * **404.** A file key that does not exist and one the account cannot see are
 * the same answer here, so the message claims neither.
 *
 * Everything else falls through.
 */
function classifyFigmaStatus(
  response: Response,
  displayName: string,
  detail: string,
): ToolError | undefined {
  if (response.status === 403) {
    return new ToolError('PERMISSION_DENIED', `${displayName} refused this operation.`, {
      userMessage:
        'Figma refused that. Either this token does not have the scope the request needs, or ' +
        'the file is not shared with the connected account.',
      technicalDetails: detail,
      retryable: false,
    });
  }
  if (response.status === 404) {
    return new ToolError('CONNECTOR_ERROR', 'Not found.', {
      userMessage: 'That Figma file was not found, or is not visible to this account.',
      retryable: false,
    });
  }
  return undefined;
}
