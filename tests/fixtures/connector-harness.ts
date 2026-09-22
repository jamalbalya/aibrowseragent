/**
 * A connector wired the way the service worker wires one, plus a mock service.
 *
 * The point of building it here rather than in each suite is that the tests
 * then exercise the *real* composition — real token vault, real session, real
 * guarded transport over the real egress gate, real write guard — with only
 * the socket replaced. A suite that stubbed the transport would prove its own
 * stub behaved, which is the one thing nobody needs to know.
 *
 * `fetchImpl` is the single seam. Everything above it is production code.
 */
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ConsentStore } from '@/security/egress/consent';
import { freshTaint, type TaintState } from '@/security/taint/taint-state';
import type { EgressDecision } from '@/security/egress/egress-gate';
import { TokenVault, type StoredTokens } from '@/connectors/oauth/token-vault';
import { ConnectorSession, type TokenResponse } from '@/connectors/core/connector-session';
import type { AuthFlowOutcome, AuthFlowPort } from '@/connectors/oauth/auth-flow-port';
import {
  createConnectorTransport,
  type ConnectorTransport,
} from '@/connectors/transport/connector-transport';
import { WriteGuard } from '@/connectors/core/write-guard';
import {
  GitHubConnector,
  githubDescriptor,
  type ConnectorCallContext,
} from '@/connectors/adapters/github';
import type { AgentTool, ToolExecutionContext } from '@/tools/core/tool-types';

export const MOCK_ORIGIN = 'https://api.github.test';
export const MOCK_AUTHORIZE = 'https://github.test/login/oauth/authorize';
export const MOCK_TOKEN = 'https://github.test/login/oauth/access_token';
export const MOCK_REDIRECT = 'https://redirect.test/oauth/callback';

/** One request the mock service saw, recorded in full so tests can inspect it. */
export interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface ScriptedResponse {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
  /** Thrown instead of answering, for timeout and socket-drop cases. */
  readonly throws?: unknown;
  /**
   * Answers with a browser's opaque-redirect filtered response.
   *
   * Node's `Response` cannot be constructed with `type: 'opaqueredirect'`, so
   * this stands in for what real Chromium returns from a `redirect: 'manual'`
   * fetch that met a 3xx: status 0, no headers, nothing about the target.
   */
  readonly opaqueRedirect?: true;
}

/**
 * A mock GitHub-shaped API.
 *
 * Scripted per URL substring, in order, so a test can say "the first POST
 * times out and the second succeeds" without reaching into the transport.
 */
export class MockConnectorService {
  readonly seen: SeenRequest[] = [];
  private readonly script: { match: string; response: ScriptedResponse }[] = [];

  /** Queues one answer for the next request whose URL contains `match`. */
  on(match: string, response: ScriptedResponse): this {
    this.script.push({ match, response });
    return this;
  }

  get fetchImpl(): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // The transport always passes a string; the other two shapes are
      // handled so the seam is a real `fetch` rather than a narrowed one.
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        (init?.headers as Record<string, string> | undefined) ?? {},
      )) {
        headers[key.toLowerCase()] = value;
      }
      this.seen.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      const index = this.script.findIndex((entry) => url.includes(entry.match));
      if (index === -1) {
        return new Response(JSON.stringify({ message: 'no script entry' }), { status: 501 });
      }
      const [entry] = this.script.splice(index, 1);
      const response = entry!.response;
      if (response.throws !== undefined) {
        // Rethrown as-is: a test scripts a `DOMException` here on purpose,
        // because how the guard classifies a failure depends on its type.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw response.throws;
      }

      if (response.opaqueRedirect) {
        return {
          type: 'opaqueredirect',
          status: 0,
          ok: false,
          headers: new Headers(),
          json: () => Promise.reject(new TypeError('opaque')),
          text: () => Promise.resolve(''),
        } as unknown as Response;
      }

      const body =
        response.json !== undefined ? JSON.stringify(response.json) : (response.text ?? '');
      return new Response(body, {
        status: response.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(response.headers ?? {}) },
      });
    };
  }

  /** Every `Authorization` header the service was sent. */
  authorizations(): string[] {
    return this.seen.map((request) => request.headers.authorization ?? '');
  }
}

/** An auth flow whose outcome the test chooses. */
export class ScriptedAuthFlow implements AuthFlowPort {
  readonly opened: string[] = [];
  /** Replaces the callback URL, so a test can forge one. */
  forge: ((authorizationUrl: string) => AuthFlowOutcome) | null = null;
  outcome: AuthFlowOutcome | null = null;

  run(request: { authorizationUrl: string; redirectUri: string }): Promise<AuthFlowOutcome> {
    this.opened.push(request.authorizationUrl);
    if (this.forge) return Promise.resolve(this.forge(request.authorizationUrl));
    if (this.outcome) return Promise.resolve(this.outcome);
    // The honest default: echo back the state the extension generated, the
    // way a cooperating service would.
    const state = new URL(request.authorizationUrl).searchParams.get('state') ?? '';
    return Promise.resolve({
      kind: 'callback',
      url: `${request.redirectUri}?code=auth-code-1&state=${encodeURIComponent(state)}`,
    });
  }
}

