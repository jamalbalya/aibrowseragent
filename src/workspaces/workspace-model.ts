/**
 * A browser workspace: which tabs are in scope, and nothing more.
 *
 * Until now the agent had no context boundary at all. `listTabs()` was
 * `chrome.tabs.query({})` — every tab in every window — and a tool acted on
 * whatever tab id it was handed. Every control in the authorization stack
 * answers *"may this action happen"*; none answered *"is this tab even in
 * scope"*, so a task started from one page could enumerate and act on an
 * unrelated tab in another window.
 *
 * A workspace answers only that second question. It is a **narrowing filter**
 * and can never widen anything: consent, origin policy, the egress gate,
 * taint, route trust, credential isolation and tool permissions all still run,
 * unchanged and just as often. Membership decides eligibility; it never
 * decides authorization. The same relationship route trust has to policy.
 *
 * **Chrome is authoritative for current membership; this record is
 * authoritative for identity.** That split is the design:
 *
 *  - A record-only rule would keep a tab the user dragged *out* eligible
 *    until an event was processed, which is a window in which a task can act
 *    on a page the user has just removed from its reach.
 *  - A both-must-agree rule would refuse a tab the user dragged *in*, because
 *    it is in the Chrome group before any record mentions it.
 *
 * So the predicate below reads Chrome live, every time, and the stored member
 * list is a mirror used for display, recovery and audit — never to grant.
 */
import type { TabInfo } from '@/tools/browser/chrome-adapter';

/** Chrome's "this tab is in no group" sentinel. Measured, not assumed. */
export const TAB_GROUP_ID_NONE = -1;

/**
 * A workspace that exists but has no live Chrome group behind it.
 *
 * Reached by a browser restart, an extension reload, the user ungrouping the
 * tabs, or the last member closing — Chrome deletes a group when its final
 * tab leaves. It is a **normal state, never an implicit close**: the
 * workspace, its tasks, history and workflows are all intact and the user
 * re-attaches when they want it back.
 */
export type WorkspaceState = 'attached' | 'detached';

/**
 * A remembered member, by what survives a restart.
 *
 * Deliberately no `tabId`: a tab id is a runtime handle that Chrome recycles,
 * so a stored one may later name a different page entirely. Origin and title
 * are enough to show the user what was in the workspace and are meaningless
 * as a targeting instruction, which is the point.
 */
export interface WorkspaceMember {
  readonly origin: string;
  readonly title: string;
  readonly addedAt: number;
  /** The agent opened it, rather than the user putting it there. */
  readonly openedByAgent: boolean;
}

/** The durable half. Survives everything except explicit deletion. */
export interface Workspace {
  readonly workspaceId: string;
  /** Whose workspace. A scoping label, never an authorization input. */
  readonly abaUserId: string;
  readonly title: string;
  readonly members: readonly WorkspaceMember[];
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

/**
 * The runtime half. Lives in `chrome.storage.session` and must not outlive
 * the browser session that created it, because every id in it will name
 * something else by then.
 */
export interface WorkspaceBinding {
  readonly workspaceId: string;
  readonly chromeTabGroupId: number;
  /**
   * Recorded for display and focus only.
   *
   * **Window identity is never workspace identity.** Two workspaces may share
   * one Chrome window, so nothing in the membership decision reads this.
   */
  readonly chromeWindowId: number;
  readonly boundAt: number;
}

export function isWorkspace(value: unknown): value is Workspace {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Workspace>;
  return (
    typeof record.workspaceId === 'string' &&
    record.workspaceId.length > 0 &&
    typeof record.abaUserId === 'string' &&
    typeof record.title === 'string' &&
    Array.isArray(record.members) &&
    typeof record.createdAt === 'number' &&
    typeof record.lastActiveAt === 'number'
  );
}

export function isWorkspaceBinding(value: unknown): value is WorkspaceBinding {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<WorkspaceBinding>;
  return (
    typeof record.workspaceId === 'string' &&
    record.workspaceId.length > 0 &&
    typeof record.chromeTabGroupId === 'number' &&
    record.chromeTabGroupId !== TAB_GROUP_ID_NONE &&
    typeof record.chromeWindowId === 'number' &&
    typeof record.boundAt === 'number'
  );
}

/**
 * Why a tab is not eligible context.
 *
 * Every one of these is a refusal. There is no code here that returns a
 * reason and then proceeds anyway, and none of them is recoverable by
 * retrying with different arguments — which is what makes the filter
 * meaningful rather than advisory.
 */
export type MembershipRefusal =
  | 'NO_WORKSPACE_ON_TASK'
  | 'WORKSPACE_DETACHED'
  | 'GROUP_GONE'
  | 'TAB_GONE'
  | 'TAB_UNGROUPED'
  | 'OTHER_WORKSPACE';

export type MembershipVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: MembershipRefusal; readonly reason: string };

