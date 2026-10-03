/**
 * Reports what the build decided about its optional configuration, and refuses
 * a value that is set and unusable.
 *
 * ## The failure this exists to prevent
 *
 * An owner follows `OWNER-CHECKLIST.md` G-6, registers a Google OAuth client,
 * sets `VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID`, rebuilds, loads the extension,
 * presses *Connect with Google* — and reads *"this build carries no Google
 * OAuth client id"*. Which is true, because the value had a typo, and reads as
 * though the variable had never been set at all.
 *
 * The run-time code is right to fail closed: a value that is not a Google
 * client id would send the user to an authorization screen that refuses them.
 * What was missing is anybody saying so at the one moment the person who set
 * it is watching. So this runs in the build and **fails it** for a value that
 * is present and unusable, while an absent value is reported and allowed —
 * absent is the configuration every published build has shipped with.
 *
 * ## Why a separate script rather than a Vite plugin
 *
 * Because it must be runnable on its own. `node scripts/check-extension-env.mjs`
 * is a thing an owner can run to answer "did my value take?" without producing
 * a build, and the checklist tells them to.
 *
 * ## No secret is read or printed
 *
 * None of these values is a secret — they are inlined into `dist/` and anyone
 * who unzips the extension can read them. The client id is printed in full for
 * that reason, and because an owner comparing it against the Google console
 * needs to see it. `.env.extension.example` says why no secret can be
 * configured this way at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The environment Vite will inline, from `process.env` and `.env`.
 *
 * `.env` is parsed here rather than imported through Vite so this script runs
 * standalone. Deliberately minimal: `KEY=value`, comments and blanks skipped,
 * surrounding quotes stripped. A `.env` complex enough to defeat it is a
 * `.env` whose values should be passed on the command line.
 */
function environment() {
  const values = { ...process.env };
  const file = resolve(root, '.env');
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split <= 0) continue;
    const key = trimmed.slice(0, split).trim();
    // The command line wins over the file, which is the order Vite uses and
    // the order an owner testing one build expects.
    if (values[key] !== undefined && values[key] !== '') continue;
    values[key] = trimmed
      .slice(split + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return values;
}

/**
 * The same two rules the run-time code applies, restated here.
 *
 * Deliberately a copy rather than an import: this script is plain Node and the
 * module under `src/` is TypeScript compiled by Vite. Two copies of a rule is
 * the thing this project normally refuses, so the drift is closed from the
 * other side — `tests/security/extension-env.test.ts` asserts that these
 * predicates and `inspectClientId` / `parseQuotaProject` agree on a shared
 * table of inputs, and fails if either side changes alone.
 */
export function clientIdProblem(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'absent';
  return raw.trim().endsWith('.apps.googleusercontent.com') ? null : 'not_a_google_client_id';
}

export function quotaProjectProblem(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'absent';
  const trimmed = raw.trim();
  if (/^[0-9]{1,20}$/.test(trimmed)) return null;
  if (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(trimmed)) return null;
  return 'not_a_project_id';
}

export function backendOriginProblem(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'absent';
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? null : 'not_https';
  } catch {
    return 'not_a_url';
  }
}

const problems = [];
const notes = [];

export function inspect(env) {
  const found = [];
  const failed = [];

  const clientId = env.VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID;
  const clientProblem = clientIdProblem(clientId);
  if (clientProblem === 'absent') {
    found.push(
      'Google provider authorization: NOT configured. The panel will report the Google ' +
        'option unavailable and offer the Gemini API key path. This is the configuration ' +
        'every published build has shipped with.',
    );
  } else if (clientProblem === null) {
    found.push(`Google provider authorization: configured with client id ${clientId.trim()}`);
    const quotaProblem = quotaProjectProblem(env.VITE_ABA_GOOGLE_QUOTA_PROJECT);
    if (quotaProblem === 'absent') {
      found.push(
        '  no quota project set. Google may refuse an OAuth-authorized call with a message ' +
          'about the quota project; set VITE_ABA_GOOGLE_QUOTA_PROJECT to the project you ' +
          'enabled the Generative Language API on.',
      );
    } else if (quotaProblem === null) {
      found.push(`  quota project ${env.VITE_ABA_GOOGLE_QUOTA_PROJECT.trim()}`);
    } else {
      failed.push(
        `VITE_ABA_GOOGLE_QUOTA_PROJECT is set to "${env.VITE_ABA_GOOGLE_QUOTA_PROJECT}", which ` +
          'is not a Google Cloud project id or number. A project id is 6 to 30 characters of ' +
          'lowercase letters, digits and hyphens, not starting or ending with a hyphen; a ' +
          'project number is digits only. It is sent in a request header, so it is checked ' +
          'rather than passed through.',
      );
    }
  } else {
    failed.push(
      `VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID is set to "${String(clientId).trim()}", which is not ` +
        'a Google OAuth client id — one ends ".apps.googleusercontent.com". The extension ' +
        'would treat this build as having no client id at all, which reads as though the ' +
        'variable had never been set. Create the client as application type "Chrome ' +
        'Extension" (OWNER-CHECKLIST.md G-6) and copy the id exactly.',
    );
  }

  const originProblem = backendOriginProblem(env.VITE_ABA_BACKEND_ORIGIN);
  if (originProblem === 'absent') {
    found.push('Optional product sign-in: NOT configured. The extension offers no sign-in.');
  } else if (originProblem === null) {
    found.push(`Optional product sign-in: backend at ${env.VITE_ABA_BACKEND_ORIGIN.trim()}`);
  } else {
    failed.push(
      `VITE_ABA_BACKEND_ORIGIN is set to "${env.VITE_ABA_BACKEND_ORIGIN}", which is not an ` +
        'https origin. Authentication requests are only made over https, so the extension ' +
        'would treat this build as having no backend.',
    );
  }

  return { found, failed };
}

const { found, failed } = inspect(environment());
problems.push(...failed);
notes.push(...found);

for (const note of notes) console.log(`  ${note}`);

if (problems.length > 0) {
  console.error('\n✗ Extension configuration refused:\n');
  for (const problem of problems) console.error(`  - ${problem}\n`);
  console.error(
    '  A value that is set and unusable fails the build rather than being ignored, because\n' +
      '  being ignored looks identical to never having set it.\n',
  );
  process.exit(1);
}

console.log('✓ Extension build configuration checked.');
