/**
 * TEST-SECURITY-045 — the local-first boundary.
 *
 * The product claim is specific: **a fresh installation works completely, with
 * no account, no backend, no database and nothing uploaded.** That is a claim
 * about what does *not* happen, and claims of that shape rot quietly — a
 * single new import, a single new default, and the extension acquires a
 * dependency nobody meant it to have.
 *
 * So every item here is enforced against the repository or against real
 * behaviour, not against a document. The ones that check for the *absence* of
 * something read the actual source tree, because that is the only thing that
 * can fail when somebody adds the dependency back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MemoryStorageArea } from '@/storage/storage-area';
import { DataStoragePreferenceStore } from '@/storage/data-storage-preference';
import {
  cloudEligible,
  DEFAULT_STORAGE_MODE,
  isSecret,
  PERSISTED_DATA_KINDS,
  resolveStorageMode,
  STORAGE_MODES,
} from '@/storage/data-classification';
import { TaskStore } from '@/tasks/task-store';
import { createTask } from '@/tasks/task-model';
import { WorkspaceStore } from '@/workspaces/workspace-store';
import { ShortcutStore } from '@/shortcuts/shortcut-store';
import { NamespacedStorageArea } from '@/storage/storage-area';

const ROOT = resolve(__dirname, '../..');

/** Every source file under a directory, recursively. */
function sourceFiles(dir: string, extensions = ['.ts', '.tsx']): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path, extensions));
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

const EXTENSION_SOURCES = sourceFiles(join(ROOT, 'src'));

