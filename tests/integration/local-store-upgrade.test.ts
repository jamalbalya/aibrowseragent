/**
 * TEST-SECURITY-047 — the three real stores, upgraded from the old layout.
 *
 * The generic migration behaviour is proved in `local-record-migration`. What
 * this adds is the part that only matters once: a profile that already holds
 * somebody's workflows, shortcuts and workspaces in the single-value layout
 * must come out the other side of an update with all of them, and with every
 * one of them still subject to the validation that governed it before.
 *
 * The stores are driven through their public API only. Nothing here reaches
 * into `RecordStore`, because a user's update does not either.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorageArea, NamespacedStorageArea } from '@/storage/storage-area';
import { ShortcutStore } from '@/shortcuts/shortcut-store';
import { WorkspaceStore } from '@/workspaces/workspace-store';
import { WorkflowStore } from '@/workflows/workflow-store';
import { SHORTCUT_FORMAT_VERSION } from '@/shortcuts/shortcut-model';

const NOW = 1_800_000_000_000;

function shortcutRecord(id: string, name: string): Record<string, unknown> {
  return {
    shortcutId: id,
    formatVersion: SHORTCUT_FORMAT_VERSION,
    displayName: name,
    name,
    skeleton: name,
    target: { kind: 'workflow', workflowId: 'wf_1' },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workspaceRecord(id: string, title: string): Record<string, unknown> {
  return {
    workspaceId: id,
    abaUserId: 'unassigned',
    title,
    members: [],
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

describe('upgrading a real profile to independent records', () => {
  it('01 — shortcuts move out of the blob and stay usable', async () => {
    const backing = new MemoryStorageArea();
    const area = new NamespacedStorageArea(backing, 'sc');
    await area.set('shortcuts', {
      shortcuts: [shortcutRecord('sc_1', 'book-table'), shortcutRecord('sc_2', 'file-expenses')],
    });

    const store = new ShortcutStore({ area, now: () => NOW });
    const listed = await store.list();

    expect(listed.map((s) => s.name)).toEqual(['book-table', 'file-expenses']);
    // Resolution still works, which is what a shortcut is for.
    expect((await store.find('book-table'))?.shortcutId).toBe('sc_1');
    // And each is now its own key.
    expect(await area.get('shortcuts:v1:sc_1')).not.toBeUndefined();
    expect(await area.get('shortcuts')).toBeUndefined();
  });

  it('02 — a shortcut carrying a prohibited field does not survive the upgrade', async () => {
    const backing = new MemoryStorageArea();
    const area = new NamespacedStorageArea(backing, 'sc');
    await area.set('shortcuts', {
      shortcuts: [
        shortcutRecord('sc_ok', 'keep-me'),
        // A definition on a shortcut is the thing `assertShortcutSafe` exists
        // to refuse. The upgrade must not be a way around it.
        { ...shortcutRecord('sc_bad', 'smuggled'), definition: { steps: [] } },
      ],
    });

    const listed = await new ShortcutStore({ area, now: () => NOW }).list();

    expect(listed.map((s) => s.name)).toEqual(['keep-me']);
  });

  it('03 — creating after an upgrade still refuses a colliding name', async () => {
    const backing = new MemoryStorageArea();
    const area = new NamespacedStorageArea(backing, 'sc');
    await area.set('shortcuts', { shortcuts: [shortcutRecord('sc_1', 'book-table')] });
    const store = new ShortcutStore({ area, now: () => NOW });

    // The upgraded records are visible to the collision check, so the
    // uniqueness property survives the move.
    await expect(
      store.create('Book table', { kind: 'workflow', workflowId: 'wf_2' }),
    ).rejects.toThrow(/already exists/);
  });

  it('04 — workspaces move out of the blob and keep their boundary', async () => {
    const durable = new NamespacedStorageArea(new MemoryStorageArea(), 'ws');
    await durable.set('workspaces', {
      workspaces: [workspaceRecord('ws_1', 'Research'), workspaceRecord('ws_2', 'Shopping')],
    });

    const store = new WorkspaceStore(durable, new MemoryStorageArea());
    const listed = await store.list();

    expect(listed.map((w) => w.title).sort()).toEqual(['Research', 'Shopping']);
    // Ownership scoping is unchanged by the move.
    expect(await store.listFor('unassigned')).toHaveLength(2);
    expect(await store.listFor('usr_someone_else')).toHaveLength(0);
    expect(await durable.get('workspaces')).toBeUndefined();
  });

  it('05 — a malformed workspace is left behind rather than rebuilt from defaults', async () => {
    const durable = new NamespacedStorageArea(new MemoryStorageArea(), 'ws');
    await durable.set('workspaces', {
      workspaces: [
        workspaceRecord('ws_1', 'Research'),
        // No title, no members: a fabricated replacement would be a scope
        // nobody configured, and a tab could be judged against it.
        { workspaceId: 'ws_broken', abaUserId: 'unassigned' },
      ],
    });

    const listed = await new WorkspaceStore(durable, new MemoryStorageArea()).list();

    expect(listed.map((w) => w.workspaceId)).toEqual(['ws_1']);
  });

  it('06 — deleting a workspace after the upgrade removes exactly one record', async () => {
    const durable = new NamespacedStorageArea(new MemoryStorageArea(), 'ws');
    await durable.set('workspaces', {
      workspaces: [workspaceRecord('ws_1', 'Research'), workspaceRecord('ws_2', 'Shopping')],
    });
    const store = new WorkspaceStore(durable, new MemoryStorageArea());
    await store.list();

    await store.remove('ws_1');

    expect((await store.list()).map((w) => w.workspaceId)).toEqual(['ws_2']);
    expect(await durable.get('workspace:v1:ws_1')).toBeUndefined();
    expect(await durable.get('workspace:v1:ws_2')).not.toBeUndefined();
  });

  it('07 — a workflow keeps the hash it was stored with, so integrity still means something', async () => {
    const area = new NamespacedStorageArea(new MemoryStorageArea(), 'workflows');
    const store = new WorkflowStore({ area, riskOfTool: () => 'R2', now: () => NOW });

    const saved = await store.save({
      name: 'Book a table',
      description: 'demo',
      definition: {
        id: 'wf',
        version: '1.0.0',
        name: 'Book a table',
        description: 'demo',
        provenance: 'recorded',
        risk: 'R2',
        inputs: [],
        outputs: [],
        requiredTools: ['browser.navigate'],
        requiredConnectors: [],
        steps: [
          {
            id: 'step_1',
            kind: 'tool',
            tool: 'browser.navigate',
            description: 'open the page',
            arguments: { url: { kind: 'literal', value: 'https://example.test' } },
          },
        ],
      },
      recordedFromTaskId: 'task-1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    // Read back through a second store instance, the way a restarted worker
    // would. The hash must still verify: nothing re-hashed it on the way.
    const reopened = new WorkflowStore({ area, riskOfTool: () => 'R2', now: () => NOW });
    const read = await reopened.get(saved.workflowId);

    expect(read?.definitionHash).toBe(saved.definitionHash);
    expect(await reopened.verifyIntegrity(read!)).toBe(true);
  });

  it('08 — a workflow whose definition was edited underneath still fails integrity', async () => {
    const backing = new MemoryStorageArea();
    const area = new NamespacedStorageArea(backing, 'workflows');
    const store = new WorkflowStore({ area, riskOfTool: () => 'R2', now: () => NOW });

    const saved = await store.save({
      name: 'Book a table',
      description: 'demo',
      definition: {
        id: 'wf',
        version: '1.0.0',
        name: 'Book a table',
        description: 'demo',
        provenance: 'recorded',
        risk: 'R2',
        inputs: [],
        outputs: [],
        requiredTools: ['browser.navigate'],
        requiredConnectors: [],
        steps: [
          {
            id: 'step_1',
            kind: 'tool',
            tool: 'browser.navigate',
            description: 'open the page',
            arguments: { url: { kind: 'literal', value: 'https://example.test' } },
          },
        ],
      },
      recordedFromTaskId: 'task-1',
      taintAtCapture: 'KNOWN_UNTAINTED',
    });

    // Tamper directly with storage: the record is now its own key, which is
    // exactly the surface this checks.
    const key = `workflows:workflows:v1:${saved.workflowId}`;
    const stored = await backing.get<{ v: number; record: Record<string, unknown> }>(key);
    const definition = stored!.record.definition as { steps: { arguments: { url: string } }[] };
    definition.steps[0]!.arguments.url = 'https://attacker.test';
    await backing.set(key, stored);

    const reopened = new WorkflowStore({ area, riskOfTool: () => 'R2', now: () => NOW });
    const read = await reopened.get(saved.workflowId);

    // Listed, and refused. Not hidden: a workflow that vanished would look
    // deleted rather than tampered with.
    expect(read).not.toBeUndefined();
    expect(await reopened.verifyIntegrity(read!)).toBe(false);
  });

  it('09 — an upgrade touches nothing under another key', async () => {
    const backing = new MemoryStorageArea();
    const area = new NamespacedStorageArea(backing, 'sc');
    await area.set('shortcuts', { shortcuts: [shortcutRecord('sc_1', 'book-table')] });
    await area.set('workflows', { workflows: [] });
    await area.set('app-settings', { theme: 'dark' });
    await area.set('conn:conn_1', 'sk-a-real-key');

    await new ShortcutStore({ area, now: () => NOW }).list();

    expect(await area.get('workflows')).toEqual({ workflows: [] });
    expect(await area.get('app-settings')).toEqual({ theme: 'dark' });
    expect(await area.get('conn:conn_1')).toBe('sk-a-real-key');
  });
});
