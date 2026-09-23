/**
 * Where workspaces live, split by lifetime rather than by topic.
 *
 * Two storage areas, and which goes where is the whole point:
 *
 *  - The **workspace record** — id, title, remembered members, timestamps —
 *    is persistent user data in `chrome.storage.local`. It survives worker
 *    eviction, browser restart, sign-out and session expiry, exactly like
 *    connected accounts do.
 *  - The **runtime binding** — the Chrome tab-group and window ids — lives in
 *    `chrome.storage.session`. It must not outlive the browser session that
 *    created it, because a tab-group id is deleted by Chrome when its last
 *    tab leaves and is not guaranteed stable across a restart. Persisting one
 *    to disk would mean restoring a handle that now names something else, or
 *    nothing.
 *
 * **Detach is never delete.** Nothing here removes a workspace because a tab
 * closed, a group was ungrouped, or the browser restarted. `unbind()` drops a
 * runtime handle and leaves every durable byte in place. The only method that
 * removes a workspace is `remove()`, and it exists for an explicit user
 * action.
 */
import { getLogger } from '@/logging/logger';
import { isTransactional, type StorageArea } from '@/storage/storage-area';
import { RecordStore } from '@/storage/record-store';
import type { PersistenceHealthStore } from '@/storage/persistence-health';
import {
  isWorkspace,
  isWorkspaceBinding,
  workspaceState,
  type Workspace,
  type WorkspaceBinding,
  type WorkspaceState,
} from './workspace-model';

const log = getLogger('browser');

const BINDINGS_KEY = 'bindings';
const ACTIVE_KEY = 'active';

/** The pre-local-first layout: one key holding every workspace. */
const LEGACY_BLOB_KEY = 'workspaces';

/**
 * The stored workspace format.
 *
 * Bumping this is what makes `RecordStore` run a migration, so it lives here
 * rather than being implied by the shape of `isWorkspace`.
 */
export const WORKSPACE_FORMAT_VERSION = 1;

interface BindingIndex {
  readonly bindings: Readonly<Record<string, WorkspaceBinding>>;
}

export interface WorkspaceStoreOptions {
  /** Supplied so a test can produce stable ids; real use takes a UUID. */
  readonly newId?: () => string;
  readonly health?: PersistenceHealthStore;
}

export class WorkspaceStore {
  private readonly newId: () => string;
  private readonly records: RecordStore<Workspace>;

  /**
   * @param durable  `chrome.storage.local` — the workspace record.
   * @param runtime  `chrome.storage.session` — Chrome handles, session-scoped.
   */
  constructor(
    private readonly durable: StorageArea,
    private readonly runtime: StorageArea,
    options: WorkspaceStoreOptions = {},
  ) {
    this.newId = options.newId ?? (() => `ws_${crypto.randomUUID()}`);
    this.records = new RecordStore<Workspace>({
      area: durable,
      kind: 'workspace',
      version: WORKSPACE_FORMAT_VERSION,
      identify: (record) => record.workspaceId,
      validate: (candidate): candidate is Workspace => isWorkspace(candidate),
      // Upgrading from the single-value layout is automatic. A record that
      // does not survive `isWorkspace` is left in place rather than rebuilt
      // from defaults: a fabricated workspace is a scope nobody configured,
      // and a tab could end up judged against it.
      legacy: [
        {
          kind: 'blob',
          key: LEGACY_BLOB_KEY,
          version: WORKSPACE_FORMAT_VERSION,
          extract: (stored) =>
            typeof stored === 'object' &&
            stored !== null &&
            Array.isArray(
              (
                stored as {
                  workspaces?: unknown;
                }
              ).workspaces,
            )
              ? (stored as { workspaces: readonly unknown[] }).workspaces
              : [],
        },
      ],
      ...(options.health === undefined ? {} : { health: options.health }),
    });
  }

  mintWorkspaceId(): string {
    return this.newId();
  }

  /**
   * Every workspace, with unreadable records dropped and counted.
   *
   * A malformed record is not rebuilt from defaults: a fabricated workspace
   * would be a scope nobody configured, and a tab could end up judged against
   * it.
   */
  async list(): Promise<readonly Workspace[]> {
    return this.records.list();
  }

  async get(workspaceId: string): Promise<Workspace | undefined> {
    return (await this.list()).find((workspace) => workspace.workspaceId === workspaceId);
  }

  /** The workspaces this user may see. Another user's are hidden, not deleted. */
  async listFor(abaUserId: string): Promise<readonly Workspace[]> {
    return (await this.list()).filter((workspace) => workspace.abaUserId === abaUserId);
  }

  async put(workspace: Workspace): Promise<void> {
    await this.records.replace(workspace);
  }

  /**
   * Deletes a workspace and its binding.
   *
   * The **only** method that removes durable workspace data, and it is reached
   * only from an explicit user action. No lifecycle event calls it: a closed
   * tab, an ungrouped group and a browser restart all detach instead.
   */
  async remove(workspaceId: string): Promise<void> {
    await this.records.remove(workspaceId);
    await this.unbind(workspaceId);
    if ((await this.getActiveId()) === workspaceId) await this.setActiveId(null);
    log.info('A workspace was deleted at the user’s request.', { workspaceId });
  }

