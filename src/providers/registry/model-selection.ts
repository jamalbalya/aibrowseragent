/**
 * Whether a remembered model selection is still a thing the provider offers.
 *
 * ## Why this has to exist
 *
 * A model id is the provider's to define, and a provider may stop offering one
 * at any time. A gateway makes that ordinary rather than rare: 9Router builds
 * its ids as `` `${prefix}/${model}` `` where the prefix is a per-connection
 * field the user can edit, so renaming one connection's alias silently renames
 * every model under it. The stored selection `cx/gpt-5.6-terra` does not become
 * wrong-looking — it becomes a string nothing answers to.
 *
 * ## Why the answer must be "stale", not a replacement
 *
 * The temptation is to repair it: strip the prefix and re-attach the new one,
 * or match the longest common suffix, or fall back to the first model in the
 * group. Every one of those sends the user's task to a model they did not
 * choose, and the gateway will do something similar if asked — 9Router resolves
 * an unrecognised slash-less id through a table of name patterns and then
 * **defaults to `openai`**, so a deleted combination can be answered by a
 * different upstream entirely. Two layers guessing in sequence is how a task
 * comes to run on a brain nobody selected.
 *
 * So the only operations here are **exact equality** and **say so**. Nothing in
 * this module splits, trims, lower-cases, normalises or substring-matches an
 * id, and nothing here chooses a model. A stale selection is reported, the
 * runtime refuses to run on it, and the user picks again from a list that is
 * current.
 *
 * Reappearance is symmetric, and that is the other half of the point: the test
 * is against the live catalogue every time, so a connection that comes back, or
 * a prefix renamed back to what it was, makes the same exact id valid again
 * with no repair step and no stored history to go wrong.
 */

/** What a remembered selection turned out to be, measured against a live catalogue. */
export type ModelSelectionState =
  /** Nothing was selected. Not an error — a connection starts here. */
  | { readonly kind: 'none' }
  /** The exact id is in the catalogue. */
  | { readonly kind: 'valid'; readonly modelId: string }
  /**
   * The exact id is not in the catalogue.
   *
   * The id is carried so the UI can name what went missing. It is never used to
   * look for a replacement.
   */
  | { readonly kind: 'stale'; readonly modelId: string }
  /**
   * The catalogue could not be read, so nothing can be concluded.
   *
   * Distinct from `stale` on purpose. An endpoint that is down has not stopped
   * offering the model, and treating "I could not ask" as "it is gone" would
   * invalidate a correct selection every time a gateway restarted.
   */
  | { readonly kind: 'indeterminate'; readonly modelId: string };

/**
 * Compares a remembered selection against the catalogue just discovered.
 *
 * `catalogueRead` separates an empty catalogue from an unread one. A provider
 * that answered with zero models really is offering none; a provider whose
 * discovery failed returns an empty list through the same path, and the two must
 * not reach the same verdict.
 */
export function modelSelectionState(
  selected: string | null | undefined,
  catalogueIds: readonly string[],
  catalogueRead: boolean,
): ModelSelectionState {
  if (selected === null || selected === undefined || selected.length === 0) {
    return { kind: 'none' };
  }
  if (!catalogueRead) return { kind: 'indeterminate', modelId: selected };
  // Exact equality, on the whole string. This is the entire comparison, and
  // every alternative to it is a way of answering with a different model.
  return catalogueIds.includes(selected)
    ? { kind: 'valid', modelId: selected }
    : { kind: 'stale', modelId: selected };
}

/**
 * What the runtime should refuse with, or `null` when it may proceed.
 *
 * `indeterminate` proceeds. The selection has not been shown to be wrong, the
 * request will fail with the provider's own error if the endpoint is really
 * unreachable, and refusing here would turn a transient gateway restart into a
 * selection the user has to make again.
 */
export function selectionRefusal(state: ModelSelectionState): string | null {
  if (state.kind !== 'stale') return null;
  return (
    `The selected model "${state.modelId}" is no longer offered by this provider. ` +
    'Open Settings and choose a model from the current list. ' +
    'It will not be substituted with another one.'
  );
}
