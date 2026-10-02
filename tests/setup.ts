/**
 * Test setup.
 *
 * Silences the console sink so test output stays readable. The logger's
 * redaction behaviour is asserted directly in its own tests, using an
 * explicit MemorySink rather than the shared one.
 *
 * It also refuses to run on a Node this repository is not pinned to, for a
 * reason that was observed rather than anticipated: on Node 20 the jsdom
 * suites fail to start at all, with `ERR_REQUIRE_ESM` from inside one of
 * jsdom's own transitive dependencies. `html-encoding-sniffer@6` is CommonJS
 * and requires `@exodus/bytes`, which is ESM-only, so loading it needs
 * `require(esm)` — on by default from Node 22.12. The error names neither Node
 * nor this repository, which is exactly how a version mismatch gets read as a
 * flake. `.nvmrc` and `package.json`'s `engines` both say 22; `npx vitest` on
 * a shell that did not pick up the pin honours neither, so the check is here,
 * where every suite goes through it.
 */
import { beforeEach, vi } from 'vitest';

const MINIMUM_NODE_MAJOR = 22;

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
if (major < MINIMUM_NODE_MAJOR) {
  throw new Error(
    `This repository is pinned to Node ${MINIMUM_NODE_MAJOR} (see .nvmrc) and is running on ` +
      `${process.versions.node}. The jsdom suites cannot load on Node 20 — run \`nvm use\` first.`,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
