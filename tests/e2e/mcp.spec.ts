/**
 * TEST-E2E-048 — MCP servers in real Chromium (P-026).
 *
 * REAL BROWSER + MOCK MCP SERVER. The server is a local Node process on
 * 127.0.0.1 speaking real JSON-RPC over HTTP. No production service is
 * contacted and no account is involved.
 *
 * "Server" is a server somebody else runs and the extension calls out to. This
 * extension is not an MCP server, so nothing here connects inward — there is no
 * such surface to test.
 *
 * What only a real browser can settle:
 *
 * **Whether the wiring runs at all.** The store, the transport, discovery, the
 * schema compiler, the tool factory and the registrar all have unit coverage,
 * and none of that proves the worker calls them, that the routes are reachable
 * from the panel, or that a registered tool appears in the set the model is
 * offered. Those are facts about the loaded extension.
 *
 * **What the policy engine does with an http server.** `mcp.add` and discovery
 * go through the egress gate; a tool *call* also goes through `evaluatePolicy`,
 * whose origin check refuses a plain-http destination. So a loopback server can
 * be added and discovered here and its tools cannot be run — which is the
 * production rule (https only) observed rather than asserted.
 */
import { expect, test } from './fixtures/extension';
import { startMockMcpServer, type MockMcpServer } from './fixtures/mock-mcp-server';

let server: MockMcpServer;

test.beforeEach(async () => {
  server = await startMockMcpServer();
});

test.afterEach(async () => {
  await server.close();
});

test('a server added from the panel has its tools registered', async ({ send }) => {
  const added = await send('mcp.add', {
    id: 'docs',
    displayName: 'Docs',
    url: server.baseUrl,
  });
  expect(added).toMatchObject({ added: true, registered: ['mcp__docs__search'] });

  // The handshake happened before the listing, in that order, against the real
  // socket.
  expect(server.calls.map((call) => call.method)).toEqual(['initialize', 'tools/list']);

  // And the tool is in the set the model is offered, at the risk this build
  // classified rather than anything the server said about it.
  const tools = await send('tools.list', {});
  const mcpTool = tools.tools.find((tool) => tool.name === 'mcp__docs__search');
  expect(mcpTool).toBeDefined();
  expect(mcpTool?.risk).toBe('R3');
});

test('the panel lists what a server contributed, and what it would not', async ({ send }) => {
  server.tools = [
    { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    // A schema outside the compilable subset. It must be named, not dropped:
    // the user's own MCP client may show this tool working.
    { name: 'complex', inputSchema: { type: 'object', properties: { a: { $ref: '#/b' } } } },
  ];
  await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });

  const listed = await send('mcp.list', {});
  expect(listed.servers).toHaveLength(1);
  const only = listed.servers[0];
  expect(only?.outcome?.registered).toEqual(['mcp__docs__search']);
  expect(only?.outcome?.refused[0]?.name).toBe('mcp__docs__complex');
  expect(only?.outcome?.refused[0]?.reason).toContain('$ref');
});

test('a refused address never reaches the network', async ({ send }) => {
  const result = await send('mcp.add', {
    id: 'docs',
    displayName: 'Docs',
    url: 'ftp://mcp.example.test/rpc',
  });
  expect(result).toMatchObject({ added: false });
  expect(server.calls).toEqual([]);
});

test('a duplicate id is refused rather than replacing the first server', async ({ send }) => {
  await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });
  const second = await send('mcp.add', {
    id: 'docs',
    displayName: 'Something else',
    url: server.baseUrl,
  });
  expect(second).toMatchObject({ added: false, reason: 'ID_TAKEN' });
  const listed = await send('mcp.list', {});
  expect(listed.servers).toHaveLength(1);
  expect(listed.servers[0]?.displayName).toBe('Docs');
});

test('a server that refuses the handshake is named, and costs the others nothing', async ({
  send,
}) => {
  const other = await startMockMcpServer();
  try {
    server.refuseHandshake = true;
    await send('mcp.add', { id: 'broken', displayName: 'Broken', url: server.baseUrl });
    await send('mcp.add', { id: 'working', displayName: 'Working', url: other.baseUrl });

    const listed = await send('mcp.list', {});
    const broken = listed.servers.find((entry) => entry.id === 'broken');
    const working = listed.servers.find((entry) => entry.id === 'working');
    expect(broken?.outcome?.failure).toBeTruthy();
    expect(broken?.outcome?.registered).toEqual([]);
    expect(working?.outcome?.registered).toEqual(['mcp__working__search']);

    const tools = await send('tools.list', {});
    expect(tools.tools.some((tool) => tool.name === 'mcp__working__search')).toBe(true);
  } finally {
    await other.close();
  }
});

