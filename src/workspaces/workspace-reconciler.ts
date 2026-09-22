/**
 * Keeping the workspace mirror honest about what Chrome actually holds.
 *
 * Chrome is authoritative for membership, so this module never *decides*
 * anything — it observes. Its job is to keep the stored member list and the
 * runtime bindings in step with the browser so the panel shows the truth and
 * a detached workspace is noticed promptly.
 *
 * **It is not the security boundary.** The guard reads Chrome live on every
 * operation (`checkMembership`), so a mirror that lagged by an event could at
 * worst display something stale — it could never authorise anything. That
 * separation is deliberate: a reconciler that had to be correct for safety
 * would be a reconciler whose every missed event was a vulnerability.
 *
 * **Which events matter**, established by measurement in real Chromium rather
 * than from documentation, because the answer is not obvious:
 *
 *     grouping a tab    tabGroups.onCreated{id}
 *                       tabs.onUpdated{tabId, {groupId: id}}
 *     ungrouping        tabs.onUpdated{tabId, {groupId: -1}}
 *                       tabGroups.onRemoved{id}
 *
 * There is **no `tabs.onGroupChanged`**. A user dragging a tab in or out of a
 * group surfaces as `tabs.onUpdated` carrying `changeInfo.groupId`, and that
 * single fact is what makes drag-and-drop membership detectable at all.
 *
 * A group also ceases to exist when its last tab leaves — measured — so
 * `tabGroups.onRemoved` is how a workspace becomes detached without the user
 * doing anything they would describe as closing it.
 */
import { getLogger } from '@/logging/logger';
import { TAB_GROUP_ID_NONE, withMember, withoutMember } from './workspace-model';
import type { WorkspaceStore } from './workspace-store';

const log = getLogger('browser');

/** What the reconciler needs to read. Narrow, so it cannot act on tabs. */
export interface ReconcilerPorts {
  readonly store: WorkspaceStore;
  /** `chrome.tabs.get`, returning `null` when the tab is gone. */
  readonly getTab: (
    tabId: number,
  ) => Promise<{ id: number; url: string; title: string; groupId: number } | null>;
  readonly now?: () => number;
  /** Records the membership change. A failure here never fails the change. */
  readonly onChange?: (change: MembershipChange) => Promise<void>;
}

export interface MembershipChange {
  readonly workspaceId: string;
  readonly origin: string;
  readonly kind: 'joined' | 'left';
  readonly openedByAgent: boolean;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export class WorkspaceReconciler {
  private readonly now: () => number;

  constructor(private readonly ports: ReconcilerPorts) {
    this.now = ports.now ?? (() => Date.now());
  }

  /**
   * A tab's group changed — the drag signal.
   *
   * Called from `tabs.onUpdated` when `changeInfo.groupId` is present. Handles
   * both directions and the move-between-workspaces case, which arrives as a
   * single event carrying only the *new* group.
   */
  async handleGroupChanged(tabId: number, newGroupId: number): Promise<void> {
    const tab = await this.ports.getTab(tabId);
    if (tab === null) return;
    const origin = originOf(tab.url);
    if (origin === null) return;

    // Left whichever workspace previously held it. The event does not say
    // which that was, so every workspace that remembers this origin and is
    // not the new owner drops it.
    const newOwner =
      newGroupId === TAB_GROUP_ID_NONE ? null : await this.ports.store.bindingForGroup(newGroupId);

    for (const workspace of await this.ports.store.list()) {
      const holdsIt = workspace.members.some((member) => member.origin === origin);
      const isNewOwner = newOwner?.workspaceId === workspace.workspaceId;
      if (holdsIt && !isNewOwner) {
        await this.ports.store.put(withoutMember(workspace, origin));
        await this.record({
          workspaceId: workspace.workspaceId,
          origin,
          kind: 'left',
          openedByAgent: false,
        });
      }
    }

    if (newOwner === null) return;
    const workspace = await this.ports.store.get(newOwner.workspaceId);
    if (!workspace) return;
    await this.ports.store.put(
      withMember(workspace, {
        origin,
        title: tab.title,
        addedAt: this.now(),
        // The user dragged it in. Agent-created members are recorded by the
        // tab lifecycle, which knows it opened them.
        openedByAgent: false,
      }),
    );
    await this.record({
      workspaceId: newOwner.workspaceId,
      origin,
      kind: 'joined',
      openedByAgent: false,
    });
  }

  /**
   * A tab closed.
   *
   * Drops it from the mirror. **Detach, not delete**: the workspace, its
   * tasks, its history and its workflows are untouched, and a workspace whose
   * last tab closed is still a workspace.
   */
  async handleTabRemoved(tabId: number, lastKnownOrigin: string | undefined): Promise<void> {
    if (lastKnownOrigin === undefined) return;
    for (const workspace of await this.ports.store.list()) {
      if (!workspace.members.some((member) => member.origin === lastKnownOrigin)) continue;
      await this.ports.store.put(withoutMember(workspace, lastKnownOrigin));
      await this.record({
        workspaceId: workspace.workspaceId,
        origin: lastKnownOrigin,
        kind: 'left',
        openedByAgent: false,
      });
    }
    log.debug('A tab left the workspace mirror.', { tabId });
  }

  /**
   * Chrome deleted a tab group.
   *
   * The workspace becomes detached. Nothing is deleted — not the workspace,
   * not its members, not its tasks. Re-attaching is a user action.
   */
  async handleGroupRemoved(chromeTabGroupId: number): Promise<void> {
    await this.ports.store.unbindGroup(chromeTabGroupId);
  }

  /**
   * Re-verifies every binding against Chrome.
   *
   * Run at worker startup. `chrome.storage.session` outlives worker eviction,
   * so a binding is usually still there — but the group it names may have
   * been deleted while the worker was gone, and a binding to a group that no
   * longer exists would make `checkMembership` ask a question about nothing.
   */
  async revalidate(groupExists: (groupId: number) => Promise<boolean>): Promise<number> {
    let detached = 0;
    for (const workspace of await this.ports.store.list()) {
      const binding = await this.ports.store.binding(workspace.workspaceId);
      if (binding === null) continue;
      if (await groupExists(binding.chromeTabGroupId)) continue;
      await this.ports.store.unbind(workspace.workspaceId);
      detached += 1;
    }
    if (detached > 0) {
      log.info('Workspaces were detached at startup; nothing was deleted.', { detached });
    }
    return detached;
  }

  private async record(change: MembershipChange): Promise<void> {
    if (!this.ports.onChange) return;
    try {
      await this.ports.onChange(change);
    } catch {
      // A missing audit line is a gap in the record of something that already
      // happened. It does not undo the membership change.
      log.warn('A workspace membership change could not be recorded.');
    }
  }
}
