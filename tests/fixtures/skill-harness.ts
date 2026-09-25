/**
 * A skill registry and runner over a real `ToolRegistry`.
 *
 * The tools are fakes, but everything above them is production code: the real
 * registry with its real dispatch path, the real policy engine, the real
 * permission engine, the real egress gate. A suite that stubbed dispatch would
 * prove its own stub behaved, and the claim under test here is precisely that
 * a skill cannot get past dispatch.
 */
import { z } from 'zod';
import type { ToolRegistry, ToolRegistryOptions } from '@/tools/registry/tool-registry';
import { ConsentStore } from '@/security/egress/consent';
import { noEgress, urlDestination } from '@/security/egress/destination';
import { freshTaint, type TaintState } from '@/security/taint/taint-state';
import type { PermissionMode } from '@/policy/policy-engine';
import type { RiskLevel } from '@/policy/risk-classifier';
import type {
  AgentTool,
  SiteAuthorizationScope,
  ToolExecutionResult,
} from '@/tools/core/tool-types';
import type { TaintSource } from '@/security/exfiltration/exfiltration-guard';
import { ALL_SKILLS_ENABLED, SkillRegistry } from '@/skills/core/skill-registry';
import { SkillRunner, type SkillRunContext } from '@/skills/runtime/skill-runner';
import type { SkillDefinition } from '@/skills/core/skill-model';
import { createHarness, ScriptedPrompter } from './policy-harness';
import type { PermissionPrompter } from '@/policy/permission-engine';

export const TASK = 'task_skill_1';

/** One call a fake tool saw. */
export interface SeenCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly taintState: TaintState;
}

export interface FakeToolSpec {
  readonly name: string;
  readonly risk?: RiskLevel;
  /** What the tool returns, or a function of its arguments. */
  readonly returns?: unknown;
  /** Thrown instead of returning. */
  readonly throws?: () => never;
  /** Taint the tool reports having acquired. */
  readonly taint?: readonly TaintSource[];
  /** Declares an outbound transfer, so the egress gate applies. */
  readonly egressTo?: string;
  /** Called before the tool returns, for cancellation races. */
  readonly onCall?: (args: Record<string, unknown>) => void;
  /** Whose site authorization applies. Defaults to `none`, like a fake tool. */
  readonly siteAuthorization?: SiteAuthorizationScope;
}

export interface SkillHarness {
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly runner: SkillRunner;
  readonly consent: ConsentStore;
  readonly seen: SeenCall[];
  /** Tools the permission engine actually asked about, in order. */
  prompts(): string[];
  /** Answer every permission prompt this way. */
  respondWith: (kind: 'approve_once' | 'deny') => void;
  register: (definition: SkillDefinition) => Promise<void>;
  context: (overrides?: Partial<SkillRunContext>) => SkillRunContext;
  /** Tool calls the run may still take. */
  setRemaining: (remaining: number) => void;
}

/** A fake tool that records what it was given and returns what it was told. */
export function fakeTool(spec: FakeToolSpec): AgentTool<z.ZodType> {
  const schema = z.object({}).catchall(z.unknown());
  return {
    name: spec.name,
    version: '1.0.0',
    description: `Fake ${spec.name}.`,
    inputSchema: schema,
    risk: spec.risk ?? 'R0',
    executionMode: 'immediate',
    siteAuthorization: spec.siteAuthorization ?? 'none',
    sideEffects: [],
    timeoutMs: 5_000,
    idempotent: true,
    classify: (input: Record<string, unknown>) => ({
      summary: `Run ${spec.name}.`,
      egress:
        spec.egressTo === undefined
          ? { destination: noEgress(), payload: undefined }
          : {
              destination: urlDestination('navigation', spec.egressTo),
              carrier: { writesValue: true },
              payload: JSON.stringify(input),
            },
    }),
    execute: (input: Record<string, unknown>): Promise<ToolExecutionResult> => {
      spec.onCall?.(input);
      if (spec.throws) spec.throws();
      const data =
        typeof spec.returns === 'function'
          ? (spec.returns as (args: Record<string, unknown>) => unknown)(input)
          : (spec.returns ?? { ok: true });
      return Promise.resolve({
        success: true,
        data,
        ...(spec.taint === undefined ? {} : { taint: spec.taint }),
      });
    },
  };
}

