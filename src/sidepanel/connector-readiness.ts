/**
 * Which connectors a skill needs that are not connected right now.
 *
 * ## Display only, and that is the whole design
 *
 * The thing that decides whether a connector call may happen is the
 * connector's own preflight: it refuses an operation on a connector that is
 * not `READY` before anything is sent, and refuses one whose granted scopes do
 * not cover it. This function cannot grant anything and cannot stop anything.
 * A second place that decided whether a connector was usable would be a second
 * answer that could drift from the first, and a skill list is not where
 * authority belongs.
 *
 * What it fixes is the order in which the user finds out. Before this, a skill
 * requiring the GitHub connector looked identical to one requiring nothing, so
 * the way to discover it was unconnected was to approve a run and watch step
 * one fail.
 *
 * ## Its own module, so it can be called
 *
 * It was going to be a helper inside `SettingsView.tsx`, which is the shape
 * that put `digestStep` and `doctorVerdict` out of reach of any test for as
 * long as they lived in a surface. This file imports nothing at run time, so a
 * test can call it without a browser.
 */

/** The fields of a connector listing this reads, and no others. */
export interface ConnectorReadiness {
  readonly id: string;
  readonly state: string;
  readonly displayName?: string;
}

/**
 * The names of the required connectors that are not ready.
 *
 * Three decisions, each of which changes what a reader sees:
 *
 *  - **`READY` and nothing else counts as connected.** Every other state —
 *    `NEEDS_AUTH`, `AUTHENTICATING`, `DENIED`, `UNAVAILABLE`, `UNCONFIGURED` —
 *    is a connector whose next call will be refused, so treating any of them
 *    as usable would produce exactly the surprise this exists to remove.
 *  - **A connector the list does not contain is reported, not skipped.** A
 *    skill requiring something this build does not have is the case most worth
 *    saying out loud; dropping it would make such a skill look ready.
 *  - **The display name where there is one.** A user reads "GitHub", not
 *    `github`, and falls back to the id rather than to nothing.
 */
export function missingConnectors(
  required: readonly string[],
  connectors: readonly ConnectorReadiness[],
): string[] {
  return required.flatMap((id) => {
    const found = connectors.find((connector) => connector.id === id);
    if (found?.state === 'READY') return [];
    return [found?.displayName ?? id];
  });
}