  /* ----------------------------- runtime ----------------------------- */

  async binding(workspaceId: string): Promise<WorkspaceBinding | null> {
    return (await this.bindings())[workspaceId] ?? null;
  }

  /** Which workspace owns this Chrome group right now, if any. */
  async bindingForGroup(chromeTabGroupId: number): Promise<WorkspaceBinding | null> {
    const all = Object.values(await this.bindings());
    return all.find((b) => b.chromeTabGroupId === chromeTabGroupId) ?? null;
  }

  /**
   * Binds a workspace to a live Chrome group.
   *
   * A group may back only one workspace. Binding a group that another
   * workspace already holds would make one Chrome group mean two different
   * scopes, and every membership check would then be ambiguous — so the
   * previous holder is unbound first and the fact is logged rather than
   * silently resolved.
   */
  async bind(binding: WorkspaceBinding): Promise<void> {
    await this.mutateBindings((current) => {
      const next: Record<string, WorkspaceBinding> = {};
      for (const [id, existing] of Object.entries(current)) {
        if (existing.chromeTabGroupId === binding.chromeTabGroupId) {
          if (id !== binding.workspaceId) {
            log.warn('A Chrome group was rebound to a different workspace.', {
              chromeTabGroupId: binding.chromeTabGroupId,
            });
          }
          continue;
        }
        next[id] = existing;
      }
      next[binding.workspaceId] = binding;
      return next;
    });
  }

  /**
   * Drops a runtime handle. **Detach, not delete.**
   *
   * The workspace record, its remembered members, its tasks, its history and
   * its workflows are all untouched. What is gone is only the claim that a
   * particular Chrome group is currently this workspace.
   */
  async unbind(workspaceId: string): Promise<void> {
    await this.mutateBindings((current) => {
      const { [workspaceId]: _removed, ...rest } = current;
      return rest;
    });
  }

  /** Drops the binding that names this group, whichever workspace holds it. */
  async unbindGroup(chromeTabGroupId: number): Promise<string | null> {
    const existing = await this.bindingForGroup(chromeTabGroupId);
    if (!existing) return null;
    await this.unbind(existing.workspaceId);
    log.info('A workspace was detached; nothing was deleted.', {
      workspaceId: existing.workspaceId,
    });
    return existing.workspaceId;
  }

  async state(workspaceId: string): Promise<WorkspaceState> {
    return workspaceState(await this.binding(workspaceId));
  }

  /* ------------------------- active selection ------------------------ */

  /**
   * The workspace the panel is showing.
   *
   * Persistent, and changed **only** by an explicit selection. It is never
   * derived from whichever tab happens to be in front: a stray click on
   * another workspace's tab would otherwise silently re-point a running
   * task, which is the cross-workspace targeting this whole feature exists to
   * prevent.
   */
  async getActiveId(): Promise<string | null> {
    return (await this.durable.get<string>(ACTIVE_KEY)) ?? null;
  }

  async setActiveId(workspaceId: string | null): Promise<void> {
    if (workspaceId === null) {
      await this.durable.remove(ACTIVE_KEY);
      return;
    }
    if (!(await this.get(workspaceId))) {
      throw new Error(`No workspace has id "${workspaceId}".`);
    }
    await this.durable.set(ACTIVE_KEY, workspaceId);
  }

  async getActive(): Promise<Workspace | null> {
    const id = await this.getActiveId();
    return id ? ((await this.get(id)) ?? null) : null;
  }

  /* ------------------------------ internals -------------------------- */

  private async bindings(): Promise<Readonly<Record<string, WorkspaceBinding>>> {
    const stored = await this.runtime.get<BindingIndex>(BINDINGS_KEY);
    if (stored === undefined) return {};
    if (typeof stored !== 'object' || stored === null || typeof stored.bindings !== 'object') {
      log.error('The workspace binding index is malformed and was not read.');
      return {};
    }
    const raw: Record<string, unknown> = stored.bindings ?? {};
    const usable: Record<string, WorkspaceBinding> = {};
    for (const [id, binding] of Object.entries(raw)) {
      if (isWorkspaceBinding(binding)) usable[id] = binding;
    }
    return usable;
  }

  private async mutateBindings(
    change: (
      bindings: Readonly<Record<string, WorkspaceBinding>>,
    ) => Readonly<Record<string, WorkspaceBinding>>,
  ): Promise<void> {
    if (isTransactional(this.runtime)) {
      await this.runtime.transaction<BindingIndex>(BINDINGS_KEY, { bindings: {} }, (current) => ({
        bindings: change(current.bindings ?? {}),
      }));
      return;
    }
    await this.runtime.set<BindingIndex>(BINDINGS_KEY, {
      bindings: change(await this.bindings()),
    });
  }
}
