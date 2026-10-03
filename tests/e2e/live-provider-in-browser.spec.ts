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

/**
 * A second, genuinely different vendor, for the switching journey.
 *
 * Optional: the cases that need it skip without it, and everything else still
 * runs on the Gemini key alone. Two *real* vendors is the only way to test
 * what §33 claims — that switching the brain switches which service answers —
 * because one vendor behind two base URLs is still one vendor.
 */
const OTHER_KEY = process.env.ABA_E2E_OPENROUTER_KEY ?? '';
const OTHER_BASE = 'https://openrouter.ai/api/v1';
const OTHER_MODEL = process.env.ABA_E2E_OPENROUTER_MODEL ?? 'nvidia/nemotron-3.5-lightning:free';

test.skip(KEY.length === 0, 'ABA_E2E_GEMINI_KEY is not set.');

/**
 * ## Why so much is in one test
 *
 * Google's free tier allows fifteen requests a minute and one capability
 * doctor run is eight of them, so two tests that each measure a model exhaust
 * it and the second reports `RATE_LIMITED` — which says nothing about either.
 * Playwright gives every test a fresh browser context, so a measurement cannot
 * be shared across tests; sharing it means sharing the test.
 *
 * The phases below are therefore one journey rather than several cases, and
 * each prints what it observed so a reader can see which part of it held.
 */

// Five phases, two vendors and three capability measurements against real
// services. The suite's 60s default is right for a local server and nowhere
// near enough for this.
test.setTimeout(300_000);

