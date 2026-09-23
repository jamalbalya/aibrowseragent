/**
 * Field-level portability for the two records the export does not carry.
 *
 * `EXPORT_PORTABILITY` says whether a *kind* may travel. Tasks and workspaces
 * are both `REQUIRES_FURTHER_SECURITY_DESIGN` there, and that is a decision
 * about the record as a whole. Doing the design means going a level down: not
 * "may a task travel" but "what, field by field, would have to happen to each
 * value for a task to arrive somewhere else without bringing a security
 * assertion with it".
 *
 * These tables are that design, written as code rather than prose for the
 * reason the classification table is: `Record<keyof AgentTask, …>` is total,
 * so a field added to the model does not compile until somebody has decided
 * what happens to it at an installation boundary. A design document cannot
 * fail; this can.
 *
 * **Nothing here exports anything.** No caller builds a document from these
 * tables, and `EXPORT_PORTABILITY` still refuses both kinds. This is the
 * design that would have to be reviewed and accepted before an implementation
 * phase, and the record of the reasoning while it is fresh.
 *
 * ## The rule the whole design follows
 *
 * An imported task or workspace is **data about something that happened
 * elsewhere**. It is never evidence, never a measurement, never a permission
 * and never a pointer into this installation's live state. Where a field
 * carries a security assertion, the destination does not read the incoming
 * value at all — it starts from the conservative one and measures again.
 * Transporting the assertion would let a file decide something the
 * destination is supposed to decide for itself.
 */
import type { AgentTask } from '@/tasks/task-model';
import type { Workspace, WorkspaceMember } from '@/workspaces/workspace-model';

export const FIELD_PORTABILITY_CLASSES = [
  /** Copied as-is. Carries no content from a page and no security meaning. */
  'PORTABLE',
  /** Travels with fields dropped or rewritten on the way out. */
  'PORTABLE_AFTER_TRANSFORMATION',
  /** Meaningful only on the installation that wrote it. Not sent. */
  'LOCAL_ONLY',
  /** The destination writes its own value and ignores any incoming one. */
  'REGENERATED_ON_IMPORT',
  /** Key material. Never leaves the device under any transformation. */
  'SECRET',
  /**
   * A security decision. Never transported; the destination starts from the
   * conservative value and measures again for itself.
   */
  'SECURITY_SENSITIVE',
  /** Excluded on purpose — usually page-derived content or a live handle. */
  'NOT_PORTABLE_BY_DESIGN',
] as const;
export type FieldPortability = (typeof FIELD_PORTABILITY_CLASSES)[number];

/**
 * Every field of `AgentTask`, and what would become of it.
 *
 * Traced against actual reads and writes, not field names. `taintSalt` reads
 * as a label and is an HMAC key; `tabs[].tabId` reads as data and is a live
 * Chrome handle; `usage` reads as telemetry and is eight integers that quote
 * nothing.
 */
