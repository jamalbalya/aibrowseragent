/**
 * TEST-MCP-006 — storing a server, and registering what it offers (P-026).
 *
 * This is the layer that made every layer beneath it reachable, so the cases are
 * about the properties that only exist once something calls them: that a failing
 * server does not cost the user the others, that removing a server removes its
 * tools with no residual grant to revoke, and that a re-registration drops a
 * tool the server has stopped offering.
 *
 * The registry is a real `ToolRegistry`. The seam is the transport.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { createHarness } from '../fixtures/policy-harness';
import {
  MAX_SERVERS,
  McpServerError,
  McpServerStore,
  isStorableServer,
} from '@/mcp/core/mcp-server-store';
import { registerMcpServers, unregisterServer } from '@/mcp/core/mcp-registrar';
import { MCP_PROTOCOL_VERSION } from '@/mcp/core/mcp-discovery';
import type { McpRpcOutcome, McpTransport } from '@/mcp/transport/mcp-transport';
import type { McpServerDescriptor } from '@/mcp/core/mcp-model';
import { freshTaint } from '@/security/taint/taint-state';
import {
  DATA_CLASSIFICATION,
  EXPORT_PORTABILITY,
  K1_PROTECTION,
} from '@/storage/data-classification';

const SCHEMA = { type: 'object', properties: { query: { type: 'string' } } };

const security = () =>
  Promise.resolve({
    taskId: 'task-1',
    taintState: freshTaint(),
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'sig',
  });

/** A server that answers the handshake and offers the tools it is given. */
function answering(
  tools: readonly unknown[],
  over: { handshakeFails?: boolean } = {},
): McpTransport {
  return {
    call(method): Promise<McpRpcOutcome> {
      if (method === 'initialize') {
        return Promise.resolve(
          over.handshakeFails === true
            ? { ok: false, code: -32000, message: 'no' }
            : {
                ok: true,
                result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} } },
              },
        );
      }
      if (method === 'tools/list') return Promise.resolve({ ok: true, result: { tools } });
      return Promise.resolve({ ok: true, result: { content: [] } });
    },
  };
}

let store: McpServerStore;

beforeEach(() => {
  store = new McpServerStore({ area: new SerializedStorageArea(new MemoryStorageArea()) });
});

describe('01 adding a server', () => {
  it('stores an id, a name and an address, and nothing else', async () => {
    const added = await store.add({
      id: 'docs',
      displayName: 'Docs',
      url: 'https://mcp.docs.test/rpc',
    });
    expect(Object.keys(added).sort()).toEqual(['displayName', 'id', 'url']);
    expect(await store.list()).toEqual([added]);
  });

  it('refuses a plaintext address, because the address is all that is known in advance', async () => {
    await expect(
      store.add({ id: 'docs', displayName: 'Docs', url: 'http://mcp.docs.test/rpc' }),
    ).rejects.toBeInstanceOf(McpServerError);
  });

  it('refuses a duplicate id rather than renaming or merging it', async () => {
    // An id is part of every tool name the server contributes, so resolving a
    // collision silently would point a task's existing tool at a different
    // endpoint.
    await store.add({ id: 'docs', displayName: 'Docs', url: 'https://a.test/rpc' });
    const error = await store
      .add({ id: 'docs', displayName: 'Other', url: 'https://b.test/rpc' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'ID_TAKEN' });
    expect(await store.list()).toHaveLength(1);
  });

  it('bounds how many servers there can be', async () => {
    for (let i = 0; i < MAX_SERVERS; i += 1) {
      await store.add({ id: `s${i}`, displayName: `S${i}`, url: `https://s${i}.test/rpc` });
    }
    await expect(
      store.add({ id: 'extra', displayName: 'Extra', url: 'https://extra.test/rpc' }),
    ).rejects.toMatchObject({ reason: 'TOO_MANY' });
  });

  it('contacts nothing, so a stored server has been named and not trusted', async () => {
    // There is no transport in this test and the add succeeds, which is the
    // assertion: storage does not reach the network.
    await expect(
      store.add({ id: 'docs', displayName: 'Docs', url: 'https://unreachable.invalid/rpc' }),
    ).resolves.toBeTruthy();
  });
});

describe('02 a record cannot acquire a credential', () => {
  it('drops a stored record that grew a field', () => {
    // `mcp-server` is PLAINTEXT_BY_DESIGN, and that is only honest while the
    // record has nowhere to put a secret. A record written through some other
    // path with a token on it is not read.
    expect(
      isStorableServer({
        id: 'docs',
        displayName: 'Docs',
        url: 'https://a.test/rpc',
        token: 'secret',
      }),
    ).toBe(false);
  });

  it('drops a record missing a field, rather than repairing it', () => {
    expect(isStorableServer({ id: 'docs', displayName: 'Docs' })).toBe(false);
    expect(isStorableServer(null)).toBe(false);
  });

  it('is classified in all three tables, with no secret to protect', () => {
    expect(DATA_CLASSIFICATION['mcp-server']).toBe('LOCAL_ONLY');
    expect(EXPORT_PORTABILITY['mcp-server']).toBe('NOT_PORTABLE_BY_DESIGN');
    expect(K1_PROTECTION['mcp-server']).toBe('PLAINTEXT_BY_DESIGN');
  });
});