export interface HarnessOptions {
  readonly clientId?: string;
  readonly apiOrigin?: string;
  readonly now?: () => number;
  readonly taintState?: TaintState;
}

export interface ConnectorHarness {
  readonly service: MockConnectorService;
  readonly authFlow: ScriptedAuthFlow;
  readonly vault: TokenVault;
  readonly session: ConnectorSession;
  readonly connector: GitHubConnector;
  /** The very transport the connector uses, for tests that drive it directly. */
  readonly transport: ConnectorTransport;
  readonly writes: WriteGuard;
  readonly consent: ConsentStore;
  readonly decisions: EgressDecision[];
  /** Token responses the exchange will return, oldest first. */
  readonly tokenResponses: TokenResponse[];
  readonly exchanges: URLSearchParams[];
  /** Per-task security context the connector resolves before each call. */
  readonly contexts: Map<string, ConnectorCallContext>;
  tool(name: string): AgentTool;
  seedTokens(tokens: Partial<StoredTokens>): Promise<void>;
  /** Makes the connector READY without running a flow, for read/write tests. */
  connect(scopes?: readonly string[]): Promise<void>;
  context(taskId: string): ToolExecutionContext;
  readonly evidence: { label: string; content: string }[];
}

export function buildConnectorHarness(options: HarnessOptions = {}): ConnectorHarness {
  const now = options.now ?? (() => 1_700_000_000_000);
  const service = new MockConnectorService();
  const authFlow = new ScriptedAuthFlow();
  const consent = new ConsentStore();
  const decisions: EgressDecision[] = [];
  const tokenResponses: TokenResponse[] = [];
  const exchanges: URLSearchParams[] = [];
  const evidence: { label: string; content: string }[] = [];

  const descriptor = githubDescriptor({
    apiOrigin: options.apiOrigin ?? MOCK_ORIGIN,
    authorizationEndpoint: MOCK_AUTHORIZE,
    tokenEndpoint: MOCK_TOKEN,
    redirectUri: MOCK_REDIRECT,
  });

  const vault = new TokenVault(new MemoryStorageArea());
  const writes = new WriteGuard(new SerializedStorageArea(new MemoryStorageArea()), now);

  const session = new ConnectorSession({
    descriptor,
    vault,
    authFlow,
    clientId: options.clientId ?? 'client-id-under-test',
    exchange: (endpoint, body) => {
      exchanges.push(body);
      const next = tokenResponses.shift();
      if (next === undefined) {
        return Promise.reject(new Error(`no token response scripted for ${endpoint}`));
      }
      return Promise.resolve(next);
    },
    now,
  });

  const transport = createConnectorTransport({
    descriptor,
    vault,
    consent,
    fetchImpl: service.fetchImpl,
    now,
    onDecision: (decision) => {
      decisions.push(decision);
      return Promise.resolve();
    },
  });

  const contexts = new Map<string, ConnectorCallContext>();
  const defaultContext = (): ConnectorCallContext => ({
    taintState: options.taintState ?? freshTaint(),
    taintSalt: 'ab'.repeat(32),
    saltEpoch: 1,
    taintSignature: 'signature-under-test',
  });

  const connector = new GitHubConnector({
    descriptor,
    session,
    transport,
    writes,
    egressFor: (taskId) => contexts.get(taskId) ?? defaultContext(),
  });

  const tools = connector.createTools();

  return {
    service,
    authFlow,
    vault,
    session,
    connector,
    transport,
    writes,
    consent,
    decisions,
    tokenResponses,
    exchanges,
    contexts,
    evidence,

    tool(name: string): AgentTool {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`No connector tool named ${name}.`);
      return found;
    },

    async seedTokens(tokens: Partial<StoredTokens>): Promise<void> {
      await vault.store(descriptor.id, {
        accessToken: 'seeded-access-token',
        tokenType: 'Bearer',
        refreshToken: 'seeded-refresh-token',
        scopes: ['public_repo'],
        ...tokens,
      });
    },

    async connect(scopes: readonly string[] = ['public_repo']): Promise<void> {
      await vault.store(descriptor.id, {
        accessToken: 'seeded-access-token',
        tokenType: 'Bearer',
        scopes: [...scopes],
      });
      await session.reconcile();
    },

    context(taskId: string): ToolExecutionContext {
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
    },
  };
}

/** A GitHub issue as the mock service returns it. */
export function wireIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: 'A title',
    state: 'open',
    html_url: 'https://github.test/acme/widgets/issues/7',
    body: 'An issue body.',
    user: { login: 'someone' },
    comments: 0,
    ...overrides,
  };
}
