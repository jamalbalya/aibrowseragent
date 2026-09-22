/**
 * Release rules that are pure functions of the manifest.
 *
 * These live apart from `validate-release.mjs` for the reason this project
 * has hit before: a test that asserts a rule by looking for its text in the
 * source proves only that the text is there. A mutation removing half of a
 * two-line error message left such a test passing, because the other half of
 * the message — and a different rule's message sharing its prefix — were
 * still in the file.
 *
 * A rule that is a function can be called with a hostile manifest and asked
 * what it says, which is a different and much stronger question.
 */

/**
 * Every web-accessible resource is an extension page an outside origin may
 * load, so the set of origins allowed to load it is attack surface rather
 * than configuration.
 *
 * The development manifest allows loopback so the end-to-end suite's mock
 * authorization server can redirect to the OAuth callback the way a real one
 * does. `build.mjs` removes those for a release; this is what stops that
 * removal being a convention that could quietly stop happening.
 *
 * @param {{ web_accessible_resources?: { resources?: string[], matches?: string[] }[] }} manifest
 * @returns {string[]} one message per failure, empty when the manifest is fine
 */
export function checkWebAccessibleResources(manifest) {
  const failures = [];
  for (const entry of manifest.web_accessible_resources ?? []) {
    const resources = (entry.resources ?? []).join(', ') || '(unnamed resource)';
    const matches = entry.matches ?? [];

    if (matches.length === 0) {
      failures.push(`web_accessible_resources entry for ${resources} matches no origin at all.`);
      continue;
    }

    for (const match of matches) {
      if (match === '<all_urls>' || /^https?:\/\/\*\/\*$/.test(match)) {
        failures.push(
          `web_accessible_resources exposes ${resources} to every site (${match}), which lets ` +
            `any page load an extension page and confirm the extension is installed.`,
        );
        continue;
      }
      if (!match.startsWith('https://')) {
        failures.push(
          `web_accessible_resources exposes ${resources} to ${match}. A release narrows these to ` +
            `https origins; a loopback or http match is a development affordance.`,
        );
      }
    }
  }
  return failures;
}
