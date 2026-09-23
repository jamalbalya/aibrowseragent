/**
 * A controlled AI Browser Agent backend, over real HTTPS, for real Chromium.
 *
 * The integration suites drive `createAuthRouter` as a function. This runs the
 * *same* router behind a real TLS socket so the extension can talk to it the
 * way it would talk to a deployment: a real `fetch` through the egress gate, a
 * real tab navigating to a real redirect, a real 303 the browser follows.
 *
 * **HTTPS is not optional here, and that is the point.** `loadIdentityConfig`
 * refuses anything but `https:`, deliberately, so a fixture served over plain
 * HTTP could not be reached at all — and weakening that rule to make a test
 * pass would be weakening the product. Instead the fixture generates a
 * throwaway certificate and the browser is told to accept it, which leaves the
 * production rule exactly as it is.
 *
 * ## What is controlled, and what that does not prove
 *
 * Google is a fixture: a generated RSA keypair, a JWKS served from memory, and
 * genuine RS256 ID tokens. That proves the protocol this extension and this
 * backend implement between them. It proves **nothing** about whether Google's
 * real endpoints accept this client, which needs real credentials and is
 * reported as credential-blocked. Nothing here is a live-provider acceptance
 * test and nothing here is counted as one.
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAccessTokenIssuer,
  createAuthRouter,
  createIdentityBackend,
  DEFAULT_PATHS,
  silentLogger,
  type GoogleTokenEndpoint,
} from '../../../server/index';
import { GoogleFixture } from '../../fixtures/google-oidc-fixture';

/**
 * Fixed, because the extension's backend origin is inlined at build time.
 *
 * The configured build in `dist-auth/` is compiled against exactly this
 * origin, so the two have to agree on a number rather than discovering one.
 */
export const AUTH_BACKEND_PORT = 8443;
export const AUTH_BACKEND_ORIGIN = `https://localhost:${AUTH_BACKEND_PORT}`;

const CLIENT_ID = 'fixture-client.apps.googleusercontent.com';

export interface AuthBackend {
  readonly origin: string;
  /** Every request path the server saw, for asserting what was called. */
  readonly seen: string[];
  /** The Google subject the next sign-in will present. */
  setSubject(subject: string): void;
  /** Every device row the backend holds for an account. */
  devices(abaUserId: string): Promise<readonly { device_id: string }[]>;
  /** Every session row for an account, so revocation can be asserted. */
  sessions(abaUserId: string): Promise<readonly { id: string; revoked_at: number | null }[]>;
  /** Moves the backend's clock, so an access token can be aged past expiry. */
  advance(ms: number): void;
  close(): Promise<void>;
}

/** A self-signed certificate for `localhost`, generated fresh each run. */
function certificate(): { key: string; cert: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aba-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), dir };
}

export async function startAuthBackend(): Promise<AuthBackend> {
  const google = await GoogleFixture.create();
  let subject = 'google-subject-e2e';

  const tokens: GoogleTokenEndpoint = {
    async redeem() {
      // The nonce is read back out of the live challenge by the caller below.
      return {
        idToken: await google.idToken(
          { audience: CLIENT_ID, nonce, now: Date.now() },
          { sub: subject },
        ),
      };
    },
  };

  // The nonce the current flow generated. The router hands Google's adapter
  // no context, so the fixture reads it from the authorization URL the same
  // way a browser would.
  let nonce = '';

  // A clock the test can move, so access-token expiry is exercised by ageing
  // the session rather than by waiting fifteen minutes.
  let offset = 0;
  const clock = { now: () => Date.now() + offset };

  const backend = createIdentityBackend({
    clock,
    log: silentLogger,
    google: {
      config: {
        clientId: CLIENT_ID,
        redirectUri: `${AUTH_BACKEND_ORIGIN}${DEFAULT_PATHS.redirectPath}`,
        authorizationEndpoint: `${AUTH_BACKEND_ORIGIN}/fixture/google/authorize`,
      },
      jwks: google.jwks(),
      tokens,
    },
  });

  const router = createAuthRouter({
    backend,
    log: silentLogger,
    accessTokens: await createAccessTokenIssuer('e2e-fixture-signing-key-'.padEnd(64, 'x')),
  });

  const seen: string[] = [];
  const { key, cert, dir } = certificate();

  const server: Server = createServer({ key, cert }, (incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', AUTH_BACKEND_ORIGIN);
      seen.push(url.pathname);

      /**
       * Google's authorization screen, standing in for accounts.google.com.
       *
       * It does what Google does and nothing else: reads `state` and `nonce`
       * off the query string, then redirects to the registered redirect URI
       * with an authorization code. There is no consent UI because there is
       * no consent decision being tested here.
       */
      if (url.pathname === '/fixture/google/authorize') {
        nonce = url.searchParams.get('nonce') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const back = new URL(DEFAULT_PATHS.redirectPath, AUTH_BACKEND_ORIGIN);
        back.searchParams.set('code', 'fixture-authorization-code');
        back.searchParams.set('state', state);
        outgoing.writeHead(303, { location: back.toString() });
        outgoing.end();
        return;
      }

      const body = incoming.method === 'POST' ? await readBody(incoming) : undefined;
      const response = await router(
        new Request(url.toString(), {
          method: incoming.method ?? 'GET',
          ...(body === undefined || body.length === 0 ? {} : { body }),
          headers: { 'content-type': 'application/json' },
        }),
      );

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(AUTH_BACKEND_PORT, '127.0.0.1', resolve));

  return {
    origin: AUTH_BACKEND_ORIGIN,
    seen,
    setSubject(next: string) {
      subject = next;
    },
    devices: (abaUserId: string) => backend.store.listDevices(abaUserId),
    sessions: (abaUserId: string) => backend.store.listSessions(abaUserId),
    advance(ms: number) {
      offset += ms;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function readBody(incoming: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    incoming.on('error', reject);
  });
}
