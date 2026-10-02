/**
 * TEST-FIGMA-001 — the second connector, and the credential header it needs.
 *
 * ## What is actually new here
 *
 * The GitHub connector established the framework. Figma establishes that it is
 * a *framework* rather than one adapter with a generic name, and it does so by
 * differing in the three ways that matter:
 *
 *  - **its credential is not in `Authorization`.** Figma's REST API reads
 *    `X-Figma-Token` and ignores `Authorization`, so a build that always used
 *    the latter would send an unauthenticated request with the user's token
 *    attached to it. The header now comes from the descriptor.
 *  - **its credential carries no scheme.** `X-Figma-Token`'s value *is* the
 *    token. `Bearer <token>` is a different string and Figma rejects it.
 *  - **its token's reach is never establishable.** Figma reports no scopes, so
 *    the adapter declares no write at all rather than one that could only ever
 *    be refused.
 *
 * Everything else — the preflight, the egress gate, the untrusted wrapping,
 * the error taxonomy — is the shared runtime, and the point of the cases below
 * is that none of it needed a second copy.
 *
 * ## No credential
 *
 * The token strings here are fixed literals that authenticate nothing, and
 * only the socket is replaced: the real session, the real vault, the real
 * guarded transport over the real egress gate.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ConsentStore } from '@/security/egress/consent';
import { freshTaint } from '@/security/taint/taint-state';
import { TokenVault } from '@/connectors/oauth/token-vault';
import { ConnectorSession, TokenRejected } from '@/connectors/core/connector-session';
import { WriteGuard } from '@/connectors/core/write-guard';
import { ConnectorRegistry, validateConnectorDescriptor } from '@/connectors/core/types';
import {
  createConnectorTransport,
  type ConnectorTransport,
} from '@/connectors/transport/connector-transport';
import {
  FigmaConnector,
  figmaDescriptor,
  figmaTokenProbeUrl,
  readFigmaTokenProbe,
  FIGMA_CREDENTIAL_HEADER,
  FIGMA_CONNECTOR_ID,
} from '@/connectors/adapters/figma';
import { ToolError } from '@/types/result';
import { MockConnectorService } from '../fixtures/connector-harness';
import type { AgentTool, ToolExecutionContext } from '@/tools/core/tool-types';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';

const ORIGIN = 'https://api.figma.test';
/** Not a credential: a fixed string that authenticates nothing. */
const TOKEN = 'figma-token-under-test';
const TASK = 'task_figma_1';
const FILE = 'abcDEF123456';
const NOW = 1_700_000_000_000;

const descriptor = figmaDescriptor({ apiOrigin: ORIGIN });

class UnusedFlow implements AuthFlowPort {
  ran = 0;
  run(): Promise<AuthFlowOutcome> {
    this.ran += 1;
    return Promise.resolve({ kind: 'cancelled', reason: 'there is no flow for Figma' });
  }
}

let service: MockConnectorService;
let vault: TokenVault;
let session: ConnectorSession;
let transport: ConnectorTransport;
let connector: FigmaConnector;
let tools: AgentTool[];
let flow: UnusedFlow;
let evidence: { label: string; content: string }[];
/** What the probe was asked, so the header it used can be asserted. */
let probes: { url: string; status: number }[];

function context(taskId = TASK): ToolExecutionContext {
  return {
    taskId,
    sessionId: 'session-under-test',
    toolCallId: `call-${taskId}`,
    signal: new AbortController().signal,
    recordEvidence: (reference, payload) => {
      evidence.push({
        label: reference.label ?? '',
        content: typeof payload.content === 'string' ? payload.content : '[binary]',
      });
    },
  };
}

