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

  it('reaches the network from exactly two guarded transports', () => {
    // Matched on the *reference*, not on a call. Neither transport writes
    // `fetch(` — both take an injected implementation and fall back to
    // `globalThis.fetch.bind(globalThis)` — so a pattern looking for a call
    // found neither, and said so by passing with one file instead of three.
    // A structural test that can be satisfied by matching nothing is worse
    // than no test.
    //
    // The interceptor is the third file, and it names these primitives in
    // order to replace them with refusals.
    const reachers = filesWith(
      /globalThis\.fetch|typeof fetch|fetchImpl|new WebSocket|XMLHttpRequest|sendBeacon|EventSource/,
    );
    expect(reachers.sort()).toEqual([
      'src/connectors/transport/connector-transport.ts',
      'src/security/egress/network-interceptor.ts',
      'src/security/egress/provider-transport.ts',
    ]);
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
