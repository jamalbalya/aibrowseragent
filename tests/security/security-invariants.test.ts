/**
 * TEST-SECURITY-031 — standing structural invariants across the whole source.
 *
 * Every other security suite tests one capability. This one tests the shape
 * of the codebase, and it exists because of how the failures in this project
 * have actually happened: not by someone weakening a check, but by a new
 * component arriving beside one.
 *
 * A fourth `onMessage` listener. A third caller of `dispatch`. A second place
 * that reaches the network. A route registered without a class. None of those
 * breaks an existing test, because every existing test is about the thing it
 * was written for. What catches them is counting.
 *
 * So the assertions here are deliberately about *totals* and *absences* over
 * the tree rather than about behaviour. Each one names what it would allow if
 * it failed, and each is expected to fail loudly when a new component appears
 * — at which point the right response is to decide whether the component
 * belongs and update the count with a reason, not to widen the test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PANEL_ROUTE_CLASSES } from '@/messaging/route-trust';
import { isLoopbackHostname } from '@/security/origin/origin-validator';
import { HEALTH_DOMAINS, PersistenceHealthStore } from '@/storage/persistence-health';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ALLOWED_CDP_METHODS } from '@/tools/debugger/debugger-manager';

const root = resolve(import.meta.dirname, '../..');
const SRC = resolve(root, 'src');

/** Every `.ts`/`.tsx` under `src/`, as path + contents. */
function sources(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      found.push({ path: relative(root, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(SRC);
  return found;
}

const ALL = sources();

/** Files containing a pattern, ignoring comment lines. */
function filesWith(pattern: RegExp): string[] {
  return ALL.filter(({ text }) =>
    text
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .some((line) => pattern.test(line)),
  ).map(({ path }) => path);
}

describe('there is one way in, and its receivers are counted', () => {
  it('has exactly three message receivers, and every one checks its sender', () => {
    // Worker router, content script, panel event channel. A fourth would be a
    // new way into the extension, and it would not be covered by the route
    // trust contract unless someone noticed it existed.
    const receivers = filesWith(/chrome\.runtime\.onMessage\.addListener/);
    expect(receivers.sort()).toEqual([
      'src/background/message-router.ts',
      'src/content/content-script.ts',
      'src/messaging/bus.ts',
    ]);
    for (const path of receivers) {
      const text = ALL.find((file) => file.path === path)!.text;
      expect(text, `${path} does not classify its sender`).toContain('classifySender');
    }
  });

  it('accepts no external connection of any kind', () => {
    expect(filesWith(/onMessageExternal|onConnectExternal/)).toEqual([]);
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8')) as {
      externally_connectable?: unknown;
    };
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it('classifies every panel route, with none reachable outside the panel', () => {
    for (const [route, routeClass] of Object.entries(PANEL_ROUTE_CLASSES)) {
      expect(
        ['CLASS_B_PANEL_CONTROL_PLANE', 'CLASS_E_PANEL_READ_ONLY'],
        `${route} is not a panel route`,
      ).toContain(routeClass);
    }
    expect(Object.keys(PANEL_ROUTE_CLASSES).length).toBeGreaterThanOrEqual(54);
  });
});

describe('there is one way to execute, and its callers are counted', () => {
  it('has exactly two callers of ToolRegistry.dispatch', () => {
    // The agent runtime, for a model's proposal, and the skill runner, for a
    // step inside a workflow. A third would be an execution path that had not
    // been reasoned about.
    const callers = filesWith(/\.dispatch\(\{/).filter(
      (path) => path !== 'src/tools/registry/tool-registry.ts',
    );
    expect(callers.sort()).toEqual([
      'src/agent/runtime/agent-runtime.ts',
      'src/skills/runtime/skill-runner.ts',
    ]);
  });

  it('has exactly one caller of ToolRegistry.unregister', () => {
    // `unregister` names a tool, so a caller that wanted to remove
    // `browser.click` could. What stops that is that there is one caller and it
    // matches on the `mcp__<server>__` prefix — which is a property of the
    // caller set, not of the method, so it is asserted here rather than trusted
    // to the method's doc comment.
    const callers = filesWith(/\.unregister\(/).filter(
      (path) => path !== 'src/tools/registry/tool-registry.ts',
    );
    expect(callers.sort()).toEqual(['src/mcp/core/mcp-registrar.ts']);
  });

  it('has exactly two callers of the egress gate', () => {
    const callers = filesWith(/authorizeEgress\(/).filter(
      (path) => path !== 'src/security/egress/egress-gate.ts',
    );
    expect(callers.sort()).toEqual([
      'src/security/egress/provider-transport.ts',
      'src/tools/registry/tool-registry.ts',
    ]);
  });

  it('holds no code-execution primitive anywhere in the source', () => {
    for (const pattern of [
      /\beval\(/,
      /new Function\(/,
      /Runtime\.evaluate/,
      /Runtime\.callFunctionOn/,
      /\binnerHTML\b/,
      /insertAdjacentHTML/,
      /document\.write\(/,
    ]) {
      expect(filesWith(pattern), String(pattern)).toEqual([]);
    }
  });

  it('injects a fixed file rather than a function or a string', () => {
    const injections = filesWith(/executeScript/);
    expect(injections).toEqual(['src/tools/browser/chrome-adapter.ts']);
    const text = ALL.find((file) => file.path === injections[0])!.text;
    expect(text).toContain("files: ['content-script.js']");
    expect(text).not.toMatch(/executeScript\([^)]*\bfunc\b/);
    expect(text).not.toMatch(/executeScript\([^)]*\bcode\b/);
  });

  it('reaches the network from exactly three guarded transports', () => {
    // Matched on the *reference*, not on a call. No transport writes `fetch(`
    // — each takes an injected implementation and the one primitive falls back
    // to `globalThis.fetch.bind(globalThis)` — so a pattern looking for a call
    // found none, and said so by passing with one file instead of several.
    // A structural test that can be satisfied by matching nothing is worse
    // than no test.
    //
    // This list is the point of the case, so growing it is a decision rather
    // than a fix. `mcp-transport.ts` joined it when P-026's client was built:
    // it is a *façade* over `guardedSend` in the same way the connector
    // transport is, adding MCP's own rules — no redirect is ever followed,
    // because nothing declared an origin to re-check a hop against — and
    // holding no HTTP client of its own. A fourth entry that did not reduce to
    // `guardedSend` would be a second authorization model, which is what this
    // case exists to catch.
    //
    // The interceptor is the last file, and it names these primitives in
    // order to replace them with refusals.
    const reachers = filesWith(
      /globalThis\.fetch|typeof fetch|fetchImpl|new WebSocket|XMLHttpRequest|sendBeacon|EventSource/,
    );
    expect(reachers.sort()).toEqual([
      'src/connectors/transport/connector-transport.ts',
      'src/mcp/transport/mcp-transport.ts',
      'src/security/egress/network-interceptor.ts',
      'src/security/egress/provider-transport.ts',
    ]);
  });

  it('routes every one of them through the single egress gate', () => {
    // The census above counts files that can touch a network primitive; this
    // says what each of them then does with it. A transport that reached the
    // network without `guardedSend` would pass the count and defeat its
    // purpose, so the two cases are deliberately separate.
    for (const path of [
      'src/connectors/transport/connector-transport.ts',
      'src/mcp/transport/mcp-transport.ts',
    ]) {
      const text = ALL.find((file) => file.path === path)?.text ?? '';
      expect(text, path).toContain('guardedSend');
      // `evaluateEgress` is the gate's own entry point. A transport calling it
      // directly would be deciding for itself what `guardedSend` decides for
      // everyone.
      expect(text, path).not.toContain('evaluateEgress');
    }
  });
});

describe('defaults point closed', () => {
  it('has no permissive `?? true` left in a security decision', () => {
    // The one this wave removed: a tool name with no validator used to be
    // trusted. The list is empty and is meant to stay that way — a new entry
    // is a decision someone should have to defend in review.
    const permissive = ALL.flatMap(({ path, text }) =>
      text
        .split('\n')
        .map((line, index) => ({ path, line: line.trim(), number: index + 1 }))
        .filter(
          ({ line }) =>
            /\?\?\s*true\b/.test(line) &&
            !/^\s*(\/\/|\*)/.test(line) &&
            !/\?\?\s*true\s*\)/.test(line),
        ),
    );
    expect(permissive.map((entry) => `${entry.path}:${entry.number} ${entry.line}`)).toEqual([]);
  });

  it('treats an unverifiable tool name as unverified', async () => {
    const { AuditLog, UNKNOWN_TOOL } = await import('@/audit/audit-log');
    const audit = new AuditLog(new SerializedStorageArea(new MemoryStorageArea()));
    await audit.record({
      type: 'tool.invoked',
      taskId: 'task_1',
      tool: 'browser.read_page',
      outcome: 'allowed',
    });
    expect((await audit.list())[0]?.tool).toBe(UNKNOWN_TOOL);
  });

  it('treats unknown taint as a reason to stop, not a reason to proceed', () => {
    const gate = ALL.find((file) => file.path === 'src/security/egress/egress-gate.ts')!.text;
    const unknown = gate.indexOf("request.taintState.kind === 'UNKNOWN'");
    expect(unknown).toBeGreaterThan(-1);
    // The branch refuses; it does not fall through to a permit.
    expect(gate.slice(unknown, unknown + 400)).toMatch(/BLOCK|DENY|refus|confirm/i);
  });

  it('starts persistence health at healthy and only ever raises it', async () => {
    const health = new PersistenceHealthStore(new SerializedStorageArea(new MemoryStorageArea()));
    expect((await health.snapshot()).blocked).toBe(false);
    await health.report('task-security', 'CORRUPT', 'x');
    await health.report('task-security', 'HEALTHY', 'x');
    expect((await health.snapshot()).gating).toBe('CORRUPT');
    expect(HEALTH_DOMAINS).toContain('audit');
  });
});

describe('state is scoped to the thing it belongs to', () => {
  it('keeps staged files behind a task key', () => {
    const store = ALL.find((file) => file.path === 'src/files/file-store.ts')!.text;
    expect(store).toContain('byTask');
    expect(store).toMatch(/get\(taskId: string, fileId: string\)/);
  });

  it('reads a provider credential by the provider being resolved', () => {
    const worker = ALL.find((file) => file.path === 'src/background/service-worker.ts')!.text;
    expect(worker).toContain('credentialStore.getApiKey(settings.activeProviderId)');
    expect(worker).toContain('credentialStore.getConfig(settings.activeProviderId)');
    // No call that fetches a key without naming whose it is.
    expect(worker).not.toMatch(/getApiKey\(\)/);
  });

  it('does not persist an egress consent grant across a restart', () => {
    // A grant that survived would outlive the context the user saw when
    // giving it. Re-asking after a restart is the conservative direction.
    const consent = ALL.find((file) => file.path === 'src/security/egress/consent.ts')!.text;
    expect(consent).toContain('Deliberately not persisted');
    expect(consent).not.toContain('chrome.storage');
  });

  it('keeps an evidence digest keyed per task', () => {
    const evidence = ALL.find((file) => file.path === 'src/evidence/evidence-model.ts')!.text;
    expect(evidence).toContain('per task');
  });
});

describe('the debugger reaches nothing that runs code', () => {
  it('allows no script-execution method', () => {
    for (const method of ALLOWED_CDP_METHODS) {
      expect(method, method).not.toMatch(/^Runtime\.(evaluate|callFunctionOn|compileScript)/);
      expect(method, method).not.toMatch(/^Debugger\./);
      expect(method, method).not.toMatch(/addScriptToEvaluateOnNewDocument/);
    }
  });

  it('accepts no method name from a tool argument', () => {
    const tools = ALL.filter(({ path }) => path.startsWith('src/tools/debugger/'));
    for (const { path, text } of tools) {
      expect(text, `${path} takes a CDP method as an argument`).not.toMatch(
        /method:\s*z\.string\(\)/,
      );
    }
  });
});

describe('the manifest is the one it was reviewed as', () => {
  it('holds exactly the permissions this build justifies', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8')) as {
      permissions: string[];
      optional_permissions: string[];
      host_permissions: string[];
      content_scripts: { all_frames: boolean; matches: string[] }[];
      web_accessible_resources: { resources: string[] }[];
      content_security_policy: { extension_pages: string };
    };
    expect(manifest.permissions).toEqual([
      'sidePanel',
      'storage',
      'unlimitedStorage',
      'tabs',
      'tabGroups',
      'scripting',
      'debugger',
      'notifications',
      'activeTab',
      'alarms',
    ]);
    expect(manifest.optional_permissions).toEqual(['downloads']);
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest.content_scripts[0]?.all_frames).toBe(false);
    expect(manifest.web_accessible_resources.flatMap((entry) => entry.resources)).toEqual([
      'oauth/callback.html',
    ]);
    // No `unsafe-eval`, which is what makes the interceptor enforceable.
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'",
    );
  });

  it('keeps the one web-accessible resource script-free', () => {
    const page = readFileSync(resolve(root, 'public/oauth/callback.html'), 'utf8');
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toContain('postMessage');
  });
});

describe('what a model can reach is a closed set', () => {
  it('exposes no tool for audit, policy, permission, consent or health', () => {
    const toolNames = ALL.filter(({ path }) => path.startsWith('src/tools/')).flatMap(({ text }) =>
      [...text.matchAll(/name: '([a-z_]+\.[a-z_]+)'/g)].map((match) => match[1]!),
    );
    for (const name of toolNames) {
      expect(name, name).not.toMatch(
        /^(audit|policy|permission|consent|health|shortcut|workflow)\./,
      );
    }
    expect(toolNames.length).toBeGreaterThan(25);
  });

  it('shares no name between a tool and a panel route', () => {
    const toolNames = new Set(
      ALL.filter(({ path }) => path.startsWith('src/tools/')).flatMap(({ text }) =>
        [...text.matchAll(/name: '([a-z_]+\.[a-z_]+)'/g)].map((match) => match[1]!),
      ),
    );
    for (const route of Object.keys(PANEL_ROUTE_CLASSES)) {
      expect(toolNames.has(route), `${route} is both a route and a tool`).toBe(false);
    }
  });
});

describe('the census table in docs/security.md is the census', () => {
  /*
   * The table says of itself: "A number here changing is either a deliberate
   * architectural decision — in which case the test is updated in the same
   * commit that makes it, and the reviewer sees both — or it is the thing this
   * file exists to catch."
   *
   * Nothing checked that. The Part 8 pass found the table saying nine manifest
   * permissions while the assertion below has listed ten for some time: a
   * permission arrived, the test was updated, and the prose was not — which is
   * precisely the drift the table claims to prevent. It is the same failure as
   * the README carrying a stale PASS fraction until the parity gate started
   * cross-checking it.
   *
   * So the numbers are read out of the document and compared against what this
   * file actually asserts. A row that drifts now fails here, in the suite the
   * row points at.
   */
  const DOC = readFileSync(resolve(root, 'docs/security.md'), 'utf8');

  function stated(fact: string): number {
    // The row is `| <fact> | <n> | <why> |`, and the fact contains backticks and
    // slashes, so it is matched literally rather than as a pattern.
    const row = DOC.split('\n').find((line) => line.startsWith('|') && line.includes(fact));
    expect(row, `docs/security.md has no census row for "${fact}"`).toBeDefined();
    const cells = (row as string).split('|').map((cell) => cell.trim());
    const value = Number(cells[2]);
    expect(Number.isInteger(value), `the count cell for "${fact}" is not a number`).toBe(true);
    return value;
  }

  it('states the same number of message receivers the suite asserts', () => {
    expect(stated('`chrome.runtime.onMessage` receivers')).toBe(
      filesWith(/chrome\.runtime\.onMessage\.addListener/).length,
    );
  });

  it('states the same number of manifest permissions the suite asserts', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8')) as {
      permissions: string[];
    };
    expect(stated('Permissions in the manifest')).toBe(manifest.permissions.length);
  });

  it('states the same number of files holding a network primitive', () => {
    // This row was stale too — the table said three while the census below has
    // asserted four since the MCP transport arrived. Two of six rows drifted,
    // which is why every row is bound here rather than the one that was noticed.
    expect(stated('Files holding a network primitive')).toBe(
      filesWith(
        /globalThis\.fetch|typeof fetch|fetchImpl|new WebSocket|XMLHttpRequest|sendBeacon|EventSource/,
      ).length,
    );
  });

  it('states the same number of dispatch, egress and unregister callers', () => {
    const excluding = (pattern: RegExp, self: string) =>
      filesWith(pattern).filter((path) => path !== self).length;

    expect(stated('Callers of `ToolRegistry.dispatch`')).toBe(
      excluding(/\.dispatch\(\{/, 'src/tools/registry/tool-registry.ts'),
    );
    expect(stated('Callers of `authorizeEgress`')).toBe(
      excluding(/authorizeEgress\(/, 'src/security/egress/egress-gate.ts'),
    );
    expect(stated('Callers of `ToolRegistry.unregister`')).toBe(
      excluding(/\.unregister\(/, 'src/tools/registry/tool-registry.ts'),
    );
  });

  it('states zero code-execution primitives, which is the one number that may not move', () => {
    // Every other row is a fact about this build. This one is a prohibition, so
    // a non-zero value in the document would be a claim the product does not
    // make rather than a stale count.
    expect(stated('Code-execution primitives anywhere in src/')).toBe(0);
  });
});

describe('the loopback predicate has one definition', () => {
  /*
   * There were six. Five were character-identical under three different names —
   * both provider adapters, the connector types, the MCP transport and the MCP
   * model — and the sixth, in `origin-validator.ts`, tested for `'::1'` where
   * the others tested for `'[::1]'`.
   *
   * That sixth is why this census exists rather than a note about tidiness.
   * `new URL('http://[::1]:8080').hostname` is `'[::1]'`, so the origin
   * validator's IPv6 case never matched and an IPv6 loopback page was treated as
   * insecure. It failed closed, which is why nothing caught it for as long as it
   * stood — and a duplicated security predicate that has already diverged once
   * will diverge again.
   *
   * Every use relaxes an https requirement, so the hazard is a future widening
   * applied to one copy and not the rest.
   */
  it('is defined in exactly one file', () => {
    const definitions = filesWith(/function isLoopback[A-Za-z]*\(/);
    expect(definitions).toEqual(['src/security/origin/origin-validator.ts']);
  });

  it('is spelled out nowhere else, under any name', () => {
    // The body rather than the name, because the next copy will be called
    // something else — as three of the six already were.
    const inline = filesWith(/hostname === '127\.0\.0\.1'/).filter(
      (path) => path !== 'src/security/origin/origin-validator.ts',
    );
    expect(inline).toEqual([]);
  });

  it('answers the same for both spellings of IPv6 loopback', () => {
    // The bug, as a test. A caller reading `URL.hostname` gets the bracketed
    // form and a caller holding a bare host does not, and a predicate that
    // disagreed with itself depending on where the string came from is how the
    // divergence happened.
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname(new URL('http://[::1]:8080/x').hostname)).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
  });

  it('stays narrow, because every use of it relaxes an https requirement', () => {
    // Widening this is a product decision about local model servers, and it
    // would be made here. Until it is, these are refusals rather than gaps.
    for (const host of [
      '127.0.0.2',
      '127.1.1.1',
      '0.0.0.0',
      'localhost.evil.test',
      'notlocalhost',
      'my-localhost',
      '2130706433',
      '',
    ]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });
});
