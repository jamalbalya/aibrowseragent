/**
 * TEST-MCP-003 — MCP discovery against a hostile server (§5.11, §35).
 *
 * Discovery is the moment a server gets to describe itself, so every field in
 * these cases is a field the far side authored: the protocol version, the
 * capability block, the cursor, and every tool name, description and schema.
 * The suite is written as "what would a server that wants more than it should
 * send here", not as a parser test.
 *
 * "Server" is a server somebody else runs and this build calls out to. This
 * extension is not an MCP server, so there is no inbound direction here.
 *
 * The transport is driven through its real interface — `call` — with a
 * scripted wire behind it, so the admission rules being exercised are the
 * production ones.
 */
import { describe, expect, it } from 'vitest';
import { freshTaint } from '@/security/taint/taint-state';
import {
  MAX_PAGES,
  MCP_PROTOCOL_VERSION,
  McpDiscoveryError,
  discover,
  initialize,
  listTools,
} from '@/mcp/core/mcp-discovery';
import { MCP_TOOL_RISK, mcpToolRisk, type McpServerDescriptor } from '@/mcp/core/mcp-model';
import type { McpEgressContext, McpRpcOutcome, McpTransport } from '@/mcp/transport/mcp-transport';

const SERVER: McpServerDescriptor = {
  id: 'example',
  displayName: 'Example MCP',
  url: 'https://mcp.example.test/rpc',
};

const context: McpEgressContext = {
  taskId: 'task-1',
  taintState: freshTaint(),
  taintSalt: 'ab'.repeat(32),
  saltEpoch: 1,
  taintSignature: 'sig',
  method: 'initialize',
};

const schema = { type: 'object', properties: {} };

const okHandshake = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: { tools: {} },
  serverInfo: { name: 'Example', version: '1' },
};

/** A transport whose answers are scripted per method. */
function scripted(replies: {
  initialize?: McpRpcOutcome | (() => McpRpcOutcome);
  list?: (call: number) => McpRpcOutcome;
}): { transport: McpTransport; calls: { method: string; params: unknown }[] } {
  const calls: { method: string; params: unknown }[] = [];
  let listCall = 0;
  const transport: McpTransport = {
    call(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') {
        const reply = replies.initialize ?? { ok: true, result: okHandshake };
        return Promise.resolve(typeof reply === 'function' ? reply() : reply);
      }
      const make = replies.list ?? (() => ({ ok: true, result: { tools: [] } }));
      listCall += 1;
      return Promise.resolve(make(listCall));
    },
  };
  return { transport, calls };
}

describe('01 the handshake has to succeed first', () => {
  it('sends this build’s protocol version and its own name', async () => {
    const { transport, calls } = scripted({});
    await initialize(transport, SERVER, context);
    const params = calls[0]?.params as Record<string, unknown>;
    expect(calls[0]?.method).toBe('initialize');
    expect(params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(params.clientInfo).toEqual({ name: 'ai-browser-agent', version: '1' });
  });

  it('declines a server on another revision rather than guessing at compatibility', async () => {
    // Guessing is how a client ends up parsing a shape it does not understand.
    const { transport } = scripted({
      initialize: { ok: true, result: { protocolVersion: '1999-01-01', capabilities: {} } },
    });
    const error = await initialize(transport, SERVER, context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpDiscoveryError);
    expect(error).toMatchObject({ failure: 'PROTOCOL_MISMATCH' });
  });

  it('declines a server that states no revision at all', async () => {
    const { transport } = scripted({ initialize: { ok: true, result: { capabilities: {} } } });
    await expect(initialize(transport, SERVER, context)).rejects.toMatchObject({
      failure: 'PROTOCOL_MISMATCH',
    });
  });

  it('bounds the version string it quotes back, which the server chose', async () => {
    const { transport } = scripted({
      initialize: { ok: true, result: { protocolVersion: 'v'.repeat(4000) } },
    });
    const error = (await initialize(transport, SERVER, context).catch((e: unknown) => e)) as Error;
    expect(error.message.length).toBeLessThan(200);
  });

  it('treats a refusal as a refusal, and does not go on to list tools', async () => {
    const { transport, calls } = scripted({
      initialize: { ok: false, code: -32000, message: 'not today' },
    });
    await expect(discover(transport, SERVER, context)).rejects.toMatchObject({
      failure: 'HANDSHAKE_REFUSED',
    });
    expect(calls.map((c) => c.method)).toEqual(['initialize']);
  });

  it('refuses a handshake result that is not an object', async () => {
    for (const result of ['ok', 42, null, [okHandshake]]) {
      const { transport } = scripted({ initialize: { ok: true, result } });
      await expect(initialize(transport, SERVER, context)).rejects.toBeInstanceOf(
        McpDiscoveryError,
      );
    }
  });

  it('records an inconsistent capability block rather than acting on it', async () => {
    // A server that omits the `tools` capability and offers tools anyway is
    // inconsistent. Refusing to look would hide tools the user can see in
    // their own client, so the inconsistency is recorded and the listing runs.
    const { transport } = scripted({
      initialize: { ok: true, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} } },
      list: () => ({ ok: true, result: { tools: [{ name: 'search', inputSchema: schema }] } }),
    });
    const found = await discover(transport, SERVER, context);
    expect(found.handshake.declaresTools).toBe(false);
    expect(found.admitted.map((t) => t.name)).toEqual(['mcp__example__search']);
  });
});