function tool(name: string): AgentTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No connector tool named ${name}.`);
  return found;
}

/** Runs a tool and returns whatever it threw. */
async function failure(run: () => Promise<unknown>): Promise<ToolError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('The call was expected to fail and did not.');
}

beforeEach(async () => {
  service = new MockConnectorService();
  vault = new TokenVault(new MemoryStorageArea());
  flow = new UnusedFlow();
  evidence = [];
  probes = [];

  session = new ConnectorSession({
    descriptor,
    vault,
    authFlow: flow,
    clientId: '',
    exchange: () => Promise.reject(new Error('there is no exchange for Figma')),
    now: () => NOW,
    introspect: () => {
      // Stands in for the worker's probe. The probe's own reading is asserted
      // separately against `readFigmaTokenProbe`.
      probes.push({ url: figmaTokenProbeUrl(ORIGIN), status: 200 });
      return Promise.resolve(readFigmaTokenProbe({ status: 200, handle: 'someone' }));
    },
  });

  transport = createConnectorTransport({
    descriptor,
    vault,
    consent: new ConsentStore(),
    fetchImpl: service.fetchImpl,
    now: () => NOW,
  });

  connector = new FigmaConnector({
    descriptor,
    session,
    transport,
    writes: new WriteGuard(new SerializedStorageArea(new MemoryStorageArea()), () => NOW),
    egressFor: () => ({
      taintState: freshTaint(),
      taintSalt: 'ab'.repeat(32),
      saltEpoch: 1,
      taintSignature: 'signature-under-test',
    }),
  });
  tools = connector.createTools();

  await session.connectWithToken({ token: TOKEN, tokenType: null });
});

describe('the credential goes where Figma reads it', () => {
  it('sends X-Figma-Token and no Authorization header at all', async () => {
    // The whole reason the header is on the descriptor. An `Authorization`
    // header here would be an unauthenticated request carrying the user's
    // token, and Figma would answer 403 with the credential already spent.
    service.on('/v1/files/', { json: { name: 'A file', document: { children: [] } } });
    await tool('figma.read_file').execute({ fileKey: FILE }, context());

    const [request] = service.seen;
    expect(request!.headers['x-figma-token']).toBe(TOKEN);
    expect(request!.headers['authorization']).toBeUndefined();
  });

  it('sends the token with no scheme prefix', async () => {
    // `X-Figma-Token`'s value *is* the token. `Bearer <token>` is a different
    // string and Figma rejects it.
    service.on('/v1/files/', { json: { name: 'A file', document: { children: [] } } });
    await tool('figma.read_file').execute({ fileKey: FILE }, context());
    expect(service.seen[0]!.headers['x-figma-token']).not.toMatch(/^Bearer /);
    expect(service.seen[0]!.headers['x-figma-token']).toBe(TOKEN);
  });

  it('refuses a caller that tries to supply either header itself', async () => {
    // The transport strips every spelling of the credential header **and** of
    // `Authorization` from caller headers before applying the credential
    // last. A caller-supplied `Authorization` would be a second credential on
    // a request to a declared origin that nothing in this build had seen.
    //
    // **Asserted on the raw header object, not through the shared mock.** The
    // mock lowercases every name as it records it, so the credential — applied
    // last and therefore written last — overwrites a differently-cased caller
    // key and the test passes whether or not the stripping happened. A
    // mutation that removed the stripping survived for exactly that reason.
    // A browser's `Headers` constructor does **not** normalise before it
    // appends: three object keys differing only in case are three appends, and
    // what the server receives is not something to leave to that. So this
    // captures `init.headers` itself and counts the keys.
    let sent: Record<string, string> = {};
    const watching = createConnectorTransport({
      descriptor,
      vault,
      consent: new ConsentStore(),
      now: () => NOW,
      fetchImpl: ((_url: string, init: RequestInit) => {
        sent = (init.headers ?? {}) as Record<string, string>;
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as unknown as typeof fetch,
    });

    await watching.send(
      {
        url: `${ORIGIN}/v1/files/${FILE}`,
        method: 'GET',
        headers: {
          'x-figma-token': 'a-token-of-the-callers-choosing',
          'X-FIGMA-TOKEN': 'another-casing',
          authorization: 'Bearer something-else',
          'X-Other': 'kept',
        },
      },
      {
        taskId: TASK,
        taintState: freshTaint(),
        taintSalt: 'ab'.repeat(32),
        saltEpoch: 1,
        taintSignature: 's',
        connectorId: FIGMA_CONNECTOR_ID,
        operationId: 'read_file',
      },
    );

    const names = Object.keys(sent);
    // Exactly one key is the credential header, in any casing. Two would be
    // two appends in a real browser and an undefined outcome.
    const credentialKeys = names.filter(
      (name) => name.toLowerCase() === FIGMA_CREDENTIAL_HEADER.toLowerCase(),
    );
    expect(credentialKeys).toHaveLength(1);
    expect(sent[credentialKeys[0]!]).toBe(TOKEN);

    // And no spelling of `Authorization` survives at all.
    expect(names.filter((name) => name.toLowerCase() === 'authorization')).toEqual([]);

    // A header that is not a credential is left alone.
    expect(sent['X-Other']).toBe('kept');
  });

  it('is registrable, with a header name the validator accepts', () => {
    expect(validateConnectorDescriptor(descriptor)).toEqual([]);
    expect(descriptor.credentialHeader).toBe(FIGMA_CREDENTIAL_HEADER);

    const registry = new ConnectorRegistry();
    expect(() => registry.register(connector)).not.toThrow();
    expect(registry.get(FIGMA_CONNECTOR_ID)).toBe(connector);
  });

  it('refuses a descriptor whose credential header is not a header name', () => {
    // Refused where a descriptor becomes registrable, rather than at the
    // moment a credential is attached to something.
    for (const bad of ['X Figma Token', 'X-Figma-Token: ', 'X\nFigma', '']) {
      const problems = validateConnectorDescriptor({
        ...descriptor,
        credentialHeader: bad,
      });
      expect(problems.join(' '), JSON.stringify(bad)).toMatch(/not a usable header name/);
    }
  });
});

describe('what the connector can and cannot do', () => {
  it('offers two reads and no write', () => {
    // Not caution: Figma reports nothing about what a token may do, so a
    // declared write scope could never be satisfied and the operation could
    // only ever be refused. An operation that can only fail reads as a broken
    // feature rather than an absent one.
    expect(descriptor.operations.map((operation) => operation.id).sort()).toEqual([
      'read_comments',
      'read_file',
    ]);
    expect(descriptor.operations.filter((operation) => operation.kind === 'write')).toEqual([]);
    expect(tools.map((entry) => entry.name).sort()).toEqual([
      'figma.read_comments',
      'figma.read_file',
    ]);
  });

  it('declares no scope, so a read works on a token whose reach is unknown', async () => {
    // Which is every Figma token. A required scope here would make the
    // connector unusable rather than careful.
    for (const operation of descriptor.operations) {
      expect(operation.requiredScopes, operation.id).toEqual([]);
    }
    expect(session.hasScopes([])).toBe(true);

    service.on('/comments', { json: { comments: [] } });
    const result = await tool('figma.read_comments').execute({ fileKey: FILE }, context());
    expect(result.success).toBe(true);
  });

  it('has no OAuth configuration, because there is no flow it could complete', () => {
    // Figma's OAuth requires a client secret in the code exchange even with
    // PKCE, and this extension must not carry one.
    expect(descriptor.authKind).toBe('api_token');
    expect(descriptor.oauth).toBeUndefined();
    expect(flow.ran).toBe(0);
  });

  it('reaches only the one declared origin', async () => {
    await expect(
      transport.send(
        { url: 'https://api.figma.test.evil.test/v1/files/x', method: 'GET' },
        {
          taskId: TASK,
          taintState: freshTaint(),
          taintSalt: 'ab'.repeat(32),
          saltEpoch: 1,
          taintSignature: 's',
          connectorId: FIGMA_CONNECTOR_ID,
          operationId: 'read_file',
        },
      ),
    ).rejects.toThrow(/not configured to reach/);
    expect(service.seen).toEqual([]);
  });
});

describe('reading a file', () => {
  it('returns its pages and layers, wrapped as untrusted', async () => {
    service.on('/v1/files/', {
      json: {
        name: 'Design system',
        lastModified: '2026-10-01T00:00:00Z',
        editorType: 'figma',
        document: {
          children: [
            { name: 'Page one', type: 'CANVAS', children: [{ name: 'Button', type: 'FRAME' }] },
          ],
        },
      },
    });

    const result = await tool('figma.read_file').execute({ fileKey: FILE }, context());
    const data = result.data as { pageCount: number; file: string };
    expect(data.pageCount).toBe(1);
    // A layer name is written by whoever made the file. It reaches the model
    // inside an untrusted wrapper or not at all.
    expect(data.file).toContain('UNTRUSTED');
    expect(data.file).toContain('Button');
  });

  it('asks for a shallow tree rather than the whole document', async () => {
    // A real design file's full tree is enormous; it would be truncated into
    // uselessness and billed for on the way.
    service.on('/v1/files/', { json: { name: 'A file', document: { children: [] } } });
    await tool('figma.read_file').execute({ fileKey: FILE }, context());
    expect(service.seen[0]!.url).toContain('depth=2');
    expect(service.seen[0]!.method).toBe('GET');
    expect(service.seen[0]!.body).toBeUndefined();
  });

  it('records the file as evidence, labelled untrusted', async () => {
    service.on('/v1/files/', { json: { name: 'A file', document: { children: [] } } });
    await tool('figma.read_file').execute({ fileKey: FILE }, context());
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.label).toContain(FILE);
  });

  it('survives a response with nothing in it', async () => {
    service.on('/v1/files/', { json: {} });
    const result = await tool('figma.read_file').execute({ fileKey: FILE }, context());
    expect(result.success).toBe(true);
    expect((result.data as { pageCount: number }).pageCount).toBe(0);
  });

  it('truncates a long name rather than passing it through', async () => {
    service.on('/v1/files/', {
      json: { name: 'n'.repeat(5_000), document: { children: [] } },
    });
    const result = await tool('figma.read_file').execute({ fileKey: FILE }, context());
    expect((result.data as { file: string }).file).toContain('[truncated]');
  });

  it('refuses a file key that is not one, before sending anything', () => {
    // No slashes, so a key cannot carry a path segment into the URL this
    // builds. Checked by the tool's own schema.
    for (const bad of ['', 'too-short', 'has/slash/parts', '../../etc', 'has space']) {
      expect(tool('figma.read_file').inputSchema.safeParse({ fileKey: bad }).success, bad).toBe(
        false,
      );
    }
    expect(tool('figma.read_file').inputSchema.safeParse({ fileKey: FILE }).success).toBe(true);
  });
});

describe('reading comments', () => {
  it('returns them capped, truncated and wrapped', async () => {
    service.on('/comments', {
      json: {
        comments: Array.from({ length: 60 }, (_, index) => ({
          id: String(index),
          message: 'm'.repeat(4_000),
          user: { handle: 'someone' },
          resolved_at: null,
        })),
      },
    });

    const result = await tool('figma.read_comments').execute({ fileKey: FILE }, context());
    const data = result.data as { returned: number; comments: string };
    expect(data.returned).toBe(25);
    expect(data.comments).toContain('UNTRUSTED');
    expect(data.comments).toContain('[truncated]');
  });

  it('says whether a comment was resolved, without inventing it', async () => {
    service.on('/comments', {
      json: {
        comments: [
          { id: '1', message: 'open', user: { handle: 'a' }, resolved_at: null },
          { id: '2', message: 'done', user: { handle: 'b' }, resolved_at: '2026-10-01T00:00:00Z' },
        ],
      },
    });
    const result = await tool('figma.read_comments').execute({ fileKey: FILE }, context());
    const comments = (result.data as { comments: string }).comments;
    expect(comments).toContain('"resolved":false');
    expect(comments).toContain('"resolved":true');
  });
});

describe('failures a read surfaces', () => {
  it('names both reasons for a 403, because Figma uses it for two things', async () => {
    // A scope the token lacks, and a file the account cannot see. The shared
    // message covers only the first, and a user who pasted a key from
    // somebody else's URL hits the second.
    service.on('/v1/files/', { status: 403, json: { err: 'Forbidden' } });
    const error = await failure(() =>
      tool('figma.read_file').execute({ fileKey: FILE }, context()),
    );
    expect(error.toAgentError().code).toBe('PERMISSION_DENIED');
    expect(error.toAgentError().userMessage).toMatch(/scope|shared/i);
  });

  it('does not claim which of the two a 404 was', async () => {
    service.on('/v1/files/', { status: 404, json: { err: 'Not found' } });
    const error = await failure(() =>
      tool('figma.read_file').execute({ fileKey: FILE }, context()),
    );
    expect(error.toAgentError().userMessage).toMatch(/not found, or is not visible/i);
  });

  it('treats a 429 as retryable and a 500 as the service’s problem', async () => {
    service.on('/v1/files/', { status: 429, json: {} });
    const limited = await failure(() =>
      tool('figma.read_file').execute({ fileKey: FILE }, context()),
    );
    expect(limited.toAgentError().code).toBe('RATE_LIMITED');

    service.on('/v1/files/', { status: 503, json: {} });
    const down = await failure(() => tool('figma.read_file').execute({ fileKey: FILE }, context()));
    expect(down.toAgentError().code).toBe('CONNECTOR_ERROR');
  });

  it('does not echo the service response into the user-facing message', async () => {
    service.on('/v1/files/', { status: 400, text: 'something the service decided to say' });
    const error = await failure(() =>
      tool('figma.read_file').execute({ fileKey: FILE }, context()),
    );
    expect(error.toAgentError().userMessage).not.toContain('something the service decided');
  });

  it('refuses every operation once the token is discarded', async () => {
    await connector.revoke();
    const error = await failure(() =>
      tool('figma.read_file').execute({ fileKey: FILE }, context()),
    );
    expect(error.toAgentError().code).toBe('AUTH_REQUIRED');
    expect(service.seen).toEqual([]);
  });
});

describe('reading Figma’s answer about a supplied token', () => {
  it('refuses a 401 and a 403 alike', () => {
    // Conservative on purpose, and the reason is written in the adapter: a
    // token lacking `current_user:read` could in principle answer 403 while
    // still reading files, but so could a wrong token, and accepting the
    // second error is worse than refusing the first.
    for (const status of [401, 403]) {
      expect(() => readFigmaTokenProbe({ status }), String(status)).toThrow(TokenRejected);
    }
  });

  it('treats any other failure as a failure to ask', () => {
    let thrown: unknown;
    try {
      readFigmaTokenProbe({ status: 500 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TokenRejected);
  });

  it('never establishes a scope, because Figma reports none', () => {
    // Which is why the adapter declares no write. If this ever returns a list,
    // that decision can be revisited on evidence.
    expect(readFigmaTokenProbe({ status: 200, handle: 'someone' }).scopes).toBeNull();
  });

  it('prefers the handle over the email, and caps it', () => {
    expect(readFigmaTokenProbe({ status: 200, handle: 'a', email: 'b@c.test' }).accountLabel).toBe(
      'a',
    );
    expect(readFigmaTokenProbe({ status: 200, email: 'b@c.test' }).accountLabel).toBe('b@c.test');
    expect(readFigmaTokenProbe({ status: 200, handle: 'x'.repeat(500) }).accountLabel).toHaveLength(
      64,
    );
    expect(readFigmaTokenProbe({ status: 200 }).accountLabel).toBeUndefined();
  });

  it('probes the me endpoint, which reads no file', () => {
    expect(figmaTokenProbeUrl(ORIGIN)).toBe(`${ORIGIN}/v1/me`);
    expect(figmaTokenProbeUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/v1/me`);
    expect(probes[0]?.url).toBe(`${ORIGIN}/v1/me`);
  });
});

describe('the token never leaves the vault', () => {
  it('is in no tool result, no evidence record and no account state', async () => {
    service.on('/v1/files/', { json: { name: 'A file', document: { children: [] } } });
    const result = await tool('figma.read_file').execute({ fileKey: FILE }, context());

    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(evidence)).not.toContain(TOKEN);
    expect(JSON.stringify(await connector.getAuthState())).not.toContain(TOKEN);
    expect(JSON.stringify(await connector.listCapabilities())).not.toContain(TOKEN);
  });
});
