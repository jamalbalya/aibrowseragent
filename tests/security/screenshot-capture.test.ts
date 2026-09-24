/**
 * TEST-SECURITY-007 — Screenshot capture boundary (REQ-SECURITY-003, §68).
 *
 * A screenshot is the widest-reaching read the agent has: whatever the page
 * renders becomes stored evidence. Two properties are enforced here.
 *
 * 1. The capture only ever reaches an automatable page. The scheme gate runs
 *    *before* the debugger attaches, so a blocked page is never even
 *    instrumented — not attached-then-refused.
 * 2. The tool never reports success for a capture it cannot vouch for. A
 *    failed, empty, or malformed capture produces an error and no evidence;
 *    a corrupt image filed as evidence would read as a record of what the
 *    page showed.
 *
 * The capture runs over the DevTools protocol rather than
 * `chrome.tabs.captureVisibleTab`, because `captureVisibleTab` demands the
 * literal `<all_urls>` host permission. Granting it was measured to also give
 * the extension read access to local files. `Page.captureScreenshot` needs no
 * host permission, so the manifest stays narrow and Chrome's own boundary
 * against `file://` stays in place; the manifest test at the bottom keeps the
 * pattern from creeping back.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { FakeDebuggerPort, TINY_PNG_BASE64 } from '../fixtures/fake-debugger';
import { DebuggerManager } from '@/tools/debugger/debugger-manager';
import { createHarness, ScriptedPrompter, type Harness } from '../fixtures/policy-harness';
import { FieldObservationStore } from '@/policy/field-observation-store';

let adapter: FakeBrowserAdapter;
let port: FakeDebuggerPort;
let harness: Harness;

function build(options: ConstructorParameters<typeof FakeDebuggerPort>[0] = {}): void {
  adapter = new FakeBrowserAdapter();
  port = new FakeDebuggerPort(options);
  harness = createHarness(
    createBrowserTools({
      fieldObservations: new FieldObservationStore(),
      adapter,
      debuggerManager: new DebuggerManager(port),
    }),
    { prompter: new ScriptedPrompter({ kind: 'approve_once' }) },
  );
}

const shoot = (extra: Record<string, unknown> = {}) =>
  harness.registry.dispatch({
    toolCallId: 'tc_1',
    taskId: 'task_1',
    sessionId: 's1',
    name: 'browser.screenshot',
    arguments: {},
    tabId: 1,
    signal: new AbortController().signal,
    ...extra,
  });

/** True when nothing was captured and no debugger session was left behind. */
function capturedNothing(): boolean {
  return (
    !port.sent.some((call) => call.method === 'Page.captureScreenshot') && port.attached.size === 0
  );
}

beforeEach(() => {
  build();
});

describe('pages the capture is allowed to reach', () => {
  it('captures an https page and files the image as evidence', async () => {
    adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });

    const result = await shoot();

    expect(result.envelope.status).toBe('success');
    expect(result.evidence[0]?.type).toBe('SCREENSHOT');
    expect(result.evidence[0]?.origin).toBe('https://example.com/');
    expect(port.sent.map((call) => call.method)).toContain('Page.captureScreenshot');
  });

  it('captures a localhost http page, the one insecure origin that is automatable', async () => {
    adapter.addTab({ id: 1, url: 'http://localhost:3000/app', title: 'Dev', active: true });

    const result = await shoot();

    expect(result.envelope.status).toBe('success');
    expect(result.evidence).toHaveLength(1);
  });

  it('refuses a plain http page, which needs the insecure-origins setting', async () => {
    // http:// is inside the manifest's host permissions but outside what the
    // tool layer automates by default, so the capture stops here.
    adapter.addTab({ id: 1, url: 'http://example.com/', title: 'Insecure', active: true });

    const result = await shoot();

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.evidence).toHaveLength(0);
    expect(capturedNothing()).toBe(true);
  });
});