export const TASK_FIELD_PORTABILITY: Readonly<Record<keyof AgentTask, FieldPortability>> = {
  // Identity and placement. A foreign id is not a name, it is a claim about
  // which row this is; honouring one lets a file address a record that
  // already exists here.
  id: 'REGENERATED_ON_IMPORT',
  sessionId: 'REGENERATED_ON_IMPORT',
  updatedAt: 'REGENERATED_ON_IMPORT',
  /** Reset at the boundary; see `saltEpoch` under SECRET below. */
  saltEpoch: 'REGENERATED_ON_IMPORT',

  // What the user actually wrote. The reason any of this is worth carrying.
  objective: 'PORTABLE',
  createdAt: 'PORTABLE',
  startedAt: 'PORTABLE',
  finishedAt: 'PORTABLE',
  // Eight counters. No content, no origin, no identifier.
  usage: 'PORTABLE',

  // Provenance, not selection. Naming the model a task ran on is history;
  // *selecting* it here would let a file choose this installation's provider.
  providerId: 'PORTABLE_AFTER_TRANSFORMATION',
  modelId: 'PORTABLE_AFTER_TRANSFORMATION',
  // The canonical code survives; `message`, `userMessage` and
  // `technicalDetails` do not, because each is free text that routinely
  // quotes what the page or the provider said.
  error: 'PORTABLE_AFTER_TRANSFORMATION',
  // Forced to an archived, non-resumable state whatever the file says. A task
  // that arrived mid-flight and resumed would be executing a plan formed
  // against a page this browser has never seen.
  state: 'PORTABLE_AFTER_TRANSFORMATION',

  // Security decisions. The destination starts conservative and measures.
  //
  // `taintState` is monotone by construction — it only ever widens — and an
  // imported value could only narrow it. Accepting `KNOWN_UNTAINTED` from a
  // file is the taint downgrade the whole egress gate exists to prevent, so
  // an imported task begins at UNKNOWN, which the gate treats as a denial.
  taintState: 'SECURITY_SENSITIVE',
  // This installation's own mode governs, read from its settings. A task
  // arriving with `skip` would be a file lowering the permission bar.
  permissionMode: 'SECURITY_SENSITIVE',

  // Per-task HMAC key for evidence digests. Hex-encoded 32 bytes. Exporting
  // it publishes the key that makes every digest in the trail verifiable and
  // forgeable; the destination mints its own and starts a new epoch.
  taintSalt: 'SECRET',

  // Pointers into live local state.
  //
  // `connectionId` names a credential-bearing account that exists on the
  // source device; `workspaceId` names a Chrome tab group that will not exist
  // here. Both would be dangling at best, and at worst would alias a
  // different account or workspace that happens to share the id.
  connectionId: 'NOT_PORTABLE_BY_DESIGN',
  workspaceId: 'NOT_PORTABLE_BY_DESIGN',

  // Page-derived content and execution history.
  //
  // `tabs[].tabId` is a live browser handle; `tabs[].url` and `.origin` are
  // browsing history. `steps[].summary` is generated text that routinely
  // quotes the page, and each step carries `evidenceIds` and a risk verdict.
  // `plan` is revised from what the agent read. `currentStepSummary` is the
  // same text one level up. `result` carries `externalWrites`, which is a
  // list of destinations the task actually sent things to.
  tabs: 'NOT_PORTABLE_BY_DESIGN',
  steps: 'NOT_PORTABLE_BY_DESIGN',
  plan: 'NOT_PORTABLE_BY_DESIGN',
  currentStepSummary: 'NOT_PORTABLE_BY_DESIGN',
  result: 'NOT_PORTABLE_BY_DESIGN',
  // Resolve to evidence records this installation does not have, and evidence
  // is itself NOT_PORTABLE_BY_DESIGN. Carrying the ids would produce a task
  // that appears to cite proof and cites nothing.
  evidenceIds: 'NOT_PORTABLE_BY_DESIGN',
};

/** Every field of the durable `Workspace` record. */
export const WORKSPACE_FIELD_PORTABILITY: Readonly<Record<keyof Workspace, FieldPortability>> = {
  workspaceId: 'REGENERATED_ON_IMPORT',
  lastActiveAt: 'REGENERATED_ON_IMPORT',
  // Ownership is the destination's to assign, from its own local identity.
  // An imported `abaUserId` is how two installations come to claim one owner.
  abaUserId: 'NOT_PORTABLE_BY_DESIGN',
  // What the user named it. The only field anybody would miss.
  title: 'PORTABLE',
  createdAt: 'PORTABLE',
  // Tab origins and titles: browsing history, in a file the user may mail.
  // See `WORKSPACE_MEMBER_FIELD_PORTABILITY` for the field-level reasoning.
  members: 'NOT_PORTABLE_BY_DESIGN',
};

export const WORKSPACE_MEMBER_FIELD_PORTABILITY: Readonly<
  Record<keyof WorkspaceMember, FieldPortability>
> = {
  // The two that decide it. An origin list is a record of where somebody
  // browses, and a tab title is page-authored text.
  origin: 'NOT_PORTABLE_BY_DESIGN',
  title: 'NOT_PORTABLE_BY_DESIGN',
  // Meaningless without the member they belong to.
  addedAt: 'LOCAL_ONLY',
  openedByAgent: 'LOCAL_ONLY',
};

/**
 * Fields whose incoming value is never read, whatever a file says.
 *
 * The list an implementation would assert against. Derived rather than
 * written twice, so it cannot drift from the tables above.
 */
export const NEVER_CROSSES_INSTALLATION_BOUNDARY: readonly string[] = [
  ...Object.entries(TASK_FIELD_PORTABILITY),
  ...Object.entries(WORKSPACE_FIELD_PORTABILITY),
]
  .filter(([, portability]) =>
    (['SECRET', 'SECURITY_SENSITIVE', 'NOT_PORTABLE_BY_DESIGN'] as FieldPortability[]).includes(
      portability,
    ),
  )
  .map(([field]) => field);