describe('local-first: the extension needs no backend', () => {
  it('01 — a fresh installation is in local mode and has chosen nothing', async () => {
    const preference = new DataStoragePreferenceStore(new MemoryStorageArea());

    expect(await preference.mode()).toBe('local');
    expect(await preference.hasChosen()).toBe(false);
    expect(DEFAULT_STORAGE_MODE).toBe('local');
  });

  it('02 — local mode makes every data kind ineligible for upload', () => {
    // Not "no sync client exists, so nothing uploads" — that is an argument
    // about today's code. This is the gate itself, asked about every kind.
    for (const kind of PERSISTED_DATA_KINDS) {
      expect(cloudEligible(kind, 'local')).toBe(false);
    }
  });

  it('03 — a provider API key is never eligible for upload, in either mode', () => {
    for (const mode of STORAGE_MODES) {
      expect(cloudEligible('provider-credential', mode)).toBe(false);
      expect(cloudEligible('connector-token', mode)).toBe(false);
      expect(cloudEligible('aba-refresh-token', mode)).toBe(false);
    }
    expect(isSecret('provider-credential')).toBe(true);
  });

  it('04 — page content is never eligible for upload, in either mode', () => {
    for (const mode of STORAGE_MODES) {
      expect(cloudEligible('page-content', mode)).toBe(false);
    }
  });

  it('05 — a model response has no persisted kind at all, so none can leave', () => {
    // There is deliberately no `model-response` kind. Responses are never
    // persisted, so there is nothing for a sync path to pick up. If one is
    // ever added it must be classified, and this is where that is noticed.
    expect(PERSISTED_DATA_KINDS).not.toContain('model-response');
    expect(PERSISTED_DATA_KINDS).not.toContain('prompt');
  });

  it('06 — cloud mode cannot be reached by a corrupt, absent or legacy record', async () => {
    const area = new MemoryStorageArea();
    const preference = new DataStoragePreferenceStore(area);

    for (const stored of [
      undefined,
      null,
      'cloud',
      { mode: 'undecided' },
      { mode: 'CLOUD' },
      { mode: 'anything-else' },
      { mode: 42 },
      { chosenAt: Date.now() },
      [],
    ]) {
      if (stored === undefined) await area.remove('data-storage-mode');
      else await area.set('data-storage-mode', stored);
      expect(await preference.mode()).toBe('local');
    }

    // Only a well-formed, explicit choice gets there.
    await preference.choose('cloud', 1_800_000_000_000);
    expect(await preference.mode()).toBe('cloud');
  });

  it('07 — a legacy undecided record keeps local and does not claim a choice', async () => {
    const area = new MemoryStorageArea();
    await area.set('data-storage-mode', {
      mode: 'undecided',
      chosenAt: 1_700_000_000_000,
      dismissedAt: null,
    });

    const preference = await new DataStoragePreferenceStore(area).get();

    expect(preference.mode).toBe('local');
    // The user never chose local — the old build defaulted them there. Saying
    // they chose it would misreport consent they did not give.
    expect(preference.chosenAt).toBeNull();
  });

  it('08 — tasks survive with no backend reachable at all', async () => {
    const store = new TaskStore(new MemoryStorageArea());
    const task = createTask({
      id: 't1',
      sessionId: 's1',
      objective: 'book a table',
      providerId: 'openai-compatible',
      modelId: 'mock-model',
      permissionMode: 'manual',
      now: 1,
    });

    await store.saveTask(task);

    // No network was configured, no origin was set, no account exists.
    expect((await store.getTask('t1'))?.objective).toBe('book a table');
  });

  it('09 — workspaces survive with no backend reachable at all', async () => {
    const durable = new MemoryStorageArea();
    const store = new WorkspaceStore(durable, new MemoryStorageArea(), {
      newId: () => 'ws_1',
    });

    await store.put({
      workspaceId: 'ws_1',
      abaUserId: 'unassigned',
      title: 'Research',
      members: [],
      createdAt: 1,
      lastActiveAt: 1,
    });

    expect((await store.list()).map((w) => w.title)).toEqual(['Research']);
  });

  it('10 — shortcuts survive with no backend reachable at all', async () => {
    const store = new ShortcutStore({
      area: new NamespacedStorageArea(new MemoryStorageArea(), 'shortcuts'),
      now: () => 1,
    });

    await store.create('Book table', { kind: 'workflow', workflowId: 'wf_1' });

    expect((await store.list()).map((s) => s.name)).toEqual(['book-table']);
  });

  it('11 — the extension imports nothing from server/', () => {
    // The one mechanical guarantee that the backend cannot end up in the
    // shipped bundle. A relative climb out of src/ counts too.
    const offenders = EXTENSION_SOURCES.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /from\s+['"]@server\//.test(text) || /from\s+['"](?:\.\.\/)+server\//.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('12 — no database or container dependency exists in package.json', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    });

    // A driver is what would make PostgreSQL a real requirement rather than a
    // deployment target. None is installed, and this is what keeps it so.
    for (const forbidden of [
      'pg',
      'postgres',
      'pg-promise',
      'node-postgres',
      'better-sqlite3',
      'sqlite3',
      'mongodb',
      'mongoose',
      'redis',
      'ioredis',
      'mysql',
      'mysql2',
      'dockerode',
      'testcontainers',
    ]) {
      expect(installed).not.toContain(forbidden);
    }
  });

  it('13 — no PostgreSQL requirement reaches the extension source', () => {
    const offenders = EXTENSION_SOURCES.filter((file) =>
      /postgres|DATABASE_URL|PGHOST|PGUSER|PGPASSWORD/i.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('14 — no docker-compose or database setup file exists in the repository', () => {
    const forbidden = [
      'docker-compose.yml',
      'docker-compose.yaml',
      'compose.yml',
      'compose.yaml',
      'Dockerfile',
    ];
    const present = forbidden.filter((name) => {
      try {
        statSync(join(ROOT, name));
        return true;
      } catch {
        return false;
      }
    });
    expect(present).toEqual([]);
  });

  it('15 — no test needs a database or a container to run', () => {
    // Asserted over the suite itself. A test that opened a connection would
    // make `npm test` require infrastructure, which is exactly the thing the
    // owner must never have to operate.
    const offenders = sourceFiles(join(ROOT, 'tests')).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        /require\(['"]pg['"]\)|from\s+['"]pg['"]/.test(text) ||
        /docker\s+(run|compose)/.test(text) ||
        /new\s+(Client|Pool)\(/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('16 — local persistence introduces no network primitive', () => {
    // §14.12. The storage layer must never acquire one: a store that could
    // reach the network is a store that could upload, whatever the mode says.
    const storageFiles = sourceFiles(join(ROOT, 'src/storage'));
    expect(storageFiles.length).toBeGreaterThan(0);

    for (const file of storageFiles) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(
        /globalThis\.fetch|\bnew WebSocket\b|XMLHttpRequest|sendBeacon|EventSource/,
      );
    }
  });

  it('17 — resolveStorageMode is total and never returns a third state', () => {
    for (const input of [undefined, null, '', 'local', 'cloud', 'undecided', 0, {}, []]) {
      expect(STORAGE_MODES).toContain(resolveStorageMode(input));
    }
  });
});
