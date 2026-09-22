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
  | { readonly kind: 'skill'; readonly skillId: string; readonly skillVersion: string };

export const SHORTCUT_TARGET_KINDS: readonly ShortcutTarget['kind'][] = ['workflow', 'skill'];

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
  readonly createdAt: number;
  readonly updatedAt: number;
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
  return false;
}