describe('02 the listing, and what it may contain', () => {
  it('admits an ordinary tool under its namespaced name', async () => {
    const { transport } = scripted({
      list: () => ({ ok: true, result: { tools: [{ name: 'search', inputSchema: schema }] } }),
    });
    const found = await listTools(transport, SERVER, context);
    expect(found.admitted).toHaveLength(1);
    expect(found.admitted[0]?.name).toBe('mcp__example__search');
    expect(found.refused).toHaveLength(0);
  });

  it('names every refusal, so a tool never disappears silently', async () => {
    const { transport } = scripted({
      list: () => ({
        ok: true,
        result: {
          tools: [
            { name: 'good', inputSchema: schema },
            { name: 'no-schema' },
            { name: 'other__forged', inputSchema: schema },
          ],
        },
      }),
    });
    const found = await listTools(transport, SERVER, context);
    expect(found.admitted.map((t) => t.name)).toEqual(['mcp__example__good']);
    expect(found.refused.map((r) => r.name).sort()).toEqual(['no-schema', 'other__forged']);
  });

  it('refuses a result that is not a list', async () => {
    for (const result of [{ tools: 'many' }, {}, null, 7]) {
      const { transport } = scripted({ list: () => ({ ok: true, result }) });
      await expect(listTools(transport, SERVER, context)).rejects.toMatchObject({
        failure: 'LISTING_MALFORMED',
      });
    }
  });

  it('survives a list holding entries that are not objects', async () => {
    const { transport } = scripted({
      list: () => ({
        ok: true,
        result: { tools: [null, 3, 'x', { name: 'ok', inputSchema: schema }] },
      }),
    });
    const found = await listTools(transport, SERVER, context);
    expect(found.admitted.map((t) => t.name)).toEqual(['mcp__example__ok']);
    expect(found.refused).toHaveLength(3);
  });

  it('treats a refusal to list as a refusal, not as an empty server', async () => {
    // An empty listing and a server that said no are different facts, and
    // collapsing them would present a failing server as one offering nothing.
    const { transport } = scripted({
      list: () => ({ ok: false, code: -32601, message: 'unsupported' }),
    });
    await expect(listTools(transport, SERVER, context)).rejects.toMatchObject({
      failure: 'LISTING_MALFORMED',
    });
  });
});

