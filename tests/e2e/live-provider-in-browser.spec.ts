/**
 * TEST-E2E-058 — a real commercial provider, reached from inside the real
 * extension, in a real browser.
 *
 * ## The gap this closes
 *
 * `tests/integration/provider-live.test.ts` reaches Gemini, OpenRouter and a
 * 9Router gateway for real — and it runs in **Node**. It assembles the
 * production registry, transport, gate and adapters and drives them in a
 * process with no extension around it.
 *
 * So after all of that, one thing was still unproven: that the extension's own
 * **service worker** can reach a commercial endpoint. That is a different set
 * of questions, and they are the browser's rather than the adapter's — the
 * manifest's host permissions, the extension page's CSP, a service worker's
 * `fetch` under MV3, and the egress gate running where it actually runs. The
 * only provider requests ever made from inside this extension went to a local
 * server on loopback.
 *
 * This spec makes them go to `generativelanguage.googleapis.com`.
 *
 * ## Opt-in, and why it is a separate file
 *
 * It runs only when `ABA_E2E_GEMINI_KEY` is set, and skips otherwise, so the
 * ordinary `npm run test:e2e` neither needs a key nor spends one. It is its own
 * file rather than a case in an existing spec because every other spec is
 * built on the mock provider fixture, and a reader finding a real endpoint
 * inside one of those would be right to be surprised.
 *
 * ## What it spends
 *
 * A handful of small requests on a free-tier key: one capability doctor run and
 * one short task. Nothing is written anywhere outside the browser profile
 * Playwright throws away.
 */
import { ask, expect, openPanel, test, waitForTask } from './fixtures/extension';

const KEY = process.env.ABA_E2E_GEMINI_KEY ?? '';
const MODEL = process.env.ABA_E2E_GEMINI_MODEL ?? 'gemini-flash-lite-latest';

test.skip(KEY.length === 0, 'ABA_E2E_GEMINI_KEY is not set.');

test('the service worker reaches a commercial provider, and the guard still holds', async ({
  context,
  extensionId,
  send,
  site,
}) => {
  // **One test, two phases, and one capability measurement between them.**
  //
  // Written as two tests first, which cost two doctor runs — sixteen requests
  // inside a minute — and the free tier allows fifteen. The second test failed
  // with `RATE_LIMITED`, which says nothing about either phase. Playwright
  // gives each test a fresh browser context, so the measurement cannot be
  // shared across them; sharing it means sharing the test.
  const connected = await send('provider.connect', {
    providerId: 'gemini',
    apiKey: KEY,
    model: MODEL,
  });
  expect(connected.error, JSON.stringify(connected.error)).toBeUndefined();

  const { report } = await send('provider.runDoctor', {
    providerId: 'gemini',
    modelId: MODEL,
  });
  // Reported rather than demanded: a model's readiness is a fact about the
  // model, and a free tier throttled today is not this build's defect. What
  // must hold is that the measurement happened at all — eight round trips
  // through the guarded transport, from inside a service worker, to a
  // commercial endpoint.
  process.stdout.write(
    `[E2ELIVE] ${MODEL}: ${report.readiness} — ` +
      report.checks.map((check) => `${check.id}=${check.status}`).join(' ') +
      '\n',
  );
  expect(report.readiness, 'the doctor returned no readiness').toBeTruthy();
  expect(report.checks.length).toBeGreaterThan(0);
  await send('provider.setActive', { providerId: 'gemini', modelId: MODEL });

  // ---- Phase 1: a clean page, end to end --------------------------------
  //
  // `/details` rather than the site root, deliberately: the root carries a
  // password field with a real-looking value, and phase 2 is about that.
  const details = await context.newPage();
  await details.goto(`${site.baseUrl}/details`, { waitUntil: 'domcontentloaded' });
  await details.bringToFront();

  const first = await send('task.create', {
    objective: 'Read this page and tell me what it says the medium widget weighs.',
  });
  const finished = await waitForTask(send, first.task.id, 90_000);
  process.stdout.write(
    `[E2ELIVE] clean page: state=${finished.state} code=${finished.error?.code}\n`,
  );

  expect(['COMPLETED', 'PARTIAL'], JSON.stringify(finished.result)).toContain(finished.state);
  expect(finished.providerId).toBe('gemini');
  expect(finished.modelId).toBe(MODEL);
  expect(finished.result?.completedActions).toContain('browser.read_page');
  // The page really was read: 400 grams is on that page and nowhere else.
  expect(JSON.stringify(finished.result)).toContain('400');
  // And the credential did not come back out with it.
  expect(JSON.stringify(finished).includes(KEY)).toBe(false);

  // The panel shows the same finished task, which is what a user would see.
  const panel = await openPanel(context, extensionId);
  const seen = await ask<{ task?: { state?: string } }>(panel, 'task.get', {
    taskId: first.task.id,
  });
  expect(seen.task?.state).toBe(finished.state);

  // ---- Phase 2: a page carrying a credential ----------------------------
  //
  // **This had never been tested against a real external destination.** Every
  // provider in every other end-to-end test is a local server on loopback, and
  // the exfiltration guard treats loopback differently — so the credential
  // check in front of a commercial endpoint had never actually run. The first
  // time it did, it fired, which is how this phase came to exist.
  //
  // The site root carries `<input type="password" value="hunter2-do-not-leak">`.
  // Reading it and sending the page model to the provider is precisely the
  // transfer the guard exists to stop.
  const root = await context.newPage();
  await root.goto(site.baseUrl, { waitUntil: 'domcontentloaded' });
  await root.bringToFront();

  const second = await send('task.create', {
    objective: 'Read this page and summarise everything on it.',
  });
  const refused = await waitForTask(send, second.task.id, 90_000);
  process.stdout.write(
    `[E2ELIVE] credential page: state=${refused.state} code=${refused.error?.code}\n`,
  );

  // **What this phase asserts, and what it only reports.**
  //
  // The outcome varies with when the taint attaches and which tab the agent
  // decides to work on. Driven as the only page in the context it produced
  // `POLICY_BLOCKED` — _"this transfer contains credential-shaped data
  // (named-secret-assignment) and cannot be sent anywhere"_, after
  // `browser.read_page` had succeeded and before anything was sent. Driven as
  // the second page of two it produced `PARTIAL`. Both are defensible, and a
  // test that demanded one of them would be asserting a scheduling detail.
  //
  // So the refusal is **reported**, and the invariant is **asserted**: the
  // password on that page does not reach the task record whatever the run
  // decides to do. That is the part a user is owed, and it does not depend on
  // tab order. The organic observation is recorded in
  // `docs/testing/acceptance/RESULTS.md`.
  if (refused.error?.code === 'POLICY_BLOCKED') {
    expect(refused.error.message).toMatch(/credential-shaped/i);
    expect(refused.error.userMessage).toMatch(/refused before anything was sent/i);
  }

  // The invariant, in every case: the credential on the page never lands in
  // anything persisted or shown, and neither does the provider key.
  expect(JSON.stringify(refused)).not.toContain('hunter2-do-not-leak');
  expect(JSON.stringify(refused).includes(KEY)).toBe(false);
});