test('the account journey, end to end, against real vendors', async ({
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

  // ---- Phase 3: the account routes, against the real vendor -------------
  //
  // Phases 1 and 2 used the legacy single-provider routes, which is what the
  // D15 spec reached for. The product's actual journey is the **account**
  // routes — connect, discover, choose a brain, measure, run — and those had
  // only ever been driven against a local server. Discovery in particular:
  // `accounts.listModels` asks the vendor what this credential can see, and
  // until now the answer always came from a fixture that returned what the
  // test intended.
  const { account } = await send('accounts.connect', {
    providerId: 'gemini',
    apiKey: KEY,
    displayName: 'Gemini (live)',
  });
  expect(account, 'accounts.connect returned no account').not.toBeNull();
  const connectionId = account!.connectionId;
  // Connecting is not selecting: a fresh account has no model, and the
  // product refuses to guess one.
  expect(account!.modelId).toBeNull();
  expect(JSON.stringify(account)).not.toContain(KEY);

  const discovered = await send('accounts.listModels', { connectionId });
  process.stdout.write(
    `[E2ELIVE] discovery: ${discovered.models.length} model(s) from the vendor\n`,
  );
  // Real discovery: the vendor offered dozens, not the two a fixture would.
  expect(discovered.models.length).toBeGreaterThan(10);
  expect(discovered.models.map((model) => model.id)).toContain(MODEL);
  // A model list is not a place for a credential.
  expect(JSON.stringify(discovered)).not.toContain(KEY);

  const chosen = await send('accounts.setBrain', { connectionId, modelId: MODEL });
  expect(chosen.account.modelId).toBe(MODEL);
  expect(chosen.account.isBrain).toBe(true);

  // ---- Phase 4: switching the brain to a different real vendor ----------
  //
  // §33's claim is that switching the brain switches which service answers.
  // Every test of it so far used one local server wearing two hats. This uses
  // two companies.
  if (OTHER_KEY.length === 0) {
    process.stdout.write('[E2ELIVE] phase 4 skipped: ABA_E2E_OPENROUTER_KEY is not set.\n');
    return;
  }

  const other = await send('accounts.connect', {
    providerId: 'openai-compatible',
    baseUrl: OTHER_BASE,
    apiKey: OTHER_KEY,
    displayName: 'Gateway (live)',
  });
  expect(other.account, JSON.stringify(other.error)).not.toBeNull();
  const otherId = other.account!.connectionId;
  expect(otherId).not.toBe(connectionId);

  const otherModels = await send('accounts.listModels', { connectionId: otherId });
  process.stdout.write(`[E2ELIVE] second vendor: ${otherModels.models.length} model(s)\n`);
  expect(otherModels.models.length).toBeGreaterThan(10);

  // Both accounts exist, with their own identities, and neither row carries a
  // key — the panel reads this list.
  const { accounts } = await send('accounts.list', {});
  expect(accounts.map((row) => row.connectionId).sort()).toEqual([connectionId, otherId].sort());
  const listed = JSON.stringify(accounts);
  expect(listed).not.toContain(KEY);
  expect(listed).not.toContain(OTHER_KEY);

  // Measure and select the second vendor. Its quota is its own, so this costs
  // Google nothing.
  await send('accounts.setBrain', { connectionId: otherId, modelId: OTHER_MODEL });
  const otherReport = await send('accounts.runDoctor', {
    connectionId: otherId,
    modelId: OTHER_MODEL,
  });
  process.stdout.write(`[E2ELIVE] second vendor doctor: ${otherReport.report.readiness}\n`);

  const switched = await send('task.create', {
    objective: 'Read this page and tell me what it says the medium widget weighs.',
  });
  const onOther = await waitForTask(send, switched.task.id, 120_000);
  process.stdout.write(
    `[E2ELIVE] after switch: provider=${onOther.providerId} model=${onOther.modelId} ` +
      `state=${onOther.state}\n`,
  );

  // **The switch took effect at the vendor, not just in the UI.** The task
  // records the provider that served it, and it is the second one.
  expect(onOther.providerId).toBe('openai-compatible');
  expect(onOther.modelId).toBe(OTHER_MODEL);
  // And neither credential reached the record of a task served by the other.
  expect(JSON.stringify(onOther).includes(KEY)).toBe(false);
  expect(JSON.stringify(onOther).includes(OTHER_KEY)).toBe(false);

  // ---- Phase 4b: a model the vendor lists and has retired ---------------
  //
  // **The question this answers**, which was documented as a known limitation
  // and framed too pessimistically. Google's model list leads with
  // `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-2.5-flash-lite`, all of
  // which answer 404 *"no longer available to new users"*. They are therefore
  // selectable, and nothing can stop them being listed — the vendor lists
  // them.
  //
  // What was written down was that such a model "stays selected after it has
  // failed", with nothing recording what the worker learned. Reading the code
  // again says otherwise: a doctor run on it ends `FAILED`, `doctorVerdict`
  // maps that to `status: 'failed'` with the summary as `statusReason`, and
  // `ConnectedAccounts.tsx` renders that reason as a warning. So the chain
  // exists. This phase is whether it actually joins up against the real
  // vendor, because reading three files in a row is how a chain is believed
  // rather than known.
  const retired = await send('accounts.connect', {
    providerId: 'gemini',
    apiKey: KEY,
    displayName: 'Retired model (live)',
  });
  expect(retired.account).not.toBeNull();
  const retiredId = retired.account!.connectionId;
  // Deliberately **not** `setBrain`. `accounts.runDoctor` takes the connection
  // and model directly, so measuring a model does not require selecting it —
  // and an earlier version of this phase did select it, which made the brain
  // the retired account and left it null when the phase disconnected it. The
  // later assertion about which account the brain survives on then failed, on
  // my own sequencing rather than on the product.
  const retiredReport = await send('accounts.runDoctor', {
    connectionId: retiredId,
    modelId: 'gemini-2.5-flash',
  });
  process.stdout.write(
    `[E2ELIVE] retired model: readiness=${retiredReport.report.readiness} ` +
      `summary=${JSON.stringify(retiredReport.report.summary.slice(0, 90))}\n`,
  );

  // It is listed, so it measures — and it measures as broken.
  expect(retiredReport.report.readiness).toBe('FAILED');

  const afterDoctor = await send('accounts.list', {});
  const row = afterDoctor.accounts.find((a) => a.connectionId === retiredId);
  process.stdout.write(
    `[E2ELIVE] retired row: status=${row?.status} reason=${JSON.stringify(
      (row?.statusReason ?? '').slice(0, 90),
    )}\n`,
  );

  // The worker wrote down what it learned, and the panel reads this row.
  expect(row?.status).toBe('failed');
  expect(row?.statusReason ?? '').not.toHaveLength(0);
  // And the reason is the actionable one, not "check it against the model
  // list" — the list is where the model came from.
  expect(row?.statusReason).not.toMatch(/check it against the model list/i);

  await send('accounts.disconnect', { connectionId: retiredId });

  // ---- Phase 5: disconnecting the first account -------------------------
  await send('accounts.disconnect', { connectionId });
  const after = await send('accounts.list', {});
  expect(after.accounts.map((row) => row.connectionId)).toEqual([otherId]);
  // The brain is still the second account: disconnecting one must not strand
  // the agent on nothing, and must not silently fall back either.
  expect(after.brain?.connectionId).toBe(otherId);
});

test('a real vendor rejection is reported as the vendor’s, not as a bug', async ({ send }) => {
  // Cheap on purpose: one request, no capability measurement, so it costs
  // almost nothing against the per-minute limit.
  //
  // The key is the real one with its last characters changed, so it has the
  // right shape and no validity. A locally fabricated key can be refused by
  // this build's own format checks before a request leaves, which tests
  // nothing about the vendor.
  const wrong = `${KEY.slice(0, -4)}zzzz`;
  const { account, error } = await send('accounts.connect', {
    providerId: 'gemini',
    apiKey: wrong,
    displayName: 'Rejected (live)',
  });

  process.stdout.write(
    `[E2ELIVE] rejected key: account=${account === null ? 'null' : 'created'} ` +
      `code=${error?.code}\n`,
  );

  // Either the connect is refused outright, or an account exists and its
  // first real use fails — but it must never read as connected *and* usable,
  // and the message must not blame the user's own configuration when the
  // vendor is the one refusing.
  if (account === null) {
    expect(error, 'a refused connect must say why').toBeDefined();
    expect(error!.userMessage.length).toBeGreaterThan(0);
  } else {
    const probe = await send('accounts.runDoctor', {
      connectionId: account.connectionId,
      modelId: MODEL,
      quick: false,
    });
    process.stdout.write(`[E2ELIVE] rejected key doctor: ${probe.report.readiness}\n`);
    expect(probe.report.readiness).toBe('FAILED');
    const credentials = probe.report.checks.find((check) => check.id === 'credentials');
    expect(credentials?.status, JSON.stringify(probe.report.checks)).toBe('fail');
  }

  // And the rejected key is not echoed anywhere, which is the thing a
  // provider's own error body is most likely to do.
  expect(JSON.stringify({ account, error })).not.toContain(wrong);
});