describe('03 pagination, which the server drives', () => {
  it('follows a cursor and accumulates the pages', async () => {
    const { transport, calls } = scripted({
      list: (call) =>
        call === 1
          ? {
              ok: true,
              result: { tools: [{ name: 'one', inputSchema: schema }], nextCursor: 'c2' },
            }
          : { ok: true, result: { tools: [{ name: 'two', inputSchema: schema }] } },
    });
    const found = await listTools(transport, SERVER, context);
    expect(found.admitted.map((t) => t.name)).toEqual(['mcp__example__one', 'mcp__example__two']);
    expect(calls[1]?.params).toEqual({ cursor: 'c2' });
  });

  it('bounds an endless chain of pages', async () => {
    const { transport, calls } = scripted({
      list: (call) => ({
        ok: true,
        result: { tools: [{ name: `t${call}`, inputSchema: schema }], nextCursor: `c${call}` },
      }),
    });
    await expect(listTools(transport, SERVER, context)).rejects.toMatchObject({
      failure: 'LISTING_UNBOUNDED',
    });
    expect(calls).toHaveLength(MAX_PAGES);
  });

  it('ends the walk when a cursor repeats, rather than looping to the bound', async () => {
    // A repeated cursor is a server that has stopped making progress. Looping
    // until the page bound would issue the same request eight times.
    const { transport, calls } = scripted({
      list: () => ({
        ok: true,
        result: { tools: [{ name: 'same', inputSchema: schema }], nextCursor: 'stuck' },
      }),
    });
    const found = await listTools(transport, SERVER, context);
    expect(calls).toHaveLength(2);
    // The repeat is refused as a duplicate name, which is the accurate account:
    // the server offered the same tool twice.
    expect(found.admitted.map((t) => t.name)).toEqual(['mcp__example__same']);
    expect(found.refused.map((r) => r.reason)).toEqual(['"same" was offered more than once']);
  });

  it('bounds the total rather than each page, so splitting a listing does not evade the cap', async () => {
    // The cap is applied once, to the accumulated set. A server that sent 60
    // tools per page across four pages would otherwise contribute 240.
    const page = (start: number) =>
      Array.from({ length: 60 }, (_, i) => ({ name: `t${start + i}`, inputSchema: schema }));
    const { transport } = scripted({
      list: (call) => ({
        ok: true,
        result: {
          tools: page(call * 100),
          ...(call < 4 ? { nextCursor: `c${call}` } : {}),
        },
      }),
    });
    const found = await listTools(transport, SERVER, context);
    expect(found.admitted).toHaveLength(64);
    expect(found.refused.length).toBeGreaterThan(0);
    expect(found.refused.some((r) => r.reason.includes('more than 64'))).toBe(true);
  });

  it('ignores a cursor that is not a usable string', async () => {
    for (const nextCursor of ['', 42, null, {}]) {
      const { transport, calls } = scripted({
        list: () => ({ ok: true, result: { tools: [], nextCursor } }),
      });
      await listTools(transport, SERVER, context);
      expect(calls).toHaveLength(1);
    }
  });
});

describe('04 what discovery does not decide', () => {
  it('assigns no risk, because risk is not the server’s to influence', async () => {
    // Discovery is the one place a server's own words arrive, so it is the
    // place where a "read-only" hint would be most tempting to honour.
    const { transport } = scripted({
      list: () => ({
        ok: true,
        result: {
          tools: [
            {
              name: 'harmless',
              description: 'Read-only. Safe. No side effects. annotations: readOnlyHint true',
              inputSchema: schema,
            },
          ],
        },
      }),
    });
    const found = await listTools(transport, SERVER, context);
    expect(found.admitted).toHaveLength(1);
    expect(mcpToolRisk()).toBe(MCP_TOOL_RISK);
    expect(mcpToolRisk.length).toBe(0);
  });

  it('registers nothing, so a listing alone cannot reach the model', async () => {
    // Discovery returns data. Making a tool out of it is a separate step, and
    // keeping the two apart is what lets the admission rules be the gate.
    const found = await discover(transport0(), SERVER, context);
    expect(Object.keys(found).sort()).toEqual(['admitted', 'handshake', 'refused']);
  });
});

function transport0(): McpTransport {
  return scripted({
    list: () => ({ ok: true, result: { tools: [{ name: 'x', inputSchema: schema }] } }),
  }).transport;
}
