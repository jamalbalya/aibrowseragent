/**
 * Turning what someone typed into a name, or refusing to.
 *
 * Two different questions are answered here and they must not be confused:
 *
 *  - **Normalisation** produces the key a typed `/command` is looked up by.
 *    It is the identity of the shortcut.
 *  - **Skeletonisation** produces a confusability key used for exactly one
 *    thing: deciding whether a *new* shortcut may be created. Nothing is ever
 *    looked up by a skeleton, because two genuinely different names can share
 *    one and resolving through it would run the wrong thing.
 *
 * The rule that follows from that split is the important one: when a new name
 * collides with an existing one — identically, or only after skeletonisation
 * — creation is **refused**. It is never silently merged into the existing
 * shortcut and never silently renamed. Two distinct user choices must not
 * become one executable shortcut, and the user is told which existing name
 * they collided with rather than discovering it by running the wrong thing.
 *
 * Nothing here is a pattern. There is no glob, no fuzzy match and no regular
 * expression applied to user input as a matching language — the one regular
 * expression below is a whitelist the whole name must satisfy, applied after
 * normalisation, and a name that fails it is refused rather than repaired.
 */

/** Long enough for `/qa-regression`, short enough to be a name. */
export const MAX_SHORTCUT_NAME = 48;

/**
 * The only shape a normalised name may have.
 *
 * Lowercase ASCII letters and digits, with single hyphens between them. No
 * leading or trailing hyphen, no repeated hyphen, no underscore, no dot, no
 * slash, no whitespace, no Unicode. Deliberately narrow: every character a
 * name may contain is one that looks like itself.
 */
const SAFE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Characters that read as ASCII but are not.
 *
 * Cyrillic and Greek letters that render identically to Latin ones, plus the
 * digit/letter pairs that are indistinguishable in most UI fonts. Mapped for
 * the skeleton only — never for the stored name, which stays exactly as
 * normalisation produced it.
 *
 * This list is not exhaustive and cannot be: Unicode confusability is open
 * ended. It does not need to be exhaustive to be useful, because the safe
 * shape above already refuses every non-ASCII character outright. The
 * mappings here therefore only matter for the digit/letter pairs, and the
 * Cyrillic and Greek entries exist so that a name which *would* have been
 * confusable is refused at normalisation with a clear reason rather than by
 * failing the shape check with an opaque one.
 */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  // Cyrillic → Latin
  ['а', 'a'],
  ['е', 'e'],
  ['о', 'o'],
  ['р', 'p'],
  ['с', 'c'],
  ['х', 'x'],
  ['у', 'y'],
  ['і', 'i'],
  ['ј', 'j'],
  ['һ', 'h'],
  // Greek → Latin
  ['ο', 'o'],
  ['ρ', 'p'],
  ['ν', 'v'],
  ['α', 'a'],
  // Digit/letter pairs, which are confusable in ASCII alone.
  ['0', 'o'],
  ['1', 'l'],
  ['i', 'l'],
  ['5', 's'],
  ['8', 'b'],
  ['2', 'z'],
  ['rn', 'm'],
]);

export type NameRefusal = 'EMPTY' | 'TOO_LONG' | 'UNSAFE_SYNTAX' | 'CONFUSABLE_CHARACTER';

export type NameVerdict =
  | { readonly ok: true; readonly name: string; readonly skeleton: string }
  | { readonly ok: false; readonly reason: NameRefusal; readonly detail: string };

/**
 * Normalises a typed name, deterministically.
 *
 * The steps are fixed and each one is idempotent, so normalising an already
 * normalised name returns it unchanged — which is what makes a stored name a
 * stable identity rather than something that drifts each time it is read.
 *
 *  1. NFKC, so a compatibility-composed character cannot be a second spelling
 *     of an existing name.
 *  2. Trim, then strip any leading slashes, then trim again — `/  /foo  ` and
 *     `foo` are the same intent typed differently.
 *  3. Case-fold to lowercase.
 *  4. Collapse whitespace and underscores to single hyphens, then collapse
 *     repeated hyphens and strip leading and trailing ones.
 *  5. Refuse anything that is not then the safe shape.
 */
export function normaliseShortcutName(input: string): NameVerdict {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'EMPTY', detail: 'A shortcut needs a name.' };
  }

  const folded = input
    .normalize('NFKC')
    .trim()
    .replace(/^\/+/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (folded.length === 0) {
    return { ok: false, reason: 'EMPTY', detail: 'A shortcut needs a name.' };
  }
  if (folded.length > MAX_SHORTCUT_NAME) {
    return {
      ok: false,
      reason: 'TOO_LONG',
      detail: `A shortcut name is at most ${MAX_SHORTCUT_NAME} characters.`,
    };
  }

  // Reported before the general syntax refusal, because "that character looks
  // like a letter but is not one" is a much more useful thing to be told than
  // "that is not a valid name".
  for (const character of folded) {
    if (character !== '-' && !/[a-z0-9]/.test(character) && CONFUSABLES.has(character)) {
      return {
        ok: false,
        reason: 'CONFUSABLE_CHARACTER',
        detail:
          'That name contains a character that looks like a letter but is not one. ' +
          'Use plain letters, digits and hyphens.',
      };
    }
  }

  if (!SAFE_NAME.test(folded)) {
    return {
      ok: false,
      reason: 'UNSAFE_SYNTAX',
      detail:
        'A shortcut name uses lowercase letters, digits and single hyphens between them — ' +
        'for example qa-regression.',
    };
  }

  return { ok: true, name: folded, skeleton: skeletonOf(folded) };
}

/**
 * The confusability key for a normalised name.
 *
 * Used only to decide whether a new shortcut may be created. Never stored as
 * an identity, never resolved through, never shown to the user.
 */
export function skeletonOf(name: string): string {
  let out = '';
  // `rn` → `m` is the one multi-character mapping, so the scan is explicit
  // rather than a per-character map lookup.
  for (let index = 0; index < name.length; index += 1) {
    const pair = name.slice(index, index + 2);
    const mappedPair = CONFUSABLES.get(pair);
    if (mappedPair !== undefined && pair.length === 2) {
      out += mappedPair;
      index += 1;
      continue;
    }
    const character = name[index] ?? '';
    out += CONFUSABLES.get(character) ?? character;
  }
  // Hyphens carry no meaning for confusability: `qa-regression` and
  // `qaregression` are the same name to a reader in a hurry.
  return out.replace(/-/g, '');
}

/** Whether what the user typed looks like an attempt to invoke a shortcut. */
export function looksLikeShortcut(input: string): boolean {
  return input.trimStart().startsWith('/');
}
