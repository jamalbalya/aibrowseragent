/**
 * TEST-EVIDENCE-002 — Evidence is actually retrievable (REQ-EVIDENCE-002).
 *
 * An evidence reference with no stored payload is worse than no evidence: the
 * UI shows an item that cannot be opened, and the product claims a record it
 * does not have. This suite runs a real tool through the real registry and
 * then reads the evidence back out of the store.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryStorageArea,
  NamespacedStorageArea,
  SerializedStorageArea,
} from '@/storage/storage-area';
import { EvidenceStore } from '@/evidence/evidence-store';
import { ToolRegistry } from '@/tools/registry/tool-registry';
import { PermissionEngine } from '@/policy/permission-engine';
import { emptySitePolicyState, type SitePolicyState } from '@/policy/site-policy';
import { createBrowserTools } from '@/tools/browser/browser-tools';
import { createDebuggerTools } from '@/tools/debugger/debugger-tools';
import { DebuggerManager } from '@/tools/debugger/debugger-manager';
import { FakeBrowserAdapter } from '../fixtures/fake-browser';
import { ScriptedPrompter } from '../fixtures/policy-harness';
import type { SemanticPage } from '@/content/semantic-tree';

const page: SemanticPage = {
  url: 'https://example.com/',
  title: 'Example',
  generation: 1,
  capturedAt: 1,
  readyState: 'complete',
  text: 'The quarterly figures are attached.',
  textTruncated: false,
  elements: [
    {
      elementId: 'e1-0',
      role: 'button',
      name: 'Download',
      visible: true,
      enabled: true,
      selectorHints: [],
      frameId: 'main',
    },
  ],
  elementsTruncated: false,
  scrollY: 0,
  documentHeight: 100,
  viewportHeight: 100,
};

let store: EvidenceStore;
let registry: ToolRegistry;
let adapter: FakeBrowserAdapter;
let debuggerManager: DebuggerManager;

const dispatch = (name: string, args: Record<string, unknown> = {}) =>
  registry.dispatch({
    toolCallId: 'tc_1',
    taskId: 'task_1',
    sessionId: 's1',
    name,
    arguments: args,
    tabId: 1,
    signal: new AbortController().signal,
  });

beforeEach(() => {
  const backing = new SerializedStorageArea(new MemoryStorageArea());
  store = new EvidenceStore(new NamespacedStorageArea(backing, 'evidence'));

  let sitePolicy: SitePolicyState = emptySitePolicyState();
  const permissionEngine = new PermissionEngine({
    prompter: new ScriptedPrompter({ kind: 'approve_once' }),
    loadSitePolicy: () => Promise.resolve(sitePolicy),
    saveSitePolicy: (next) => {
      sitePolicy = next;
      return Promise.resolve();
    },
  });

  adapter = new FakeBrowserAdapter();
  adapter.addTab({ id: 1, url: 'https://example.com/', title: 'Example', active: true });
  adapter.onContent((type) => (type === 'content.readPage' ? { page } : {}));

  debuggerManager = new DebuggerManager({
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    sendCommand: () => Promise.resolve({}),
    onEvent: { addListener: () => undefined, removeListener: () => undefined },
    onDetach: { addListener: () => undefined, removeListener: () => undefined },
  });

  registry = new ToolRegistry({
    permissionEngine,
    loadPolicyContext: () => Promise.resolve({ mode: 'auto', sitePolicy }),
    evidenceStore: store,
  });
  registry.registerAll(createBrowserTools({ adapter }));
  registry.registerAll(createDebuggerTools({ adapter, manager: debuggerManager }));
});

describe('browser.read_page evidence', () => {
  it('stores a payload that can actually be read back', async () => {
    const result = await dispatch('browser.read_page');
    const reference = result.evidence[0]!;

    const stored = await store.getReference(reference.id);
    const payload = await store.getPayload(reference.id);

    expect(stored).toBeDefined();
    expect(payload?.content).toContain('The quarterly figures are attached.');
    expect(payload?.mimeType).toBe('application/json');
  });

  it('completes the reference with a size and an integrity hash', async () => {
    const result = await dispatch('browser.read_page');
    const reference = result.evidence[0]!;

    expect(reference.byteLength).toBeGreaterThan(0);
    expect(reference.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists the evidence under its task', async () => {
    await dispatch('browser.read_page');
    await dispatch('browser.screenshot');

    const items = await store.listForTask('task_1');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.type).sort()).toEqual(['DOM', 'SCREENSHOT']);
  });

  it('traces each item back to the tool call that produced it', async () => {
    const result = await dispatch('browser.read_page');
    const reference = result.evidence[0]!;

    expect(reference.taskId).toBe('task_1');
    expect(reference.toolCallId).toBe('tc_1');
    expect(reference.sourceTool).toBe('browser.read_page');
    expect(reference.origin).toBe('https://example.com/');
    expect(reference.trust).toBe('untrusted_external_content');
  });
});

describe('browser.screenshot evidence', () => {
  it('stores the image bytes intact', async () => {
    const result = await dispatch('browser.screenshot');
    const payload = await store.getPayload(result.evidence[0]!.id);

    expect(payload?.encoding).toBe('base64');
    expect(payload?.mimeType).toBe('image/png');
    // The FakeBrowserAdapter returns "data:image/png;base64,AAAA".
    expect(payload?.content).toBe('AAAA');
  });

  it('returns the evidence id in the tool result so the model can cite it', async () => {
    const result = await dispatch('browser.screenshot');
    const data = result.envelope.result as { evidenceId: string };
    expect(data.evidenceId).toBe(result.evidence[0]!.id);
  });
});

describe('redaction on the evidence path', () => {
  it('removes a credential from page text before it is stored', async () => {
    adapter.onContent(() => ({
      page: { ...page, text: `Support token: ${'sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz01'}` },
    }));

    const result = await dispatch('browser.read_page');
    const payload = await store.getPayload(result.evidence[0]!.id);

    expect(payload?.content).toContain('[REDACTED]');
    expect(payload?.content).not.toContain('sk-' + 'ant-api03-abcdefghijklmnop');
  });
});

describe('evidence on a failure', () => {
  it('keeps evidence captured before the tool failed', async () => {
    // Evidence gathered before a failure is often what explains it.
    let calls = 0;
    adapter.onContent((type) => {
      calls += 1;
      if (type === 'content.readPage' && calls > 1)
        return new Error('Receiving end does not exist.');
      return { page };
    });

    const ok = await dispatch('browser.read_page');
    expect(ok.evidence).toHaveLength(1);

    const failed = await dispatch('browser.read_page');
    expect(failed.envelope.status).toBe('error');
    // The first item is still readable afterwards.
    expect(await store.getPayload(ok.evidence[0]!.id)).toBeDefined();
  });
});

describe('without a configured store', () => {
  it('still returns references rather than dropping them silently', async () => {
    const storeless = new ToolRegistry({
      permissionEngine: new PermissionEngine({
        prompter: new ScriptedPrompter({ kind: 'approve_once' }),
        loadSitePolicy: () => Promise.resolve(emptySitePolicyState()),
        saveSitePolicy: () => Promise.resolve(),
      }),
      loadPolicyContext: () =>
        Promise.resolve({ mode: 'auto', sitePolicy: emptySitePolicyState() }),
    });
    storeless.registerAll(createBrowserTools({ adapter }));

    const result = await storeless.dispatch({
      toolCallId: 'tc_1',
      taskId: 'task_1',
      sessionId: 's1',
      name: 'browser.read_page',
      arguments: {},
      tabId: 1,
      signal: new AbortController().signal,
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.byteLength).toBeGreaterThan(0);
  });
});