/** What the caller must read from Chrome before asking. All live, none cached. */
export interface LiveMembershipInput {
  /** The task's workspace. `undefined` for a task created before workspaces. */
  readonly taskWorkspaceId: string | undefined;
  /** The binding, or `null` when the workspace is detached. */
  readonly binding: WorkspaceBinding | null;
  /** Whether `chrome.tabGroups.get(binding.chromeTabGroupId)` still resolves. */
  readonly groupExists: boolean;
  /** The tab as Chrome reports it *now*, or `null` if it is gone. */
  readonly tab: Pick<TabInfo, 'id' | 'groupId'> | null;
}

const refuse = (refusal: MembershipRefusal, reason: string): MembershipVerdict => ({
  ok: false,
  refusal,
  reason,
});

/**
 * Is this tab live context for this task?
 *
 * Pure, so every branch can be exercised exhaustively and so the answer never
 * depends on the order two reads happened to resolve in. The caller does the
 * I/O and hands the results in; that is what keeps "read Chrome live" honest,
 * because there is nowhere in here to consult a cache even by mistake.
 *
 * Fails closed at every step. A tab is eligible only when every clause is
 * positively satisfied — never because nothing said otherwise.
 */
export function checkMembership(input: LiveMembershipInput): MembershipVerdict {
  // A task from before workspaces existed. Refused rather than exempted:
  // exempting it would leave the boundary open on exactly the tasks most
  // likely to have already used it. Nothing is deleted — the task, its
  // history and its workflows are untouched, and it continues after an
  // explicit restart into a workspace.
  if (input.taskWorkspaceId === undefined || input.taskWorkspaceId.length === 0) {
    return refuse(
      'NO_WORKSPACE_ON_TASK',
      'This task is not attached to a workspace. Start it again to continue.',
    );
  }

  if (input.binding === null || input.binding.workspaceId !== input.taskWorkspaceId) {
    return refuse(
      'WORKSPACE_DETACHED',
      'This task’s workspace is not open in the browser right now.',
    );
  }

  // Chrome deletes a group when its last tab leaves, so a binding can go
  // stale without the user doing anything they would call closing it.
  if (!input.groupExists) {
    return refuse('GROUP_GONE', 'This task’s tab group is no longer open.');
  }

  if (input.tab === null) {
    return refuse('TAB_GONE', 'That tab was closed.');
  }

  // The user dragged it out, or it was never in a group. Either way it is not
  // context, and it is never silently adopted into the caller's workspace.
  if (input.tab.groupId === TAB_GROUP_ID_NONE) {
    return refuse('TAB_UNGROUPED', 'That tab is not part of this workspace.');
  }

  if (input.tab.groupId !== input.binding.chromeTabGroupId) {
    return refuse('OTHER_WORKSPACE', 'That tab belongs to a different workspace.');
  }

  return { ok: true };
}

/** A workspace with a live binding is attached; everything else is detached. */
export function workspaceState(binding: WorkspaceBinding | null): WorkspaceState {
  return binding === null ? 'detached' : 'attached';
}

/**
 * Adds or refreshes a remembered member.
 *
 * Keyed by origin, because that is what survives. Re-visiting an origin
 * updates the title rather than accumulating duplicates.
 */
export function withMember(workspace: Workspace, member: WorkspaceMember): Workspace {
  return {
    ...workspace,
    members: [...workspace.members.filter((m) => m.origin !== member.origin), member],
    lastActiveAt: member.addedAt,
  };
}

/**
 * Forgets a remembered member.
 *
 * **Detaches, never deletes.** This drops one entry from the mirror. The
 * workspace, its tasks, its history and its workflows are untouched, and a
 * workspace with no members left is still a workspace.
 */
export function withoutMember(workspace: Workspace, origin: string): Workspace {
  return { ...workspace, members: workspace.members.filter((m) => m.origin !== origin) };
}

/** A short, human title for a new workspace, derived from where it started. */
export function deriveWorkspaceTitle(url: string | undefined): string {
  if (!url) return 'Workspace';
  try {
    return new URL(url).host || 'Workspace';
  } catch {
    return 'Workspace';
  }
}
