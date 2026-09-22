/**
 * The two tools through which a skill can be reached at all (P-024).
 *
 * `skills.run` is the only way to start a skill, and it is an ordinary tool.
 * That is the point: it goes through `ToolRegistry.dispatch` like everything
 * else, so a model asking for a skill is schema-validated, risk-classified,
 * policy-checked and — for anything above the confirmation threshold —
 * approved by a person, before a single step runs. Then each step inside is
 * dispatched again, with its own risk and its own approval.
 *
 * So a two-step skill that reads a page and files an issue costs one approval
 * for the run and one for the issue. The run-level approval names the skill;
 * the step-level one names the actual write and its destination. Neither
 * substitutes for the other, and the outer one cannot be used to buy the
 * inner one — `skills.run` adds a gate, it does not replace any.
 *
 * `skills.run` takes a skill **id**, not a definition. There is no parameter
 * anywhere in this file that accepts steps, tools, code or a definition of any
 * kind, so a model cannot describe a skill into existence: it can only name
 * one that shipped in the build. An unknown id is refused, never created.
 */
import { z } from 'zod';
import { ERROR_CODES, ToolError, type ErrorCode } from '@/types/result';
import { getLogger } from '@/logging/logger';
import { noEgress } from '@/security/egress/destination';
import { newId } from '@/utils/ids';
import type { RiskLevel } from '@/policy/risk-classifier';
import type { AgentTool, ToolExecutionResult } from '@/tools/core/tool-types';
import type { SkillRegistry } from '@/skills/core/skill-registry';
import {
  SkillInputError,
  type SkillRunner,
  type SkillRunResult,
} from '@/skills/runtime/skill-runner';
import type { SkillRunStore } from '@/skills/runtime/skill-run-store';
import type { TaintState } from '@/security/taint/taint-state';

const log = getLogger('agent');

/** An audit record for a skill run. Identifiers and decisions, never data. */
export interface SkillAuditEvent {
  readonly type: 'skill.started' | 'skill.step' | 'skill.finished';
  readonly taskId: string;
  readonly skillId: string;
  readonly skillVersion: string;
  readonly skillHash: string;
  readonly outcome: 'allowed' | 'denied' | 'failed' | 'info';
  readonly step?: string;
  readonly ran?: string;
  readonly code?: string;
}

export interface SkillToolDeps {
  readonly registry: SkillRegistry;
  readonly runner: SkillRunner;
  readonly runs?: SkillRunStore;
  /** The security context of the task making the call. */
  readonly securityFor: (taskId: string) => SkillSecurityContext | undefined;
  readonly audit?: (event: SkillAuditEvent) => Promise<void>;
}

export interface SkillSecurityContext {
  readonly taintState: TaintState;
  readonly taintSalt: string;
  readonly saltEpoch: number;
}

const listInput = z.object({});

const runInput = z.object({
  skillId: z
    .string()
    .min(1)
    .max(64)
    .describe('The id of a registered skill, exactly as skills.list reports it.'),
  skillVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .optional()
    .describe('Pin an exact version. Omit to use the newest registered one.'),
  inputs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Values for the skill's declared inputs."),
});

export function createSkillTools(deps: SkillToolDeps): AgentTool[] {
  return [listTool(deps), runTool(deps)] as AgentTool[];
}

/** What is available, described well enough to choose between. */
function listTool(deps: SkillToolDeps): AgentTool<typeof listInput> {
  return {
    name: 'skills.list',
    version: '1.0.0',
    description:
      'List the workflows this extension can run, with the inputs each one takes. ' +
      'Skills cannot be created or changed; only the ones listed here exist.',
    inputSchema: listInput,
    risk: 'R0',
    executionMode: 'immediate',
    sideEffects: [],
    timeoutMs: 5_000,
    idempotent: true,
    classify: () => ({
      summary: 'List the available skills.',
      egress: { destination: noEgress(), payload: undefined },
    }),

    execute: (): Promise<ToolExecutionResult> =>
      Promise.resolve({
        success: true,
        data: {
          skills: deps.registry.list().map((entry) => ({
            id: entry.definition.id,
            version: entry.definition.version,
            name: entry.definition.name,
            description: entry.definition.description,
            risk: entry.risk,
            steps: entry.definition.steps.length,
            tools: entry.tools,
            connectors: entry.definition.requiredConnectors,
            inputs: entry.definition.inputs.map((input) => ({
              name: input.name,
              type: input.type,
              required: input.required,
              description: input.description,
              ...(input.enum === undefined ? {} : { allowed: input.enum }),
            })),
            outputs: entry.definition.outputs.map((output) => ({
              name: output.name,
              description: output.description,
            })),
            ...(entry.definition.instructions === undefined
              ? {}
              : { instructions: entry.definition.instructions }),
          })),
        },
      }),
  };
}

