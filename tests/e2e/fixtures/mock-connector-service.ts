/**
 * A local service that speaks OAuth 2.0 and a GitHub-shaped API.
 *
 * Real sockets, real HTTP, real redirects — the point of it is that the
 * browser under test does the things a browser actually does, including the
 * ones that differ from Node: `redirect: 'manual'` semantics, extension-URL
 * navigation rules, and what a cross-origin response is allowed to reveal.
 *
 * It is deliberately permissive about the OAuth *protocol* — it will issue a
 * token for any code — because the extension's protocol checks are asserted
 * exhaustively in the unit suites. What it is strict about is recording what
 * it was sent, so a test can prove what left the browser.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ServiceRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface MockConnectorService {
  readonly baseUrl: string;
  readonly requests: ServiceRequest[];
  /** The access token this service will issue and accept. */
  readonly accessToken: string;
  /** Where the next authorize request should send the browser. */
  redirectTo: string | null;
  close(): Promise<void>;
}

/**
 * Starts the service.
 *
 * Routes:
 *   GET  /login/oauth/authorize    302 to `redirectTo` with a code and the
 *                                  state it was given
 *   POST /login/oauth/access_token issues a token for any code
 *   GET  /search/issues            a search result
 *   GET  /repos/:o/:r/issues/:n    one issue
 *   POST /repos/:o/:r/issues       creates one
 *   GET  /redirect-away            302 to an origin the connector never
 *                                  declared, for the redirect-refusal case
 *   GET  /redirect-within          302 to a path on this same origin
 */
export async function startMockConnectorService(): Promise<MockConnectorService> {
  const requests: ServiceRequest[] = [];
  const accessToken = 'mock-connector-access-token';
  const state: { redirectTo: string | null } = { redirectTo: null };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const json = (status: number, value: unknown): void => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          // The extension reaches this from a page and from the worker, so
          // the browser needs to be told the read is permitted.
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        });
        res.end();
        return;
      }

      if (url.pathname === '/login/oauth/authorize') {
        const target = state.redirectTo ?? url.searchParams.get('redirect_uri');
        if (target === null) {
          json(400, { error: 'invalid_request' });
          return;
        }
        const location = new URL(target);
        location.searchParams.set('code', 'mock-authorization-code');
        location.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { Location: location.toString() });
        res.end();
        return;
      }

      if (url.pathname === '/login/oauth/access_token') {
        json(200, {
          access_token: accessToken,
          token_type: 'Bearer',
          scope: 'public_repo',
        });
        return;
      }

      if (url.pathname === '/redirect-away') {
        // An origin this connector never declared. A transport that followed
        // this would be sending a bearer token somewhere it does not belong.
        res.writeHead(302, { Location: 'http://localhost:1/collect' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-within') {
        res.writeHead(302, { Location: '/search/issues?q=moved' });
        res.end();
        return;
      }

      if (req.headers.authorization !== `Bearer ${accessToken}`) {
        json(401, { message: 'Bad credentials' });
        return;
      }

      if (url.pathname === '/search/issues') {
        json(200, {
          total_count: 1,
          items: [
            {
              number: 7,
              title: 'A mock issue',
              state: 'open',
              html_url: 'http://127.0.0.1/acme/widgets/issues/7',
            },
          ],
        });
        return;
      }

      if (/^\/repos\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) {
        json(200, {
          number: 7,
          title: 'A mock issue',
          state: 'open',
          body: 'Issue body from the mock service.',
          user: { login: 'mockuser' },
        });
        return;
      }

      if (/^\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname) && req.method === 'POST') {
        json(201, { number: 11, html_url: 'http://127.0.0.1/acme/widgets/issues/11' });
        return;
      }

      json(404, { message: 'Not Found' });
    });
  });

  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    accessToken,
    get redirectTo() {
      return state.redirectTo;
    },
    set redirectTo(value: string | null) {
      state.redirectTo = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
