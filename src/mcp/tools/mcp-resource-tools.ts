/**
 * MCP resources as tools (§5.11 `resource discovery where applicable`).
 *
 * A resource is data a server offers rather than an action it performs, and in
 * the protocol it is meant to be attached as context. This architecture has one
 * way for a model to reach anything — a tool — so resources arrive as two tools
 * per server: one that lists what is available, one that reads a named entry.
 * Doing it any other way would mean a second path into the model's context that
 * the policy engine does not see, which is the thing §35 forbids.
 *
 * ## Both are R3, including the listing
 *
 * `MCP_TOOL_RISK` applies unchanged, and the listing is not treated as cheaper
 * than the read. The reason is the same one that makes every MCP call R3: the
 * call itself sends task data to a third party. A listing carries less, and
 * "less" is not "none" — the server learns that this browser is asking, when,
 * and inside which task. There is deliberately no read-only exception here,
 * because a read-only exception is exactly the shape the withdrawn per-server
 * ceiling had.
 *
 * ## What a resource's content is
 *
 * Page-class, untrusted, `NEVER_PERSISTED`, and it taints the task. It is the
 * same treatment page text gets and for the same reason: a resource is the
 * injection channel `PLUGIN_TRUST_MODEL.md` names when it says "MCP introduces
 * an injection channel". A resource **URI** never becomes an audit field — it is
 * page-derived text, and a cross-task trail holding one is the browsing-history
 * problem `taintKind` exists to avoid.
 */