describe('03 registering what a server offers', () => {
  const server: McpServerDescriptor = {
    id: 'docs',
    displayName: 'Docs',
    url: 'https://mcp.docs.test/rpc',
  };

  it('registers an admitted tool under its namespaced name', async () => {
    await store.add(server);
    const harness = createHarness([]);
    const outcomes = await registerMcpServers({
      store,
      registry: harness.registry,
      transportFor: () => answering([{ name: 'search', inputSchema: SCHEMA }]),
      securityContextFor: security,
    });
    expect(outcomes).toEqual([
      {
        serverId: 'docs',
        registered: ['mcp__docs__search'],
        refused: [],
        resourceCount: 0,
        refusedResources: [],
      },
    ]);
    expect(harness.registry.has('mcp__docs__search')).toBe(true);
  });

  it('names a tool whose schema this build will not compile, rather than dropping it', async () => {
    // The user's own client may show it working, so "this tool is missing and
    // nobody said why" is the wrong outcome.
    await store.add(server);
    const harness = createHarness([]);
    const [outcome] = await registerMcpServers({
      store,
      registry: harness.registry,
      transportFor: () =>
        answering([
          { name: 'ok', inputSchema: SCHEMA },
          { name: 'complex', inputSchema: { type: 'object', properties: { a: { $ref: '#/b' } } } },
        ]),
      securityContextFor: security,
    });
    expect(outcome?.registered).toEqual(['mcp__docs__ok']);
    expect(outcome?.refused).toEqual([
      { name: 'mcp__docs__complex', reason: expect.stringContaining('$ref') },
    ]);
  });

  it('does not let one failing server cost the user the others', async () => {
    await store.add({ id: 'broken', displayName: 'Broken', url: 'https://broken.test/rpc' });
    await store.add(server);
    const harness = createHarness([]);
    const outcomes = await registerMcpServers({
      store,
      registry: harness.registry,
      transportFor: (candidate) =>
        candidate.id === 'broken'
          ? answering([], { handshakeFails: true })
          : answering([{ name: 'search', inputSchema: SCHEMA }]),
      securityContextFor: security,
    });
    const broken = outcomes.find((o) => o.serverId === 'broken');
    expect(broken?.failure).toBeTruthy();
    expect(broken?.registered).toEqual([]);
    expect(harness.registry.has('mcp__docs__search')).toBe(true);
  });

  it('replaces a server’s tools rather than merging them', async () => {
    // A server that used to offer `delete_everything` and no longer does must
    // not keep it.
    await store.add(server);
    const harness = createHarness([]);
    let offered: readonly unknown[] = [
      { name: 'search', inputSchema: SCHEMA },
      { name: 'delete_everything', inputSchema: SCHEMA },
    ];
    const run = () =>
      registerMcpServers({
        store,
        registry: harness.registry,
        transportFor: () => answering(offered),
        securityContextFor: security,
      });
    await run();
    expect(harness.registry.has('mcp__docs__delete_everything')).toBe(true);
    offered = [{ name: 'search', inputSchema: SCHEMA }];
    await run();
    expect(harness.registry.has('mcp__docs__delete_everything')).toBe(false);
    expect(harness.registry.has('mcp__docs__search')).toBe(true);
  });

  it('keeps two servers offering the same tool name apart', async () => {
    await store.add(server);
    await store.add({ id: 'other', displayName: 'Other', url: 'https://other.test/rpc' });
    const harness = createHarness([]);
    await registerMcpServers({
      store,
      registry: harness.registry,
      transportFor: () => answering([{ name: 'search', inputSchema: SCHEMA }]),
      securityContextFor: security,
    });
    expect(harness.registry.has('mcp__docs__search')).toBe(true);
    expect(harness.registry.has('mcp__other__search')).toBe(true);
  });
});

describe('04 removing a server', () => {
  it('removes its tools, and there is no residual grant to revoke', async () => {
    // The point of the risk model rather than an accident: a tool exists only as
    // a function of the record and the answer the server just gave, and nothing
    // could have pre-approved one, so revocation is free.
    await store.add({ id: 'docs', displayName: 'Docs', url: 'https://mcp.docs.test/rpc' });
    const harness = createHarness([]);
    await registerMcpServers({
      store,
      registry: harness.registry,
      transportFor: () => answering([{ name: 'search', inputSchema: SCHEMA }]),
      securityContextFor: security,
    });
    await store.remove('docs');
    const removed = unregisterServer(harness.registry, 'docs');
    expect(removed).toEqual(['mcp__docs__search']);
    expect(harness.registry.list()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('refuses to remove a server that is not there', async () => {
    await expect(store.remove('nobody')).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('touches only the named server’s tools', async () => {
    await store.add({ id: 'docs', displayName: 'Docs', url: 'https://a.test/rpc' });
    await store.add({ id: 'other', displayName: 'Other', url: 'https://b.test/rpc' });
    const harness = createHarness([]);
    await registerMcpServers({
      store,
      registry: harness.registry,
      transportFor: () => answering([{ name: 'search', inputSchema: SCHEMA }]),
      securityContextFor: security,
    });
    unregisterServer(harness.registry, 'docs');
    expect(harness.registry.has('mcp__docs__search')).toBe(false);
    expect(harness.registry.has('mcp__other__search')).toBe(true);
  });

  it('cannot be used to remove a built-in, because it matches on the namespace', async () => {
    // `ToolRegistry.unregister` names a tool, so what stops a caller removing
    // `browser.click` is that the only caller matches the `mcp__<server>__`
    // prefix. An invariant test counts the callers.
    const harness = createHarness([]);
    const survivor = {
      name: 'browser.click',
      version: '1',
      description: 'x',
      inputSchema: (await import('zod')).z.object({}),
      risk: 'R2' as const,
      executionMode: 'requires_page' as const,
      siteAuthorization: 'page' as const,
      sideEffects: [],
      timeoutMs: 1,
      idempotent: false,
      execute: () => Promise.resolve({ success: true }),
    };
    harness.registry.register(survivor);
    unregisterServer(harness.registry, 'browser');
    expect(harness.registry.has('browser.click')).toBe(true);
  });
});
