/**
 * The planning turn: asking the model what it intends to do, before it can do
 * anything.
 *
 * One provider request, no tools, no dispatch. Nothing here executes, so this
 * is not a second execution path — a tool call can still only happen through
 * `ToolRegistry.dispatch`, and this turn cannot produce one. What it produces
 * is a `PlanProposal`, which authorizes nothing until a person approves it
 * through the panel.
 *
 * The request goes out the same way every other provider request does, with
 * the same egress context, so a task that has already read a page is judged by
 * the same gate when it asks for a re-proposal as when it asks for an action.
 */
import { getLogger } from '@/logging/logger';
import { newId } from '@/utils/ids';
import type { AIProviderAdapter, CanonicalRequest } from '@/providers/core/types';
import { taintSignature } from '@/security/egress/consent';
import { buildProposal, MAX_PROPOSED_SITES, type PlanProposal } from '@/policy/plan-model';
import type { AgentTask } from '@/tasks/task-model';

const log = getLogger('agent');

/**
 * What the model is asked for.
 *
 * Deliberately narrow. The model is not asked to assess risk, to decide what
 * needs approval, or to say whether anything is safe: every one of those is a
 * decision the policy engine takes from observed facts, and a model that
 * answered them would be answering questions nobody is going to read.
 *
 * It is asked for two things a person can check by looking: where the work
 * will happen, and what the approach is.
 */
export const PLAN_INSTRUCTION = [
  'You are a browser agent. Before doing anything, describe how you intend to approach the',
  "user's objective, and list the websites you will need to visit.",
  '',
  'Reply with a single JSON object and nothing else:',
  '',
  '{"approach": "two or three sentences, plain language", "sites": ["example.com", "..."]}',
  '',
  `List at most ${MAX_PROPOSED_SITES} sites, as bare domains without a scheme or path.`,
  'List only sites the objective actually requires. A site you list is a site the user will be',
  'asked to approve, and a longer list is not a better plan.',
  'If the objective needs no particular site, use an empty list.',
  '',
  'Do not call any tool. Do not begin the task. This reply is a proposal, not an action:',
  'nothing you write here permits anything, and the user decides what happens next.',
].join('\n');

export interface PlanTurnInput {
  readonly task: AgentTask;
  readonly provider: AIProviderAdapter;
  readonly signal: AbortSignal;
  readonly now: number;
}

/**
 * Asks the model for a proposal and normalises whatever comes back.
 *
 * Never throws for a bad reply. A model that answers with prose, with broken
 * JSON, or with a `sites` value that is not a list of strings produces a
 * proposal with no sites and its text kept as the approach — which is the
 * fail-closed direction: an empty plan authorises nothing, so every changing
 * action asks, exactly as it would without a plan at all. The person can still
 * approve it, and still approve sites one at a time as the run reaches them.
 *
 * A provider failure is a different thing and does throw: no answer at all is
 * not a proposal, and the caller parks or fails the task rather than showing
 * somebody an empty plan the model never wrote.
 */
export async function requestPlanProposal(input: PlanTurnInput): Promise<PlanProposal> {
  const { task } = input;
  const request: CanonicalRequest = {
    systemInstruction: PLAN_INSTRUCTION,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: task.objective },
          ...(task.planRevisionNote === undefined
            ? []
            : [
                {
                  type: 'text' as const,
                  text: `The user asked you to change the previous plan: ${task.planRevisionNote}`,
                },
              ]),
        ],
      },
    ],
    // No tools are offered, and none are permitted. A planning turn that could
    // call a tool would be a planning turn that could act before the plan it
    // is proposing has been approved.
    tools: [],
    toolChoice: 'none',
    temperature: 0,
    signal: input.signal,
    egress: {
      taskId: task.id,
      taintState: task.taintState,
      taintSalt: task.taintSalt,
      saltEpoch: task.saltEpoch,
      taintSignature: await taintSignature(task.taintState),
      providerId: task.providerId,
      ...(task.connectionId === undefined ? {} : { connectionId: task.connectionId }),
      modelId: task.modelId,
    },
  };

  const response = await input.provider.generate(request);
  const parsed = parsePlanReply(response.text);
  if (parsed === null) {
    log.warn('The model did not answer the planning turn with a usable proposal.', {
      taskId: task.id,
    });
  }

  return buildProposal({
    proposalId: newId('proposal'),
    taskId: task.id,
    approachText: parsed?.approach ?? response.text.trim(),
    sites: parsed?.sites ?? [],
    now: input.now,
  });
}

/**
 * Pulls the proposal out of the model's reply.
 *
 * Tolerant about the wrapping — a fenced block, a sentence before the JSON —
 * and strict about the contents. `sites` must be an array of strings or the
 * whole reply is treated as unparsed: silently keeping the string entries out
 * of a mixed array would turn a malformed answer into a shorter plan that
 * looks deliberate.
 */
function parsePlanReply(text: string): { approach: string; sites: string[] } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const sites = record['sites'];
  if (!Array.isArray(sites) || sites.some((entry) => typeof entry !== 'string')) return null;
  const approach = record['approach'];

  return {
    approach: typeof approach === 'string' ? approach : '',
    sites: sites as string[],
  };
}