export interface HarnessOptions {
  /**
   * Which skills the user has switched off, as `id@version` keys.
   *
   * Defaults to none, which is `ALL_SKILLS_ENABLED` — the behaviour every
   * suite that does not care about enablement expects.
   */
  readonly disabledSkills?: ReadonlySet<string>;
  readonly tools?: readonly FakeToolSpec[];
  readonly permissionMode?: PermissionMode;
  readonly taintState?: TaintState;
  /** The registry's observation hook, for the workflow recorder's tests. */
  readonly onDispatched?: ToolRegistryOptions['onDispatched'];
  /** Puts production code in front of the scripted prompter. See `createHarness`. */
  readonly wrapPrompter?: (inner: PermissionPrompter) => PermissionPrompter;
  /** Whether a task runs unattended. See `createHarness`. */
  readonly resolveUnattended?: (taskId: string) => Promise<boolean>;
  /** Supplies the runner's origin-drift reading. See `SkillRunnerOptions`. */
  readonly resolveTabUrl?: (tabId: number) => Promise<string | undefined>;
}

export function buildSkillHarness(options: HarnessOptions = {}): SkillHarness {
  const seen: SeenCall[] = [];
  let remaining = 100;
  let currentTaint: TaintState = options.taintState ?? freshTaint();

  const prompter = new ScriptedPrompter();
  const consent = new ConsentStore();

  // Every fake is wrapped so the harness records the taint the registry
  // actually handed it — which is how a test proves a later step saw what an
  // earlier one read.
  const wrapped = (options.tools ?? []).map((spec) =>
    fakeTool({
      ...spec,
      onCall: (args) => {
        seen.push({ tool: spec.name, args, taintState: currentTaint });
        spec.onCall?.(args);
      },
    }),
  );

  // The real registry, the real policy engine, the real permission engine and
  // the real egress gate. Only the tools at the bottom are fakes.
  const harness = createHarness(wrapped, {
    ...(options.permissionMode === undefined ? {} : { mode: options.permissionMode }),
    prompter,
    egress: { consent, record: () => Promise.resolve() },
    ...(options.onDispatched === undefined ? {} : { onDispatched: options.onDispatched }),
    ...(options.wrapPrompter === undefined ? {} : { wrapPrompter: options.wrapPrompter }),
    ...(options.resolveUnattended === undefined
      ? {}
      : { resolveUnattended: options.resolveUnattended }),
  });
  const tools: ToolRegistry = harness.registry;

  const skills = new SkillRegistry({
    riskOfTool: (name) => tools.get(name)?.risk,
    isEnabled: ((disabled) =>
      disabled === undefined
        ? ALL_SKILLS_ENABLED
        : (id: string, version: string) => !disabled.has(`${id}@${version}`))(
      options.disabledSkills,
    ),
  });

  const runner = new SkillRunner({
    tools,
    skills,
    remainingToolCalls: () => remaining,
    ...(options.resolveTabUrl === undefined ? {} : { resolveTabUrl: options.resolveTabUrl }),
  });

  return {
    tools,
    skills,
    runner,
    consent,
    seen,
    prompts: () => prompter.seen.map((request) => request.tool),
    respondWith: (kind) => {
      prompter.setResponse({ kind });
    },
    register: async (definition) => {
      await skills.register(definition);
    },
    setRemaining: (value) => {
      remaining = value;
    },
    context: (overrides = {}) => {
      const taintState = overrides.taintState ?? options.taintState ?? freshTaint();
      currentTaint = taintState;
      return {
        taskId: TASK,
        sessionId: 'session_skill',
        toolCallId: 'tc_skill',
        taintState,
        taintSalt: 'ab'.repeat(32),
        saltEpoch: 1,
        signal: new AbortController().signal,
        ...overrides,
      };
    },
  };
}

/** A minimal valid definition, with whatever a test needs changed. */
export function skillFixture(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'test.skill',
    version: '1.0.0',
    name: 'Test skill',
    description: 'A skill used by the tests.',
    provenance: 'bundled',
    risk: 'R0',
    requiredTools: ['fake.read'],
    requiredConnectors: [],
    inputs: [],
    outputs: [],
    steps: [
      {
        kind: 'tool',
        id: 'one',
        tool: 'fake.read',
        description: 'Read something.',
        arguments: {},
      },
    ],
    ...overrides,
  };
}
