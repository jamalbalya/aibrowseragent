/**
 * TEST-MCPINTEROP-001 — this client against an MCP server it did not write.
 *
 * Every other MCP suite in this repository drives a mock written alongside the
 * client, which cannot falsify a misreading of the specification: if the client
 * and the mock share a wrong assumption, both agree and both are wrong. That is
 * why P-026-C3 stood as EXTERNAL_REQUIRED for as long as it did.
 *
 * It was not external. `@modelcontextprotocol/server-everything` is the MCP
 * project's own reference server, it speaks Streamable HTTP over loopback, and it
 * needs no credential, no account and no third party — so the classification was
 * hiding work that was possible all along. This suite runs it and drives the real
 * transport, discovery, schema compiler and tool factory against it.
 *
 * Two defects it found immediately, both of which made the client unable to
 * complete a handshake with any conformant server that chose the other framing:
 *
 *  1. **SSE-framed responses were not parsed.** Streamable HTTP lets a server
 *     answer a POST with `application/json` or `text/event-stream`. The transport
 *     advertised both in `Accept` from its first version and ran `JSON.parse` on
 *     whatever came back, so an SSE body raised `NOT_MCP`. This server answers a
 *     successful `initialize` as SSE and a refused request as plain JSON, so both
 *     paths are exercised here.
 *  2. **The session id was never echoed.** The server issues `mcp-session-id` on
 *     `initialize` and answers every later request with `Bad Request: Server not
 *     initialized` without it, so discovery failed on its second call.
 *
 * What this suite is not: a claim about a *remote* MCP server. P-026-C2 asks for
 * one reached over the network at an origin somebody else operates, and running a
 * package on loopback is not that. It is local MCP, which is the clause it is
 * cited for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createMcpTransport } from '@/mcp/transport/mcp-transport';
import { discover } from '@/mcp/core/mcp-discovery';
import { compileToolSchema } from '@/mcp/core/mcp-schema';
import { createMcpTool } from '@/mcp/tools/mcp-tool';
import { MCP_TAINT_SOURCE } from '@/mcp/tools/mcp-tool';
import { MCP_TOOL_RISK } from '@/mcp/core/mcp-model';
import { ConsentStore } from '@/security/egress/consent';
import { freshTaint } from '@/security/taint/taint-state';
import type { McpServerDescriptor } from '@/mcp/core/mcp-model';
import type { McpTransport } from '@/mcp/transport/mcp-transport';

/** A port unlikely to collide with anything else the suite runs. */
const PORT = 31_411;

const SERVER: McpServerDescriptor = {
  id: 'reference',
  displayName: 'Everything Reference Server',
  url: `http://127.0.0.1:${PORT}/mcp`,
};

const CONTEXT = {
  taskId: 'task_interop',
  taintState: freshTaint(),
  taintSalt: 'ab'.repeat(32),
  taintSignature: 'interop',
};

let child: ChildProcess | undefined;

/** A transport per test, because a session belongs to one conversation. */
function transport(): McpTransport {
  return createMcpTransport({
    server: SERVER,
    consent: new ConsentStore(),
    // The real one. Nothing here is stubbed: the point is the wire.
    fetchImpl: globalThis.fetch.bind(globalThis),
  });
}

