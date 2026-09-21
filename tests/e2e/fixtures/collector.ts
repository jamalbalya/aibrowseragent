/**
 * A second origin that records every request it receives.
 *
 * Exists so an egress test can assert on the *receiving* side. Checking that a
 * tool returned BLOCK proves only that the extension said no; it does not
 * prove nothing left the browser. A request that was issued and then ignored
 * looks identical from inside the extension and is a complete failure of the
 * control. This server is the independent witness.
 *
 * It listens on its own port so it is a different origin from the test site,
 * which is what makes a navigation to it cross-site.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CollectedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

export interface Collector {
  readonly baseUrl: string;
  readonly requests: CollectedRequest[];
  /** Requests whose URL or body contains the given text. */
  hitsContaining(text: string): CollectedRequest[];
  close(): Promise<void>;
}

export async function startCollector(): Promise<Collector> {
  const requests: CollectedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Collector</title><h1>Collected</h1>');
    });
  });

  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    // `localhost` rather than `127.0.0.1` so this is a different *site* from
    // the test server, not merely a different port.
    baseUrl: `http://localhost:${port}`,
    requests,
    hitsContaining: (text) =>
      requests.filter((entry) => entry.url.includes(text) || entry.body.includes(text)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
