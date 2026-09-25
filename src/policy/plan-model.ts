/**
 * The Classic plan: a task-scoped list of sites the user authorised up front.
 *
 * Two objects, not one, and that is the whole design. A model writes a
 * `PlanProposal`; a person approves it; approval produces a separate
 * `PlanApproval`. The proposal has no approval field — there is nothing on it
 * to flip — so "model wrote it" and "user authorised it" cannot be the same
 * record with a boolean between them. A single mutable object with
 * `approved: true` would mean every code path that can reach the object can
 * grant authority, which is the shape this deliberately does not have.
 *
 * What a plan is, exactly: an additional *source* of the same site
 * authorization Phase A+B already built, with a task's lifetime instead of a
 * durable one. It is not a second policy engine, it carries no risk ceiling of
 * its own, and it reaches `evaluatePolicy` at the one existing call site
 * alongside `SiteRule`. Every deny stage runs before it is consulted, so a
 * plan cannot clear a prohibition, a refusal, an exfiltration block, the R3
 * floor, the unattended boundary or origin drift.
 *
 * Deliberately *not* here: the approach text as an enforced constraint. The
 * comparison product's own documentation describes a plan "specifying websites
 * and approach" and says only that the listed *websites* bound the run — see
 * `docs/architecture/CLAUDE_BENCHMARK.md` §1, which records that as E1
 * documentary evidence and holds no direct observation of the shipping
 * product. The site half of that is machine-checkable and the approach half is
 * not. A field that looked enforced and was not would be worse than an absent
 * one, so the approach is carried for the person to read and for nothing else.
 */
import { siteOf, parseOrigin } from '@/security/origin/origin-validator';

/**
 * The two authorization shapes a task can run under.
 *
 *  - `cowork`: every changing action is authorised on its own, as it comes.
 *    This is what the product already did, and it stays the default.
 *  - `classic`: the person authorises a boundary once, up front, and the run
 *    proceeds inside it. Everything a plan cannot cover — a prohibition, an
 *    R3+ action, an origin drift, an unapproved site — still stops and asks.
 *
 * Two shapes, not a spectrum, and not a mode that can be changed mid-run.
 */
export const AUTHORIZATION_MODELS = ['classic', 'cowork'] as const;
export type AuthorizationModel = (typeof AUTHORIZATION_MODELS)[number];

/**
 * The highest risk a plan can cover on its own.
 *
 * The same ceiling a standing site grant has, and deliberately the same
 * constant family: a plan is a *source* of site authorization with a task's
 * lifetime, not a broader kind of permission. Anything at R3 or above returns
 * from the risk floor before this is ever consulted, so the ceiling is a
 * second statement of a bound the engine already enforces rather than the only
 * one.
 */
export const PLAN_MAX_RISK = 'R2' as const;

/**
 * Longest revision note carried into a re-proposal.
 *
 * Bounded because it is text that ends up in a provider request, not because
 * it is dangerous: it steers a suggestion and authorises nothing.
 */
export const MAX_REVISION_NOTE = 500;

/**
 * What the model proposed. Authorizes nothing.
 *
 * `proposedBy` is a literal rather than a provider id: which brain wrote the
 * proposal must not be an input to any authorization decision, and a field
 * holding one would eventually be read as though it were.
 */
export interface PlanProposal {
  readonly proposalId: string;
  readonly taskId: string;
  readonly proposedAt: number;
  readonly proposedBy: 'model';
  /** Shown to the person. Never consulted by policy. */
  readonly approachText: string;
  /** Registrable domains, normalised at intake. */
  readonly proposedSites: readonly string[];
}

/**
 * How an approval came to exist. One member, on purpose.
 *
 * A union with a single value cannot express a model-, page-, plugin- or
 * scheduler-originated approval: there is no such string to write. The same
 * technique as Gate 1's `purpose: 'ELEMENT_BINDING'`, and for the same reason
 * — an invariant the type system holds is one nobody has to remember.
 */
export const APPROVAL_PROVENANCE = 'USER_PANEL_ACTION' as const;
export type ApprovalProvenance = typeof APPROVAL_PROVENANCE;

/** What the user authorised. This is the security authority. */
export interface PlanApproval {
  readonly planId: string;
  readonly taskId: string;
  /** Starts at 1. Every amendment is a new version, never an edit. */
  readonly version: number;
  readonly approvedSites: readonly string[];
  readonly approvedAt: number;
  readonly approvalProvenance: ApprovalProvenance;
  /** `planId@version` of the approval this one replaced, for the trail. */
  readonly supersedes?: string;
}

/**
 * Normalises a proposed site to the key a `SiteRule` would use.
 *
 * The same `siteOf` the rest of the policy layer uses, so a plan and a
 * standing grant cannot disagree about what "a site" is. Anything unparseable
 * is dropped rather than stored: a plan entry that matches nothing is
 * harmless, and one that matches more than intended is not.
 */
function normaliseSite(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  const parsed = parseOrigin(trimmed) ?? parseOrigin(`https://${trimmed}`);
  if (parsed) return parsed.site;
  // A bare hostname the URL parser refused. Accept only what looks like one.
  return /^[a-z0-9.-]+$/i.test(trimmed) ? siteOf(trimmed) : null;
}

/** Longest site list a proposal may carry. A plan nobody reads is not consent. */
export const MAX_PROPOSED_SITES = 20;

