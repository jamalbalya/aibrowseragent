/**
 * What a shortcut is (P-021).
 *
 * A shortcut is a **name**. It holds a reference to something that already
 * exists and has already been reviewed — a stored workflow or a bundled skill
 * — and nothing else. There is no field for steps, tool arguments, a prompt,
 * a selector or code, because a shortcut is not a thing that runs. It is a
 * thing that *names* something that runs.
 *
 * That is the whole security story, and it is worth stating plainly because
 * the obvious implementation of "slash commands" is a little interpreter that
 * expands a name into a command line. This one cannot expand into anything: a
 * name resolves to an id, the id is looked up in the store or the registry
 * that owns it, and execution goes through the route that already existed for
 * that kind of target. A shortcut adds an alias, not a capability, and
 * therefore grants no authority and pre-approves nothing.
 *
 * **Names are identifiers, not patterns.** There is no matching, no globbing,
 * no regular expression and no fuzzy lookup anywhere in this module. A name
 * either equals a stored one after normalisation or it does not exist.
 */

/** Bumped when the stored shape changes in a way an older reader cannot parse. */
export const SHORTCUT_FORMAT_VERSION = 1;

/**
 * What a shortcut points at.
 *
 * A discriminated reference, never a definition. `workflowId`, `skillId` and
 * `skillVersion` are authoritative identifiers resolved against the store and
 * the registry that own them — never display names, which two objects can
 * share and which a user can change.
 */
export type ShortcutTarget =
  | { readonly kind: 'workflow'; readonly workflowId: string }
  | { readonly kind: 'skill'; readonly skillId: string; readonly skillVersion: string }
  | { readonly kind: 'prompt'; readonly objective: string };

export const SHORTCUT_TARGET_KINDS: readonly ShortcutTarget['kind'][] = [
  'workflow',
  'skill',
  'prompt',
];

/**
 * Longest objective a saved prompt may hold.
 *
 * Bounded because it is stored and re-sent, not because length is dangerous:
 * an objective is the same text the composer already accepts.
 */
export const MAX_SHORTCUT_OBJECTIVE = 2_000;

/**
 * A saved objective: the third kind of target, and the one that is content
 * rather than a reference.
 *
 * Worth being exact about why that is allowed here when the whole module says
 * a shortcut holds no content. An objective is not a definition of what will
 * run — it is the task's own top-level input, the same string the person
 * types into the composer, and it reaches exactly one place: `task.create`.
 * It names no tool, carries no arguments, selects no element and cannot be
 * interpreted as anything but an objective, so a saved prompt grants precisely
 * what typing it would grant, which is nothing. Every action the model then
 * takes is classified, policy-checked and approved exactly as it would have
 * been, and `PROHIBITED_FIELDS` below still refuses `prompt` and
 * `instructions` — a shortcut may hold the objective *as its whole target*,
 * never a second instruction channel bolted to another one.
 *
 * Authored only through the panel's CLASS_B route. No `shortcut.*` tool
 * exists, so no model can write one, and nothing in this build reads a stored
 * objective as anything other than user-authored text at the trust level the
 * system instruction already assigns to the user's objective.
 */
export function isUsableObjective(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_SHORTCUT_OBJECTIVE
  );
}

/**
 * A shortcut as it is stored.
 *
 * Three names, for three different jobs, and conflating them is how a
 * shortcut would come to mean something other than what the user chose:
 *
 *  - `displayName` is what they typed, shown back to them verbatim.
 *  - `name` is the normalised form a typed `/command` is looked up by.
 *  - `skeleton` is the confusability key, which only ever decides whether a
 *    *new* shortcut may be created. Nothing is ever looked up by it.
 */
import type { PermissionMode } from '@/policy/policy-engine';

