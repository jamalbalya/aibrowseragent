/**
 * Working out what a shortcut points at, without running it.
 *
 * Resolution is a **read**. It looks the name up, checks the target still
 * exists and is still runnable, and returns a description for the user to
 * look at. It starts no task, dispatches no tool and takes no side effect of
 * any kind — which is what makes it safe to run on every keystroke while
 * someone is typing a `/command`.
 *
 * Everything fails closed. A shortcut whose target was deleted, is the wrong
 * kind, is an unregistered skill, or is a workflow that cannot run, resolves
 * to a refusal with a reason — never to a different target. There is no
 * fallback, no nearest match and no display-name lookup: the stored reference
 * is an id, and an id either still names something or it does not.
 *
 * The confirmation this produces is **not an authorization**. It tells the
 * user what a name means before they commit to it. Everything the target
 * would have been asked for, it is still asked for: the workflow replay
 * revalidates and re-prompts per step, and a skill run dispatches each step
 * through the same gates. A shortcut buys nothing.
 */
import type { RiskLevel } from '@/policy/risk-classifier';
import type { ShortcutRecord, ShortcutTarget } from './shortcut-model';
import type { ShortcutStore } from './shortcut-store';

export type ResolutionRefusal =
  'NO_SUCH_SHORTCUT' | 'TARGET_MISSING' | 'TARGET_UNUSABLE' | 'TARGET_KIND_UNKNOWN';

/**
 * What the user is shown before they commit.
 *
 * Identity and risk, nothing else. In particular it carries no step list and
 * no argument values: a confirmation is a statement about *which* reviewed
 * thing is about to run, and the place to inspect what that thing does is the
 * review surface that already exists for it.
 */
export interface ShortcutResolution {
  readonly shortcutId: string;
  /** The normalised name, as it would be typed. */
  readonly name: string;
  readonly targetKind: ShortcutTarget['kind'];
  /** The target's own display name, from the store or registry that owns it. */
  readonly targetName: string;
  readonly targetId: string;
  readonly targetVersion?: string;
  readonly risk: RiskLevel;
  readonly stepCount: number;
}

export type ShortcutVerdict =
  | { readonly ok: true; readonly record: ShortcutRecord; readonly resolution: ShortcutResolution }
  | { readonly ok: false; readonly reason: ResolutionRefusal; readonly detail: string };

/** What a workflow target looks like from here. Deliberately minimal. */
export interface WorkflowTargetView {
  readonly workflowId: string;
  readonly name: string;
  readonly risk: RiskLevel;
  readonly stepCount: number;
  /** A workflow missing a step it watched cannot run. P-022 owns this rule. */
  readonly incomplete: boolean;
}

/** What a bundled skill target looks like from here. */
export interface SkillTargetView {
  readonly skillId: string;
  readonly skillVersion: string;
  readonly name: string;
  readonly risk: RiskLevel;
  readonly stepCount: number;
}

export interface ShortcutResolverOptions {
  readonly store: ShortcutStore;
  /** The stored workflow with that id, or `undefined`. */
  readonly workflow: (workflowId: string) => Promise<WorkflowTargetView | undefined>;
  /**
   * The **registered** skill with that id and version, or `undefined`.
   *
   * Registered, not merely named: the registry takes only definitions that
   * shipped in the build, so asking it is what keeps a shortcut from pointing
   * at a skill nobody reviewed.
   */
  readonly skill: (skillId: string, skillVersion: string) => SkillTargetView | undefined;
}

export class ShortcutResolver {
  constructor(private readonly options: ShortcutResolverOptions) {}

  /** Resolves what the user typed. Reads only. */
  async resolveTyped(typed: string): Promise<ShortcutVerdict> {
    const record = await this.options.store.find(typed);
    if (!record) {
      return {
        ok: false,
        reason: 'NO_SUCH_SHORTCUT',
        detail: 'There is no shortcut by that name.',
      };
    }
    return await this.resolveRecord(record);
  }

  /** Resolves a stored shortcut. Reads only. */
  async resolveRecord(record: ShortcutRecord): Promise<ShortcutVerdict> {
    const target = record.target;

    if (target.kind === 'workflow') {
      const workflow = await this.options.workflow(target.workflowId);
      if (!workflow) {
        // Dangling, and it stays dangling. Falling through to another
        // workflow — by name, by recency, by anything — would run something
        // the user never pointed this name at.
        return {
          ok: false,
          reason: 'TARGET_MISSING',
          detail: `/${record.name} points at a workflow that no longer exists.`,
        };
      }
      if (workflow.incomplete) {
        return {
          ok: false,
          reason: 'TARGET_UNUSABLE',
          detail:
            `/${record.name} points at a recording that is missing steps the task actually ` +
            'took, so it cannot be run.',
        };
      }
      return {
        ok: true,
        record,
        resolution: {
          shortcutId: record.shortcutId,
          name: record.name,
          targetKind: 'workflow',
          targetName: workflow.name,
          targetId: workflow.workflowId,
          risk: workflow.risk,
          stepCount: workflow.stepCount,
        },
      };
    }

    if (target.kind === 'skill') {
      // Pinned exactly. A shortcut never floats to a newer version: that
      // would be the target changing under a name the user already approved.
      const skill = this.options.skill(target.skillId, target.skillVersion);
      if (!skill) {
        return {
          ok: false,
          reason: 'TARGET_MISSING',
          detail: `/${record.name} points at a workflow that is no longer available.`,
        };
      }
      return {
        ok: true,
        record,
        resolution: {
          shortcutId: record.shortcutId,
          name: record.name,
          targetKind: 'skill',
          targetName: skill.name,
          targetId: skill.skillId,
          targetVersion: skill.skillVersion,
          risk: skill.risk,
          stepCount: skill.stepCount,
        },
      };
    }

    // Unreachable through the type, and refused anyway: a stored record can
    // be edited underneath the store, and an unknown kind must not be guessed.
    return {
      ok: false,
      reason: 'TARGET_KIND_UNKNOWN',
      detail: `/${record.name} points at something this version cannot run.`,
    };
  }

  /**
   * Validates a target before a shortcut is created for it.
   *
   * Separate from resolution and not a substitute for it: passing here means
   * the target existed at creation, which says nothing about whether it still
   * exists at invocation. Both checks run.
   */
  async targetIsUsable(target: ShortcutTarget): Promise<boolean> {
    if (target.kind === 'workflow') {
      const workflow = await this.options.workflow(target.workflowId);
      return workflow !== undefined && !workflow.incomplete;
    }
    if (target.kind === 'skill') {
      return this.options.skill(target.skillId, target.skillVersion) !== undefined;
    }
    return false;
  }
}
