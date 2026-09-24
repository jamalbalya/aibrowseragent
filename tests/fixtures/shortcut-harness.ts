/**
 * A shortcut store, resolver and skill launcher over the real pipeline.
 *
 * Everything above the fake tools is production code: the real registry with
 * its real dispatch path, the real policy engine, the real permission engine,
 * the real egress gate, the real `SkillRunner`, the real `WorkflowStore` and
 * `WorkflowReplayer`. The claim under test is that a shortcut cannot get past
 * any of that, so stubbing any of it would make the suite prove its own stub
 * behaved.
 */
import { MemoryStorageArea, SerializedStorageArea } from '@/storage/storage-area';
import { ShortcutStore } from '@/shortcuts/shortcut-store';
import { ShortcutResolver } from '@/shortcuts/shortcut-resolver';
import { SkillLauncher } from '@/background/skill-launcher';
import { isIncomplete } from '@/workflows/workflow-model';
import {
  buildWorkflowHarness,
  type WorkflowHarness,
  type WorkflowHarnessOptions,
} from './workflow-harness';

export interface ShortcutHarness extends WorkflowHarness {
  readonly shortcuts: ShortcutStore;
  readonly resolver: ShortcutResolver;
  readonly launcher: SkillLauncher;
}

export function buildShortcutHarness(options: WorkflowHarnessOptions = {}): ShortcutHarness {
  const base = buildWorkflowHarness(options);

  const shortcuts = new ShortcutStore({
    area: new SerializedStorageArea(new MemoryStorageArea()),
  });

  const resolver = new ShortcutResolver({
    store: shortcuts,
    workflow: async (workflowId) => {
      const record = await base.store.get(workflowId);
      if (!record) return undefined;
      return {
        workflowId: record.workflowId,
        name: record.name,
        risk: record.risk,
        stepCount: record.definition.steps.length,
        incomplete: isIncomplete(record),
      };
    },
    skill: (skillId, skillVersion) => {
      const entry = base.skills.get(skillId, skillVersion);
      if (!entry) return undefined;
      return {
        skillId: entry.definition.id,
        skillVersion: entry.definition.version,
        name: entry.definition.name,
        risk: entry.risk,
        stepCount: entry.definition.steps.length,
      };
    },
  });

  const launcher = new SkillLauncher({
    registry: base.skills,
    runner: base.runner,
    tasks: base.tasks,
    getPermissionMode: () => Promise.resolve(options.permissionMode ?? 'auto'),
    getActiveTabId: () => Promise.resolve(undefined),
    publishSecurityContext: () => undefined,
    ...(options.onTaskChanged === undefined ? {} : { onTaskChanged: options.onTaskChanged }),
  });

  return { ...base, shortcuts, resolver, launcher };
}
