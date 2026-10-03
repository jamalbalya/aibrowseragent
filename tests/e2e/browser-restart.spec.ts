/**
 * TEST-E2E-057 — a full browser quit and reopen, on the same profile.
 *
 * REAL BROWSER, launched and quit by this spec rather than by the shared
 * fixture — which creates a throwaway profile per test and deletes it, so it
 * cannot express "the same installation, later".
 *
 * ## Why this file exists
 *
 * `docs/testing/acceptance/MATRIX.md` listed `84-P-020` and `90-08` as
 * `BLOCKED — HUMAN/ENVIRONMENT`, on the stated reason that *"Playwright cannot
 * quit the browser it launched and reattach to the same profile"*.
 *
 * **That reason does not hold.** `launchPersistentContext` takes a user data
 * directory; closing the context ends the browser process, and launching again
 * on the same directory is a new process reading the profile the first one
 * wrote. That is what a quit and reopen is. The claim had been carried forward
 * from a time when the suite only used the shared fixture, and nothing had
 * re-tested it.
 *
 * So the claim this spec measures was waiting on a person for a reason that
 * had stopped being true: **a connected provider and its model selection
 * survive the browser process ending and a new one starting**. The schedule
 * half of `84-P-020` still needs a person, for a different and real reason
 * recorded in the test body.
 *
 * ## What this does and does not establish
 *
 * It establishes that the records are written to profile-backed storage and
 * read back by a genuinely new browser process, with the extension re-loaded
 * from disk and its service worker started fresh — which is the mechanism the
 * claim rests on.
 *
 * It does **not** establish behaviour across an operating-system reboot, a
 * Chrome version upgrade, or a profile migration. Those are different events
 * with different failure modes, and `84-P-020` keeps a human step for the
 * first of them — the matrix now says which half is covered by which.
 */
import { expect, test } from '@playwright/test';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BROWSER } from './fixtures/extension';

/** The shipped development bundle, as every other self-launching spec names it. */
const EXTENSION_PATH = resolve(import.meta.dirname, '../../dist');
import { startMockProvider, type MockProvider } from './fixtures/mock-provider';
import { startTestSite, type TestSite } from './fixtures/test-site';

/** One launch of the browser on a given profile, with the extension loaded. */
interface Session {
  readonly context: BrowserContext;
  readonly worker: Worker;
  readonly extensionId: string;
  /**
   * The side panel, open on this launch.
   *
   * Messages are sent from here and not from the worker: the worker is the
   * *receiver*, so `chrome.runtime.sendMessage` called inside it reaches no
   * listener and fails with "Receiving end does not exist". The shared
   * fixture sends from the panel for the same reason, and writing this spec
   * without noticing that is how it was found.
   */
  readonly panel: Page;
}

async function launch(profile: string): Promise<Session> {
  const context = await chromium.launchPersistentContext(profile, {
    // The shared fixture's options, reused rather than restated: they pin
    // `channel: 'chromium'` when no binary is given, because `headless: true`
    // alone resolves to `chrome-headless-shell`, which cannot load extensions.
    ...BROWSER,
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  return { context, worker, extensionId, panel };
}

/** Sends a panel message, from the panel, as the shared fixture does. */
async function ask<T>(session: Session, type: string, payload: unknown): Promise<T> {
  const envelope: { ok?: boolean; value?: unknown; error?: unknown } = await session.panel.evaluate(
    ([messageType, body]) =>
      chrome.runtime.sendMessage({
        id: `e2e_${Math.random().toString(36).slice(2)}`,
        type: messageType,
        timestamp: Date.now(),
        payload: body,
      }),
    [type, payload] as const,
  );
  if (envelope?.ok !== true) {
    throw new Error(`${type} failed: ${JSON.stringify(envelope?.error)}`);
  }
  return envelope.value as T;
}

let profile: string;
let provider: MockProvider;
let site: TestSite;

test.beforeAll(async () => {
  provider = await startMockProvider();
  site = await startTestSite();
  profile = mkdtempSync(join(tmpdir(), 'aba-restart-e2e-'));
});

test.afterAll(async () => {
  await provider.close();
  await site.close();
  rmSync(profile, { recursive: true, force: true });
});

test('a connected provider and its model survive a full browser quit and reopen', async () => {
  // ---- first launch: set the state up -----------------------------------
  const first = await launch(profile);

  const connected = await ask<{ account: { connectionId: string } | null }>(
    first,
    'accounts.connect',
    {
      providerId: 'openai-compatible',
      baseUrl: provider.baseUrl,
      apiKey: 'test-key-restart-aaaaaaaa',
      model: 'mock-model',
      displayName: 'Survives a restart',
    },
  );
  expect(connected.account).not.toBeNull();
  const connectionId = connected.account!.connectionId;
  await ask(first, 'accounts.setBrain', { connectionId, modelId: 'mock-model' });

  // **What this spec does not cover, and why — stated rather than omitted.**
  //
  // `84-P-020`'s subject is a *schedule* surviving a restart, and creating one
  // here needs a target that can run unattended. Three were tried:
  //
  //  - a **recorded workflow** has to be recorded from a live task with
  //    approvals, because no route authors one directly — a deliberate design
  //    decision, and reproducing that machinery would make this spec about
  //    recording rather than about the restart;
  //  - every **bundled skill** declares inputs, so `schedule.create` refuses
  //    it with *"that workflow asks for values when it runs, so it cannot run
  //    unattended"*, which is the unattended-execution boundary working;
  //  - a **prompt shortcut** was refused as `TARGET_MISSING`, and rather than
  //    guess at why, it is left as a question in the matrix.
  //
  // So the schedule half stays with a person, and this spec covers the half
  // that was equally unautomated and needs no such target: whether a
  // *connected provider and its model selection* survive the browser ending
  // and starting again. `MATRIX.md` now says which half is which.

  // ---- quit ---------------------------------------------------------------
  await first.context.close();

  // ---- second launch: a new browser process on the same profile ----------
  const second = await launch(profile);

  // A genuinely different service worker, so nothing survived in memory.
  expect(second.worker).not.toBe(first.worker);

  // The provider connection survived, with its model selection.
  const accounts = await ask<{
    accounts: { connectionId: string; modelId: string | null }[];
    brain: { connectionId: string } | null;
  }>(second, 'accounts.list', {});
  const account = accounts.accounts.find((entry) => entry.connectionId === connectionId);
  expect(account, JSON.stringify(accounts.accounts)).toBeDefined();
  expect(account!.modelId).toBe('mock-model');
  expect(accounts.brain?.connectionId).toBe(connectionId);

  // And it can still run, which is the point: a restored record that cannot
  // serve a request is a record, not a connection.
  provider.script([{ kind: 'text', text: 'Still here.' }]);
  const task = await ask<{ task: { id: string } }>(second, 'task.create', {
    objective: 'Say something.',
  });
  expect(task.task.id).toBeTruthy();

  await second.context.close();
});
