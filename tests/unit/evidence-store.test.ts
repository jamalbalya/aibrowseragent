/**
 * TEST-EVIDENCE-001 — Evidence model and store (REQ-EVIDENCE-001).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { EvidenceStore } from '@/evidence/evidence-store';
import { hashContent, type EvidenceReference } from '@/evidence/evidence-model';

let store: EvidenceStore;
let area: SerializedStorageArea;

const reference = (overrides: Partial<EvidenceReference> = {}) => ({
  id: 'ev_1',
  type: 'DOM' as const,
  taskId: 'task_1',
  toolCallId: 'tc_1',
  sourceTool: 'browser.read_page',
  createdAt: 1000,
  sensitivity: 'internal' as const,
  trust: 'untrusted_external_content' as const,
  origin: 'https://example.com/',
  label: 'Page model',
  ...overrides,
});

beforeEach(() => {
  area = new SerializedStorageArea(new MemoryStorageArea());
  store = new EvidenceStore(area);
});

describe('EvidenceStore', () => {
  it('stores a reference and its payload separately', async () => {
    const saved = await store.put(reference(), {
      content: 'Page contents',
      encoding: 'utf8',
      mimeType: 'text/plain',
    });

    expect(saved.byteLength).toBe('Page contents'.length);
    expect(saved.hash).toBe(await hashContent('Page contents'));
    expect((await store.getReference('ev_1'))?.label).toBe('Page model');
    expect((await store.getPayload('ev_1'))?.content).toBe('Page contents');
  });

  it('redacts secrets from a text payload before storing it', async () => {
    // Evidence is displayed and can be attached to a bug report, so a
    // credential must never reach storage in the first place.
    await store.put(reference(), {
      content: 'Authorization: Bearer abc123def456ghi789jkl',
      encoding: 'utf8',
      mimeType: 'text/plain',
    });

    const payload = await store.getPayload('ev_1');
    expect(payload?.content).toContain('[REDACTED]');
    expect(payload?.content).not.toContain('abc123def456ghi789jkl');
  });

  it('does not corrupt a base64 payload by redacting it', async () => {
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await store.put(reference({ type: 'SCREENSHOT' }), {
      content: base64,
      encoding: 'base64',
      mimeType: 'image/png',
    });

    expect((await store.getPayload('ev_1'))?.content).toBe(base64);
  });

  it('truncates an oversized payload to the configured cap', async () => {
    const small = new EvidenceStore(area, { maxPayloadBytes: 100 });
    const saved = await small.put(reference(), {
      content: 'x'.repeat(5000),
      encoding: 'utf8',
      mimeType: 'text/plain',
    });

    expect(saved.byteLength).toBe(100);
    expect((await small.getPayload('ev_1'))?.content).toHaveLength(100);
  });

  it('lists evidence for a task without returning other tasks evidence', async () => {
    await store.put(reference({ id: 'ev_1', taskId: 'task_1' }), {
      content: 'a',
      encoding: 'utf8',
      mimeType: 'text/plain',
    });
    await store.put(reference({ id: 'ev_2', taskId: 'task_2' }), {
      content: 'b',
      encoding: 'utf8',
      mimeType: 'text/plain',
    });

    const items = await store.listForTask('task_1');
    expect(items.map((item) => item.id)).toEqual(['ev_1']);
  });

  it('evicts the oldest evidence past the retention cap', async () => {
    const small = new EvidenceStore(area, { maxItems: 3 });
    for (let i = 0; i < 6; i += 1) {
      await small.put(reference({ id: `ev_${i}` }), {
        content: `item ${i}`,
        encoding: 'utf8',
        mimeType: 'text/plain',
      });
    }

    expect(await small.getReference('ev_0')).toBeUndefined();
    // The payload goes with the reference; no orphans are left behind.
    expect(await small.getPayload('ev_0')).toBeUndefined();
    expect(await small.getReference('ev_5')).toBeDefined();
  });

  it('returns undefined for evidence that does not exist', async () => {
    expect(await store.getReference('missing')).toBeUndefined();
    expect(await store.getPayload('missing')).toBeUndefined();
  });

  it('records provenance so evidence is traceable to its tool call', async () => {
    const saved = await store.put(reference(), {
      content: 'x',
      encoding: 'utf8',
      mimeType: 'text/plain',
    });

    expect(saved.taskId).toBe('task_1');
    expect(saved.toolCallId).toBe('tc_1');
    expect(saved.sourceTool).toBe('browser.read_page');
    expect(saved.trust).toBe('untrusted_external_content');
    expect(saved.origin).toBe('https://example.com/');
  });
});

describe('hashContent', () => {
  it('produces a stable SHA-256 hex digest', async () => {
    const hash = await hashContent('hello');
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(await hashContent('hello')).toBe(hash);
  });

  it('differs for different content', async () => {
    expect(await hashContent('a')).not.toBe(await hashContent('b'));
  });
});