import { z } from 'zod';
import { ToolError } from '@/types/result';
import type {
  AgentTool,
  CallClassification,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@/tools/core/tool-types';
import { mcpDestination } from '@/security/egress/destination';
import {
  MCP_TOOL_RISK,
  mcpToolName,
  type AdmittedResource,
  type McpServerDescriptor,
} from '@/mcp/core/mcp-model';
import { MCP_TAINT_SOURCE, type McpSecurityContextFor } from '@/mcp/tools/mcp-tool';
import type { McpTransport } from '@/mcp/transport/mcp-transport';

/** How much of a resource's text is kept. The server chooses the length. */
export const MAX_RESOURCE_CHARS = 40_000;

const TOOL_TIMEOUT_MS = 60_000;

/** The names the two tools take, inside the server's own namespace. */
export const RESOURCE_LIST_TOOL = 'resources.list';
export const RESOURCE_READ_TOOL = 'resources.read';

export interface McpResourceToolOptions {
  readonly server: McpServerDescriptor;
  readonly transport: McpTransport;
  /**
   * What the server offered at registration.
   *
   * Held so `resources.list` answers from the reading already taken rather than
   * asking again: the listing the user was shown in the panel and the listing
   * the model is given are then the same one, and a server cannot offer the
   * model something it did not offer the person.
   */
  readonly resources: readonly AdmittedResource[];
  readonly securityContextFor: McpSecurityContextFor;
}

function flattenContents(contents: unknown): string {
  if (!Array.isArray(contents)) return '';
  const parts: string[] = [];
  for (const entry of contents) {
    if (typeof entry !== 'object' || entry === null) continue;
    const part = entry as Record<string, unknown>;
    if (typeof part.text === 'string') {
      parts.push(part.text);
      continue;
    }
    // `blob` is base64 by protocol. Named rather than decoded: nothing here
    // would do anything with binary a server chose, and decoding it would be
    // inventing a capability.
    if (typeof part.blob === 'string') {
      parts.push('[binary resource omitted]');
    }
  }
  return parts.join('\n');
}

const taintOf = (server: McpServerDescriptor) => [
  {
    sourceType: MCP_TAINT_SOURCE,
    site: new URL(server.url).hostname,
    sensitivity: 'internal' as const,
  },
];

/**
 * The listing tool.
 *
 * It makes no request: it reports the admitted set captured at registration.
 * That is why it still declares an egress of nothing — a tool that transfers
 * nothing must say so explicitly, because an omitted declaration would read as
 * "no egress" by accident rather than by assertion.
 */
function createListTool(options: McpResourceToolOptions): AgentTool {
  const { server } = options;
  const schema = z.object({}).strict();
  return {
    name: mcpToolName(server.id, RESOURCE_LIST_TOOL),
    version: '1',
    description: `Lists the resources ${server.displayName} offers.`,
    inputSchema: schema,
    risk: MCP_TOOL_RISK,
    executionMode: 'immediate',
    siteAuthorization: 'destination',
    sideEffects: [`Reveals which resources ${server.displayName} offered.`],
    timeoutMs: TOOL_TIMEOUT_MS,
    // Answering from a captured listing genuinely is repeatable.
    idempotent: true,
    classify(): CallClassification {
      return {
        risk: MCP_TOOL_RISK,
        targetUrl: server.url,
        summary: `List the resources on ${server.displayName}`,
      };
    },
    execute(): Promise<ToolExecutionResult> {
      return Promise.resolve({
        success: true,
        data: {
          resources: options.resources.map((resource) => ({
            uri: resource.uri,
            label: resource.label,
            ...(resource.description === undefined ? {} : { description: resource.description }),
            ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
          })),
        },
        // The labels and descriptions were authored by the server, so reading
        // them is reading third-party content even though no request was made.
        taint: taintOf(server),
      });
    },
  };
}

/**
 * The read tool.
 *
 * The URI must be one the server offered. That is the security property worth
 * naming: without it the model could name any string, and while nothing here
 * would fetch it, the server would be asked to — which is a request the user
 * never saw offered and which this build would have originated. Restricting it
 * to the admitted set means the model can only ask for what the person could
 * also see in the panel.
 */
function createReadTool(options: McpResourceToolOptions): AgentTool {
  const { server, transport } = options;
  const known = new Map(options.resources.map((resource) => [resource.uri, resource]));
  const schema = z
    .object({
      uri: z.string().min(1).describe('One of the URIs this server offered.'),
    })
    .strict();

  return {
    name: mcpToolName(server.id, RESOURCE_READ_TOOL),
    version: '1',
    description: `Reads one of the resources ${server.displayName} offers.`,
    inputSchema: schema,
    risk: MCP_TOOL_RISK,
    executionMode: 'requires_connector',
    siteAuthorization: 'destination',
    sideEffects: [`Asks ${server.displayName} for one of its resources.`],
    timeoutMs: TOOL_TIMEOUT_MS,
    // A read has no side effect here, and the far side is somebody else's.
    idempotent: false,
    classify(input: z.infer<typeof schema>): CallClassification {
      return {
        risk: MCP_TOOL_RISK,
        targetUrl: server.url,
        writeDestination: server.url,
        writePayload: input,
        egress: {
          destination: mcpDestination(server.id, server.url, { method: 'resources/read' }),
          payload: input,
        },
        // The label rather than the URI: a URI is page-derived text and the
        // summary is shown in a prompt and recorded with the decision.
        summary: `Read "${known.get(input.uri)?.label ?? 'a resource'}" from ${server.displayName}`,
      };
    },
    async execute(
      input: z.infer<typeof schema>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      if (!known.has(input.uri)) {
        // Refused before any request. See the doc comment: the alternative is
        // this build originating a fetch nobody offered.
        throw new ToolError(
          'INVALID_ARGUMENT',
          `${server.id} did not offer a resource with that URI.`,
          {
            userMessage: `${server.displayName} did not offer that resource, so it was not requested.`,
            retryable: false,
          },
        );
      }

      const security = await options.securityContextFor(context.taskId);
      const outcome = await transport.call(
        'resources/read',
        { uri: input.uri },
        { ...security, method: 'resources/read' },
      );
      if (!outcome.ok) {
        throw new ToolError('MCP_ERROR', `${server.id} refused a resource read.`, {
          userMessage: `${server.displayName} could not provide that resource: ${outcome.message}`,
          retryable: false,
        });
      }

      const result =
        typeof outcome.result === 'object' && outcome.result !== null
          ? (outcome.result as Record<string, unknown>)
          : {};
      const text = flattenContents(result.contents).slice(0, MAX_RESOURCE_CHARS);

      return {
        success: true,
        data: { text },
        taint: taintOf(server),
      };
    },
  };
}

/**
 * Both tools, or neither.
 *
 * A server with no admitted resources gets neither: a `resources.list` that
 * always answers empty is a tool in the model's context earning nothing, and a
 * `resources.read` with nothing to read could only ever refuse.
 */
export function createMcpResourceTools(options: McpResourceToolOptions): readonly AgentTool[] {
  if (options.resources.length === 0) return [];
  return [createListTool(options), createReadTool(options)];
}