async function reachable(): Promise<boolean> {
  try {
    // A bare GET is not a valid MCP request and the server may refuse it; any
    // answer at all means the socket is up, which is what is being waited for.
    await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@modelcontextprotocol/server-everything/dist/index.js');
  child = spawn(process.execPath, [entry, 'streamableHttp'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await reachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`The reference MCP server did not start on port ${PORT}.`);
}, 30_000);

afterAll(() => {
  child?.kill('SIGKILL');
});

describe('TEST-MCPINTEROP-001 — a server this client did not write', () => {
  it('01 — completes the handshake, at the revision this build declares', async () => {
    const found = await discover(transport(), SERVER, CONTEXT as never);
    // Not "some version it offered": the client declines rather than negotiates,
    // so agreement here is agreement on the revision this build implements.
    expect(found.handshake.protocolVersion).toBe('2025-06-18');
    expect(found.handshake.declaresTools).toBe(true);
    expect(found.handshake.declaresResources).toBe(true);
  }, 20_000);

  it('02 — reads an SSE-framed response, which is how this server answers', async () => {
    // The first of the two defects, as a regression test. Before the fix this
    // threw `NOT_MCP` — "The server did not answer with JSON" — on a body that
    // was perfectly valid MCP.
    const outcome = await transport().call(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'aba-interop', version: '0.1.0' },
      },
      CONTEXT as never,
    );
    expect(outcome.ok).toBe(true);
  }, 20_000);

  it('03 — echoes the session id, without which every later call is refused', async () => {
    // The second defect. One transport makes both calls, so the session the
    // server issued on the first is the one carried into the second; a fresh
    // transport per call would be refused, which is what discovery used to do.
    const shared = transport();
    const first = await shared.call(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'aba-interop', version: '0.1.0' },
      },
      CONTEXT as never,
    );
    expect(first.ok).toBe(true);

    const second = await shared.call('tools/list', {}, CONTEXT as never);
    expect(second.ok, JSON.stringify(second)).toBe(true);
  }, 20_000);

  it('04 — a request with no session is refused as a transport failure, not a result', async () => {
    // The negative control for 03, and it measures a deliberate decision rather
    // than the one first assumed here. This server refuses with HTTP 400 *and* a
    // JSON-RPC error in the body. The transport treats any non-2xx as a transport
    // failure and does not read the body, because a server-authored message would
    // reach a failure string and from there the model's context — so the caller
    // learns the status and nothing the server wrote.
    //
    // The cost is real and is accepted: a caller cannot tell "the session lapsed,
    // start again" from "this server is broken". It is tolerable because tools are
    // a fresh reading on every registration and every registration begins with
    // `initialize`, so the recovery is the same either way.
    await expect(transport().call('tools/list', {}, CONTEXT as never)).rejects.toThrow(/400/);

    // And what it must not do: repeat what the server said. "Server not
    // initialized" is in the body this server sent, and it does not appear.
    const outcome = await transport()
      .call('tools/list', {}, CONTEXT as never)
      .then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
    expect(outcome).not.toContain('not initialized');
  }, 20_000);

  it('05 — admits its tools under this build’s namespace', async () => {
    const found = await discover(transport(), SERVER, CONTEXT as never);
    expect(found.admitted.length).toBeGreaterThan(5);
    for (const admitted of found.admitted) {
      expect(admitted.name.startsWith('mcp__reference__'), admitted.name).toBe(true);
    }
    expect(found.admitted.map((tool) => tool.name)).toContain('mcp__reference__echo');
  }, 20_000);

  it('06 — compiles every schema this server declares, refusing none', async () => {
    // The claim worth measuring. The schema compiler was written against
    // hand-made fixtures; these are draft-07 schemas from somebody else, with
    // `$schema`, `enum`, `default`, `minimum` and `maximum` in them.
    const found = await discover(transport(), SERVER, CONTEXT as never);
    const refused: string[] = [];
    for (const admitted of found.admitted) {
      const outcome = compileToolSchema(admitted.source.inputSchema);
      if (!outcome.ok) refused.push(`${admitted.name}: ${outcome.reason}`);
    }
    expect(refused).toEqual([]);
  }, 20_000);

  it('07 — calls a real tool and gets its real answer', async () => {
    const shared = transport();
    const found = await discover(shared, SERVER, CONTEXT as never);
    const echo = found.admitted.find((tool) => tool.name === 'mcp__reference__echo');
    expect(echo).toBeDefined();

    const source = echo!.source;
    const made = createMcpTool({
      server: SERVER,
      transport: shared,
      remoteName: source.name,
      inputSchema: source.inputSchema,
      securityContextFor: () => CONTEXT as never,
    });
    expect(made.ok, made.ok ? '' : made.reason).toBe(true);
    if (!made.ok) throw new Error('unreachable');

    const result = await made.tool.execute({ message: 'interop' }, CONTEXT as never);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).toContain('interop');

    // The trust properties hold against a real server, not only a mock: R3, and
    // the result is taint from the server rather than trusted content.
    expect(made.tool.risk).toBe(MCP_TOOL_RISK);
    expect(result.taint?.[0]?.sourceType).toBe(MCP_TAINT_SOURCE);
    expect(result.taint?.[0]?.site).toBe('127.0.0.1');
  }, 20_000);

  it('08 — lists the resources it offers', async () => {
    const found = await discover(transport(), SERVER, CONTEXT as never);
    expect(found.resources?.length ?? 0).toBeGreaterThan(0);
  }, 20_000);
});
