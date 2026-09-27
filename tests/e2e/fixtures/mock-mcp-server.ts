/**
 * A local MCP server, over real sockets.
 *
 * Speaks enough of Streamable HTTP to be discovered and called: `initialize`,
 * `tools/list` and `tools/call`, as JSON-RPC 2.0 over POST. It exists so the
 * registration path can be driven in a real browser, where the things that
 * differ from Node — how `redirect: 'manual'` behaves, what the egress gate
 * sees, whether the worker's startup pass actually runs — are facts rather than
 * assumptions.
 *
 * It is deliberately permissive about the protocol and strict about recording
 * what it was sent, so a test can prove what left the browser. The extension's
 * own protocol checks are asserted exhaustively in the unit suites.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface McpCall {
  readonly method: string;
  readonly params: unknown;
}

export interface MockMcpServer {
  readonly baseUrl: string;
  readonly calls: McpCall[];
  /** Tools `tools/list` will offer. Assignable, so a test can change them. */
  tools: readonly unknown[];
  /** What `tools/call` answers with. */
  result: unknown;
  /** Set to refuse the handshake, for the failing-server case. */
  refuseHandshake: boolean;
  /** Set to announce a version the extension does not speak. */
  protocolVersion: string;
  close(): Promise<void>;
}

export async function startMockMcpServer(): Promise<MockMcpServer> {
  const calls: McpCall[] = [];
  const state = {
    tools: [
      {
        name: 'search',
        description: 'Looks something up.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ] as readonly unknown[],
    result: { content: [{ type: 'text', text: 'the answer' }] } as unknown,
    refuseHandshake: false,
    protocolVersion: '2025-06-18',
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let request: { id?: unknown; method?: unknown; params?: unknown } = {};
      try {
        request = JSON.parse(body) as typeof request;
      } catch {
        /* recorded below as an unknown method */
      }
      const method = typeof request.method === 'string' ? request.method : '(unparsed)';
      calls.push({ method, params: request.params });

      const send = (payload: Record<string, unknown>): void => {
        const text = JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, ...payload });
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
        });
        res.end(text);
      };

      if (method === 'initialize') {
        if (state.refuseHandshake) {
          send({ error: { code: -32000, message: 'not accepting connections' } });
          return;
        }
        send({
          result: {
            protocolVersion: state.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'Mock MCP', version: '1' },
          },
        });
        return;
      }
      if (method === 'tools/list') {
        send({ result: { tools: state.tools } });
        return;
      }
      if (method === 'tools/call') {
        send({ result: state.result });
        return;
      }
      send({ error: { code: -32601, message: `no such method: ${method}` } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/mcp`,
    calls,
    get tools() {
      return state.tools;
    },
    set tools(next: readonly unknown[]) {
      state.tools = next;
    },
    get result() {
      return state.result;
    },
    set result(next: unknown) {
      state.result = next;
    },
    get refuseHandshake() {
      return state.refuseHandshake;
    },
    set refuseHandshake(next: boolean) {
      state.refuseHandshake = next;
    },
    get protocolVersion() {
      return state.protocolVersion;
    },
    set protocolVersion(next: string) {
      state.protocolVersion = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