/**
 * The permission profiles a shortcut may name (§50).
 *
 * One member, and the reason is the whole of the design. A profile may only
 * ever make a run **stricter**: `manual` is the strictest mode this build has,
 * so there is exactly one tightening to express and exactly one name for it.
 *
 * What a profile deliberately cannot be is a *grant*. §50's example value is
 * `"qa-default"`, which reads as a user-defined profile — and a user-defined
 * profile that could select `auto` or `skip` would be a stored escalation of
 * the ambient permission mode, which is the one thing the workflow and
 * shortcut design refuses: a recording never becomes a standing grant, and
 * replay re-earns every permission. A profile store would also be a second
 * authorization surface with nothing to add, because the set of safe
 * tightenings is this list.
 *
 * So an unrecognised profile name is **refused** rather than ignored. Ignoring
 * one would leave a shortcut that reads as stricter than it is, which is worse
 * than not offering the field.
 */
export const SHORTCUT_PERMISSION_PROFILES = ['confirm-each-action'] as const;
export type ShortcutPermissionProfile = (typeof SHORTCUT_PERMISSION_PROFILES)[number];

/** How many tools a shortcut's narrowing list may name. */
export const MAX_SHORTCUT_ALLOWED_TOOLS = 64;

export interface ShortcutRecord {
  readonly shortcutId: string;
  readonly formatVersion: number;
  /** Exactly what the user typed, for display. Never used for lookup. */
  readonly displayName: string;
  /** The normalised lookup key. Unique. */
  readonly name: string;
  /** The confusability key. Unique. Never a lookup key. */
  readonly skeleton: string;
  readonly target: ShortcutTarget;
  /**
   * Tools the run this shortcut starts may use (§50 `allowedTools`).
   *
   * A **narrowing**, never a grant, and the distinction is what makes the
   * field safe to store. Every name here must already be a registered tool;
   * the list cannot bring one into existence, cannot raise what one may do,
   * and cannot pre-approve a call. What it does is remove tools from the set
   * the model is offered *and* from the set it may reach — both halves,
   * because narrowing the offer alone is not a constraint if the model can
   * still name what it was not offered.
   *
   * Absent means no narrowing. An **empty array also means no narrowing**,
   * matching §50's own example, which shows `"allowedTools": []` on a shortcut
   * that plainly does something. A shortcut that may use no tools at all is
   * therefore not expressible, which is stated rather than hidden.
   */
  readonly allowedTools?: readonly string[];
  /**
   * A permission profile for the run (§50 `permissionProfile`).
   *
   * Tightening only. See `SHORTCUT_PERMISSION_PROFILES`.
   */
  readonly permissionProfile?: ShortcutPermissionProfile;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The permission mode a profile asks for.
 *
 * Only ever consulted through `strictestMode`, so the value here is a *floor*
 * on strictness rather than the mode a run gets. A profile that named `skip`
 * would therefore still not loosen anything — and no profile names it, because
 * a loosening profile is the thing this design refuses.
 */
export const SHORTCUT_PROFILE_MODE: Record<ShortcutPermissionProfile, PermissionMode> = {
  'confirm-each-action': 'manual',
};

/** Whether a name is one of the profiles this build implements. */
export function isShortcutPermissionProfile(value: unknown): value is ShortcutPermissionProfile {
  return (
    typeof value === 'string' && (SHORTCUT_PERMISSION_PROFILES as readonly string[]).includes(value)
  );
}

/**
 * Normalises a proposed `allowedTools` list, or refuses it.
 *
 * Names are checked for *shape* here and for *existence* at launch, and the
 * split matters: a tool set changes when a server is added or removed, so a
 * name that resolves today may not tomorrow. Refusing at storage time on a
 * name the registry does not currently know would make a shortcut undeletable
 * by being uncreatable; refusing at launch tells the user at the moment it
 * matters.
 */
export function normaliseAllowedTools(
  value: unknown,
):
  | { readonly ok: true; readonly tools: readonly string[] }
  | { readonly ok: false; readonly detail: string } {
  if (value === undefined) return { ok: true, tools: [] };
  if (!Array.isArray(value)) return { ok: false, detail: 'allowedTools must be a list of names' };
  if (value.length > MAX_SHORTCUT_ALLOWED_TOOLS) {
    return {
      ok: false,
      detail: `a shortcut may name at most ${MAX_SHORTCUT_ALLOWED_TOOLS} tools`,
    };
  }
  const tools: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return { ok: false, detail: 'every entry in allowedTools must be a tool name' };
    }
    const name = entry.trim();
    // The charset both built-in (`family.verb`) and MCP (`mcp__server__tool`)
    // names live in. A name outside it cannot be a registered tool, so it
    // could only ever narrow to nothing while looking like a constraint.
    if (name.length === 0 || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      return { ok: false, detail: `"${entry.slice(0, 40)}" is not a usable tool name` };
    }
    if (!tools.includes(name)) tools.push(name);
  }
  return { ok: true, tools };
}