/**
 * Builds a proposal from whatever the model produced.
 *
 * Normalises and bounds rather than trusting: the sites are model output, and
 * the list is what a person is about to authorise in one click. Duplicates are
 * collapsed so the same site cannot be padded to fill the list.
 */
export function buildProposal(input: {
  readonly proposalId: string;
  readonly taskId: string;
  readonly approachText: string;
  readonly sites: readonly string[];
  readonly now: number;
}): PlanProposal {
  const seen = new Set<string>();
  for (const candidate of input.sites) {
    const site = normaliseSite(candidate);
    if (site && !seen.has(site)) seen.add(site);
    if (seen.size >= MAX_PROPOSED_SITES) break;
  }
  return {
    proposalId: input.proposalId,
    taskId: input.taskId,
    proposedAt: input.now,
    proposedBy: 'model',
    approachText: input.approachText.slice(0, 2000),
    proposedSites: [...seen],
  };
}

/**
 * The only producer of a `PlanApproval`.
 *
 * Reachable from one place: the panel's approval route, which route trust
 * restricts to `CLASS_B_PANEL_CONTROL_PLANE` — a channel only the side panel
 * document can reach. A test asserts the single call site, because the
 * guarantee is "one producer", not "one producer today".
 *
 * `approvedSites` is copied, not referenced. Holding the proposal's array
 * would mean a later mutation of the proposal reached the approval, and the
 * separation of the two objects would be cosmetic.
 */
export function approvePlan(proposal: PlanProposal, planId: string, now: number): PlanApproval {
  return {
    planId,
    taskId: proposal.taskId,
    version: 1,
    approvedSites: [...proposal.proposedSites],
    approvedAt: now,
    approvalProvenance: APPROVAL_PROVENANCE,
  };
}

/**
 * Adds one site the user approved during the run.
 *
 * A new version rather than an edit. The previous version is left intact for
 * the trail, and `supersedes` names it — so "what was authorised when this
 * action ran" stays answerable after the fact, which an in-place edit would
 * destroy.
 *
 * Returns the approval unchanged when the site is already covered or cannot be
 * normalised, so a version number never advances without a real change.
 */
export function amendPlan(approval: PlanApproval, candidate: string, now: number): PlanApproval {
  const site = normaliseSite(candidate);
  if (site === null || approval.approvedSites.includes(site)) return approval;
  return {
    ...approval,
    version: approval.version + 1,
    approvedSites: [...approval.approvedSites, site],
    approvedAt: now,
    supersedes: `${approval.planId}@${approval.version}`,
  };
}

/**
 * Whether an approved plan covers a URL.
 *
 * Compared at the registrable domain, matching `SiteRule`. An unparseable URL
 * is not covered — not knowing which site a call is on is never evidence that
 * the plan allows it.
 */
export function planCoversSite(approval: PlanApproval | undefined, url: string): boolean {
  if (!approval) return false;
  const parsed = parseOrigin(url);
  if (!parsed) return false;
  return approval.approvedSites.includes(parsed.site);
}

/**
 * Normalises a record read back from storage, for one named task.
 *
 * Anything that is not a well-formed approval becomes `undefined`, which
 * downstream is "no plan authorization" rather than "no restriction". A
 * malformed approval is not a weaker approval; it is none.
 *
 * `expectedTaskId` is what makes `PlanApproval.taskId` mean something. Until
 * it was passed, the field was written, stored and never compared: an
 * approval found on a task was used to authorise that task whatever it said
 * it was for, so the binding existed in the record and not in the code. A
 * person approved a plan for one objective, and only where the record
 * happened to be kept stopped it authorising another.
 *
 * Omitting it parses without the binding check, which is for callers that are
 * reading a record rather than authorising with one.
 */
export function parsePlanApproval(
  value: unknown,
  expectedTaskId?: string,
): PlanApproval | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  if (typeof record['planId'] !== 'string' || record['planId'].length === 0) return undefined;
  if (typeof record['taskId'] !== 'string' || record['taskId'].length === 0) return undefined;
  // An approval for another task is refused outright rather than stripped of
  // its sites: it is not a weaker authorization for this task, it is none.
  if (expectedTaskId !== undefined && record['taskId'] !== expectedTaskId) return undefined;
  if (typeof record['version'] !== 'number' || !Number.isSafeInteger(record['version'])) {
    return undefined;
  }
  if (record['version'] < 1) return undefined;
  if (typeof record['approvedAt'] !== 'number' || !Number.isFinite(record['approvedAt'])) {
    return undefined;
  }
  // The one provenance there is. A record claiming any other origin is not an
  // approval this build produced, and is refused rather than downgraded.
  if (record['approvalProvenance'] !== APPROVAL_PROVENANCE) return undefined;

  const sites = record['approvedSites'];
  if (!Array.isArray(sites)) return undefined;
  const approvedSites: string[] = [];
  for (const entry of sites) {
    if (typeof entry !== 'string') return undefined;
    const site = normaliseSite(entry);
    if (site === null) return undefined;
    approvedSites.push(site);
  }

  const supersedes = record['supersedes'];
  return {
    planId: record['planId'],
    taskId: record['taskId'],
    version: record['version'],
    approvedSites,
    approvedAt: record['approvedAt'],
    approvalProvenance: APPROVAL_PROVENANCE,
    ...(typeof supersedes === 'string' ? { supersedes } : {}),
  };
}