function runTool(deps: SkillToolDeps): AgentTool<typeof runInput> {
  return {
    name: 'skills.run',
    version: '1.0.0',
    description:
      'Run one of the workflows skills.list reports, by id. The steps are fixed by the ' +
      'workflow; only its declared inputs can be supplied.',
    inputSchema: runInput,
    // A floor. `classify` raises it to whatever the named skill actually
    // reaches, so a skill that files an issue is approved as a write even
    // though the tool that starts it is generic.
    risk: 'R1',
    // `immediate` because starting a skill needs nothing of its own. What
    // each step needs — a page, the debugger, a connector — is that step's
    // declaration, checked when it is dispatched.
    executionMode: 'immediate',
    sideEffects: ['Runs every step the workflow defines, each gated on its own.'],
    timeoutMs: 10 * 60_000,
    idempotent: false,

    /**
     * Argument-aware risk.
     *
     * The risk of `skills.run` is not a property of `skills.run`; it is a
     * property of the skill named in its arguments. Classifying from the
     * registry is what stops a destructive workflow being approved at the
     * generic tool's floor.
     */
    classify: (input) => {
      const resolved = resolve(deps.registry, input.skillId, input.skillVersion);
      const risk: RiskLevel = resolved?.risk ?? 'R3';
      return {
        risk,
        summary: resolved
          ? `Run the "${resolved.definition.name}" workflow (${resolved.definition.steps.length} ` +
            `steps, using ${resolved.tools.join(', ')}).`
          : `Run an unrecognised workflow "${input.skillId}".`,
        // The skill itself transfers nothing; its steps declare their own
        // destinations and are gated individually when they run.
        egress: { destination: noEgress(), payload: undefined },
      };
    },

    execute: async (input, context): Promise<ToolExecutionResult> => {
      const resolved = resolve(deps.registry, input.skillId, input.skillVersion);
      if (!resolved) {
        // Refused, never created. There is no path from this failure to a new
        // skill: the registry has no method that would take one.
        throw new ToolError('TOOL_NOT_FOUND', `No skill named "${input.skillId}".`, {
          userMessage:
            `There is no workflow called "${input.skillId}". Use skills.list to see what ` +
            'exists — workflows cannot be created at run time.',
          retryable: false,
        });
      }

      const security = deps.securityFor(context.taskId);
      if (!security) {
        throw new ToolError(
          'INTERNAL_ERROR',
          'This skill call carries no security context, so it cannot be authorised.',
        );
      }

      const runId = newId('skillrun');
      await deps.runs?.start({
        runId,
        taskId: context.taskId,
        skillId: resolved.definition.id,
        skillVersion: resolved.definition.version,
        skillHash: resolved.hash,
        totalSteps: resolved.definition.steps.length,
        taintState: security.taintState,
      });
      await deps.audit?.({
        type: 'skill.started',
        taskId: context.taskId,
        skillId: resolved.definition.id,
        skillVersion: resolved.definition.version,
        skillHash: resolved.hash,
        outcome: 'info',
      });

      let result: SkillRunResult;
      try {
        result = await deps.runner.run(resolved, input.inputs ?? {}, {
          taskId: context.taskId,
          sessionId: context.sessionId,
          toolCallId: context.toolCallId,
          ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
          taintState: security.taintState,
          taintSalt: security.taintSalt,
          saltEpoch: security.saltEpoch,
          signal: context.signal,
        });
      } catch (error) {
        await deps.runs?.settle(runId, 'failed');
        if (error instanceof SkillInputError) {
          throw new ToolError('INVALID_ARGUMENT', 'The workflow inputs were not usable.', {
            userMessage: error.message,
            retryable: false,
          });
        }
        throw error;
      }

      await deps.runs?.settle(
        runId,
        result.status === 'completed'
          ? 'completed'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      );
      await deps.audit?.({
        type: 'skill.finished',
        taskId: context.taskId,
        skillId: result.skillId,
        skillVersion: result.skillVersion,
        skillHash: result.skillHash,
        outcome: result.status === 'completed' ? 'allowed' : 'failed',
        code: result.status,
      });

      log.info('Skill run finished.', {
        taskId: context.taskId,
        skill: `${result.skillId}@${result.skillVersion}`,
        status: result.status,
        steps: result.steps.length,
      });

      if (result.status !== 'completed') {
        // A refusal inside a skill is reported as a tool failure rather than
        // a success with a sad summary, so the model cannot read a blocked
        // step as a completed one.
        throw new ToolError(failureCode(result), result.summary, {
          userMessage: result.summary,
          technicalDetails: describeSteps(result),
          retryable: false,
        });
      }

      return {
        success: true,
        data: {
          skill: `${result.skillId}@${result.skillVersion}`,
          status: result.status,
          summary: result.summary,
          steps: result.steps.map((step) => ({
            step: step.stepId,
            ran: step.ran,
            status: step.status,
          })),
          outputs: result.outputs,
        },
        // Whatever the steps read, the task now carries. The runner collects
        // it from each dispatch; reporting it here is what makes it the
        // task's rather than the run's.
        taint: result.taint,
        evidence: result.evidence,
      };
    },
  };
}

function resolve(
  registry: SkillRegistry,
  id: string,
  version: string | undefined,
): ReturnType<SkillRegistry['get']> {
  // An explicit version binds exactly; an omitted one resolves once, here, and
  // the resolved version is what the run records. Neither path re-resolves
  // later, so registering a new version mid-run cannot change what executes.
  return version === undefined ? registry.latest(id) : registry.get(id, version);
}

/**
 * Why the run stopped, in the canonical vocabulary.
 *
 * A failed step's own code is preferred over a generic one: a skill that
 * stopped because a write was denied failed with `PERMISSION_DENIED`, and
 * flattening that to a generic execution failure would lose both the reason
 * and the retry classification that goes with it.
 */
function failureCode(result: SkillRunResult): ErrorCode {
  if (result.status === 'cancelled') return 'USER_CANCELLED';
  if (result.status === 'refused') return 'POLICY_BLOCKED';
  const failed = result.steps.find((step) => step.status === 'failed');
  const code = failed?.error?.code;
  if (code !== undefined && (ERROR_CODES as readonly string[]).includes(code)) {
    return code as ErrorCode;
  }
  const skipped = result.steps.some((step) => step.status === 'skipped');
  return skipped ? 'BUDGET_EXHAUSTED' : 'INTERNAL_ERROR';
}

function describeSteps(result: SkillRunResult): string {
  return result.steps
    .map((step) => `${step.stepId}=${step.status}${step.error ? ` (${step.error.code})` : ''}`)
    .join(', ');
}