describe('pages the capture must never reach', () => {
  it.each([
    ['a local file', 'file:///etc/hostname'],
    ['a local directory listing', 'file:///home/'],
    ['an FTP resource', 'ftp://files.example.com/private.txt'],
    ["another extension's page", 'chrome-extension://abcdefghijklmnop/options.html'],
    ['browser settings', 'chrome://settings/passwords'],
    ['the extension gallery', 'https://chromewebstore.google.com/detail/x'],
    ['a devtools page', 'devtools://devtools/bundled/inspector.html'],
    ['view-source', 'view-source:https://example.com/'],
    ['a data URL', 'data:text/html,<h1>hi</h1>'],
    ['an about page', 'about:blank'],
    ['an unsupported scheme', 'mailto:someone@example.com'],
  ])('refuses to photograph %s', async (_label, url) => {
    adapter.addTab({ id: 1, url, title: 'Blocked', active: true });

    const result = await shoot();

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('POLICY_BLOCKED');
    expect(result.evidence).toHaveLength(0);
  });

  it('never attaches the debugger to a file:// tab', async () => {
    // The scheme gate has to run before attachment. Attaching first would put
    // Chrome's debugging banner on a local file and hand the extension a live
    // CDP session against it, whatever the tool did next.
    adapter.addTab({ id: 1, url: 'file:///etc/shadow', title: 'shadow', active: true });

    await shoot();

    expect(capturedNothing()).toBe(true);
    expect(port.sent).toHaveLength(0);
  });

  it('refuses a tab that no longer exists rather than capturing another', async () => {
    adapter.addTab({ id: 2, url: 'https://example.com/', active: true });

    const result = await shoot();

    expect(result.envelope.error?.code).toBe('TAB_NOT_FOUND');
    expect(capturedNothing()).toBe(true);
  });
});

describe('a page that moved after the action was authorised', () => {
  it('refuses to capture a cross-origin page instead of the authorised one', async () => {
    adapter.addTab({ id: 1, url: 'https://attacker.example/', title: 'Elsewhere', active: true });

    const result = await shoot({ plannedUrl: 'https://bank.example/account' });

    expect(result.envelope.error?.code).toBe('ORIGIN_CHANGED');
    expect(result.evidence).toHaveLength(0);
    expect(capturedNothing()).toBe(true);
  });

  it('refuses a page that navigated from https to a local file', async () => {
    adapter.addTab({ id: 1, url: 'file:///etc/hostname', active: true });

    const result = await shoot({ plannedUrl: 'https://example.com/' });

    expect(result.envelope.status).toBe('error');
    expect(result.evidence).toHaveLength(0);
    expect(capturedNothing()).toBe(true);
  });

  it('still captures when the page only moved within the authorised origin', async () => {
    adapter.addTab({ id: 1, url: 'https://example.com/other', active: true });

    const result = await shoot({ plannedUrl: 'https://example.com/start' });

    expect(result.envelope.status).toBe('success');
  });
});

describe('how the permission layer treats a capture', () => {
  // Recorded rather than asserted from memory: browser.screenshot is R0, the
  // same as every debugger tool, so the permission engine auto-approves it in
  // manual, auto and skip alike. The capture's boundary is therefore the
  // scheme and origin gate above, not a prompt — which is why those tests
  // assert that nothing is even attached on a blocked page. The visible
  // control the user gets is Chrome's own debugging banner, which the tool
  // declares through `requires_debugger`.
  it('declares itself as a debugger-attaching, read-only action', () => {
    const tool = createBrowserTools({
      fieldObservations: new FieldObservationStore(),
      adapter: new FakeBrowserAdapter(),
      debuggerManager: new DebuggerManager(new FakeDebuggerPort()),
    }).find((candidate) => candidate.name === 'browser.screenshot');

    expect(tool?.risk).toBe('R0');
    expect(tool?.executionMode).toBe('requires_debugger');
    expect(tool?.sideEffects?.join(' ')).toMatch(/debugger/i);
  });

  it('is still allowed in manual mode, because it changes nothing on the page', async () => {
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });
    harness.prompter.setResponse({ kind: 'deny' });
    harness.setMode('manual');

    const result = await shoot();

    // No prompt was raised, so the scripted denial never applied.
    expect(harness.prompter.seen).toHaveLength(0);
    expect(result.envelope.status).toBe('success');
  });

  it('refuses before capturing when the action is aborted', async () => {
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });
    const controller = new AbortController();
    controller.abort();

    const result = await shoot({ signal: controller.signal });

    expect(result.envelope.status).toBe('error');
    expect(result.evidence).toHaveLength(0);
    expect(capturedNothing()).toBe(true);
  });
});