/**
 * Field names a stored shortcut may never carry, at any depth.
 *
 * A shortcut is a reference, so anything that looks like a definition, a
 * payload or a credential is a shortcut that has grown into something else.
 * The check is recursive because one level of nesting is exactly the shape a
 * caller reaches for when a flat field is refused.
 */
const PROHIBITED_FIELDS: ReadonlySet<string> = new Set(
  [
    // A definition, rather than a reference to one.
    'steps',
    'step',
    'definition',
    'arguments',
    'args',
    'inputs',
    'tool',
    'tools',
    'skill',
    'workflow',
    'binding',
    'bindings',
    // Anything executable, or anything that would be interpreted.
    'code',
    'script',
    'expression',
    'selector',
    'selectors',
    'xpath',
    'template',
    'prompt',
    'instructions',
    'command',
    // Data that has no business in a naming layer.
    'result',
    'results',
    'outputs',
    'payload',
    'content',
    'body',
    'evidence',
    'password',
    'secret',
    'token',
    'credential',
    'credentials',
    'cookie',
    'cookies',
    'authorization',
  ].map((name) => name.toLowerCase()),
);

const MAX_SHORTCUT_DEPTH = 6;

export class ProhibitedShortcutFieldError extends Error {
  constructor(readonly field: string) {
    super(
      `A shortcut may not carry "${field}". A shortcut is a name pointing at something that ` +
        'already exists; it never holds the steps, arguments or code of what it points at.',
    );
    this.name = 'ProhibitedShortcutFieldError';
  }
}

/** Rejects a shortcut that grew a field it should not have. */
export function assertShortcutSafe(value: Record<string, unknown>): void {
  walk(value, [], 0);
}

function walk(value: unknown, path: readonly string[], depth: number): void {
  if (depth > MAX_SHORTCUT_DEPTH) {
    throw new ProhibitedShortcutFieldError(path.join('.') || '(root)');
  }
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) walk(item, [...path, String(index)], depth + 1);
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (PROHIBITED_FIELDS.has(key.toLowerCase())) {
      throw new ProhibitedShortcutFieldError([...path, key].join('.'));
    }
    walk(nested, [...path, key], depth + 1);
  }
}

/**
 * Whether a stored record still has the shape this build can use.
 *
 * Called on the way out of storage as well as in. A record that was edited
 * underneath the store — by a partial write, or by something writing to
 * extension storage directly — must not resolve to anything.
 */
export function isUsableShortcut(value: unknown): value is ShortcutRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<ShortcutRecord>;
  if (record.formatVersion !== SHORTCUT_FORMAT_VERSION) return false;
  if (typeof record.shortcutId !== 'string' || record.shortcutId.length === 0) return false;
  if (typeof record.name !== 'string' || record.name.length === 0) return false;
  if (typeof record.skeleton !== 'string' || record.skeleton.length === 0) return false;
  if (typeof record.displayName !== 'string') return false;

  const target = record.target;
  if (target === null || typeof target !== 'object') return false;
  if (target.kind === 'workflow') {
    return typeof target.workflowId === 'string' && target.workflowId.length > 0;
  }
  if (target.kind === 'skill') {
    return (
      typeof target.skillId === 'string' &&
      target.skillId.length > 0 &&
      typeof target.skillVersion === 'string' &&
      /^\d+\.\d+\.\d+$/.test(target.skillVersion)
    );
  }
  if (target.kind === 'prompt') {
    // Exactly two keys. A prompt target that grew a third is a target that is
    // carrying something beside the objective, which is the one thing this
    // kind is allowed to hold.
    const keys = Object.keys(target).sort();
    return keys.length === 2 && keys[0] === 'kind' && keys[1] === 'objective'
      ? isUsableObjective((target as { objective?: unknown }).objective)
      : false;
  }
  return false;
}