test('removing a server removes its tools', async ({ send }) => {
  await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });
  expect((await send('tools.list', {})).tools.some((t) => t.name === 'mcp__docs__search')).toBe(
    true,
  );

  const removed = await send('mcp.remove', { id: 'docs' });
  expect(removed).toMatchObject({ removed: true, unregistered: ['mcp__docs__search'] });
  expect((await send('tools.list', {})).tools.some((t) => t.name === 'mcp__docs__search')).toBe(
    false,
  );
  expect((await send('mcp.list', {})).servers).toEqual([]);
});

test('asking again picks up a tool the server has stopped offering', async ({ send }) => {
  server.tools = [
    { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    {
      name: 'delete_everything',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ];
  await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });
  expect(
    (await send('tools.list', {})).tools.some((t) => t.name === 'mcp__docs__delete_everything'),
  ).toBe(true);

  server.tools = [
    { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ];
  await send('mcp.refresh', {});
  expect(
    (await send('tools.list', {})).tools.some((t) => t.name === 'mcp__docs__delete_everything'),
  ).toBe(false);
  expect((await send('tools.list', {})).tools.some((t) => t.name === 'mcp__docs__search')).toBe(
    true,
  );
});

test('a server offering resources gets the two resource tools, and no others do', async ({
  send,
}) => {
  // The two tools exist only when there is something to read: a resources.list
  // that always answers empty would be a tool in the model's context earning
  // nothing.
  const bare = await startMockMcpServer();
  try {
    server.resources = [{ uri: 'docs://guide', name: 'Guide', mimeType: 'text/markdown' }];
    const added = await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });
    expect(added).toMatchObject({ added: true, resourceCount: 1 });
    expect(server.calls.map((call) => call.method)).toEqual([
      'initialize',
      'tools/list',
      'resources/list',
    ]);

    await send('mcp.add', { id: 'bare', displayName: 'Bare', url: bare.baseUrl });
    // The server that declared no resources was never asked for any.
    expect(bare.calls.map((call) => call.method)).toEqual(['initialize', 'tools/list']);

    const names = (await send('tools.list', {})).tools.map((tool) => tool.name);
    expect(names).toContain('mcp__docs__resources.list');
    expect(names).toContain('mcp__docs__resources.read');
    expect(names).not.toContain('mcp__bare__resources.list');
  } finally {
    await bare.close();
  }
});

test('a resource the server would not describe properly is left out and named', async ({
  send,
}) => {
  server.resources = [
    { uri: 'docs://good', name: 'Good' },
    // A URI with a control character in it: it would break a log line and a
    // prompt envelope alike.
    { uri: 'docs://bad\u0001', name: 'Bad' },
  ];
  await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });
  const listed = await send('mcp.list', {});
  expect(listed.servers[0]?.outcome?.resourceCount).toBe(1);
  expect(listed.servers[0]?.outcome?.refusedResources[0]?.reason).toContain('control characters');
});

test('the resource tools appear at R3, like every other MCP tool', async ({ send }) => {
  server.resources = [{ uri: 'docs://guide', name: 'Guide' }];
  await send('mcp.add', { id: 'docs', displayName: 'Docs', url: server.baseUrl });
  const tools = (await send('tools.list', {})).tools.filter((tool) =>
    tool.name.startsWith('mcp__docs__resources.'),
  );
  expect(tools).toHaveLength(2);
  // Including the listing. A read-only exception is the shape the withdrawn
  // per-server ceiling had.
  for (const tool of tools) expect(tool.risk, tool.name).toBe('R3');
});

test('a server on another protocol revision is declined', async ({ send }) => {
  server.protocolVersion = '1999-01-01';
  const added = await send('mcp.add', {
    id: 'docs',
    displayName: 'Docs',
    url: server.baseUrl,
  });
  // The server was stored — the user named it — and it contributed nothing.
  expect(added).toMatchObject({ added: true, registered: [] });
  const listed = await send('mcp.list', {});
  expect(listed.servers[0]?.outcome?.failure).toContain('version of MCP');
});