describe('when the capture itself fails', () => {
  it('reports the failure and stores nothing when Chrome refuses to attach', async () => {
    build({ attachError: new Error('Cannot attach to this target.') });
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });

    const result = await shoot();

    expect(result.envelope.status).toBe('error');
    expect(result.envelope.error?.code).toBe('DEBUGGER_UNAVAILABLE');
    expect(result.evidence).toHaveLength(0);
  });

  it('does not leak Chrome internals into the error the model sees', async () => {
    build({
      respond: (method) => {
        if (method === 'Page.captureScreenshot') {
          throw new Error('failed at /home/user/.config/chrome/Default/Cookies');
        }
        return undefined;
      },
    });
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });

    const result = await shoot();

    expect(result.envelope.status).toBe('error');
    expect(JSON.stringify(result.envelope)).not.toContain('/home/user/.config');
  });

  it.each([
    ['an absent payload', {}],
    ['an empty string', { data: '' }],
    ['a non-string payload', { data: 42 }],
    ['text that is not base64', { data: 'not a png!!' }],
    ['base64 of something that is not a PNG', { data: 'aGVsbG8gd29ybGQ=' }],
    ['a truncated PNG payload', { data: 'iVBORw0KGgoAAA' }],
    ['a data URL rather than raw base64', { data: `data:image/png;base64,${TINY_PNG_BASE64}` }],
  ])('rejects %s instead of filing it as evidence', async (_label, reply) => {
    build({ respond: (method) => (method === 'Page.captureScreenshot' ? reply : undefined) });
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });

    const result = await shoot();

    // It must never silently report success: a corrupt image stored as
    // evidence looks like a truthful record of the page.
    expect(result.envelope.status).toBe('error');
    expect(result.envelope.result).toBeUndefined();
    expect(result.envelope.error?.code).toBe('INTERNAL_ERROR');
    expect(result.evidence).toHaveLength(0);
  });

  it('leaves no debugger session behind after a rejected capture', async () => {
    build({
      respond: (method) => (method === 'Page.captureScreenshot' ? { data: 'x' } : undefined),
    });
    adapter.addTab({ id: 1, url: 'https://example.com/', active: true });

    await shoot();

    expect(port.attached.size).toBe(0);
    expect(port.detachCount).toBeGreaterThan(0);
  });
});

describe('the shipped manifest', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, '../../public/manifest.json'), 'utf8'),
  ) as {
    host_permissions?: string[];
    permissions?: string[];
    optional_permissions?: string[];
    content_scripts?: { matches?: string[] }[];
  };

  it('does not request <all_urls>', () => {
    // Measured, not assumed: under <all_urls>, executeScript against a
    // file:// tab returned the file's contents; under http + https Chrome
    // refused with "Cannot access contents of url". The narrow manifest is
    // what keeps that refusal in place.
    const everywhere = [
      ...(manifest.host_permissions ?? []),
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ];
    expect(everywhere).not.toContain('<all_urls>');
  });

  it('limits host access to http and https', () => {
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });

  it('never requests a file or ftp host pattern', () => {
    const patterns = [
      ...(manifest.host_permissions ?? []),
      ...(manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []),
    ];
    for (const pattern of patterns) {
      expect(pattern.startsWith('file:')).toBe(false);
      expect(pattern.startsWith('ftp:')).toBe(false);
      expect(pattern.startsWith('*://')).toBe(false);
    }
  });
});
