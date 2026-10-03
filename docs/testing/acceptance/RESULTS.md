# Acceptance execution record

What has actually been executed. Nothing else in this directory records a
result, and no verdict elsewhere should be read as one.

An item marked `AUTOMATED` in a package is established by tests that ran — the
run is recorded below. An item marked `MANUAL` has a written procedure and is
`NOT YET EXECUTED` until somebody runs it and appends what happened here.

---

## Automated evidence

Every test cited in this directory ran, green, at the commit below. The
citations themselves are checked by `scripts/check-acceptance.mjs`, which runs
in `scripts/verify.sh` and in CI, so a citation cannot survive the test it
names being renamed or deleted.

**This is a dated execution record, like every other entry in this file. It is
not a current count and is not updated in place.**

|                                |                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Commit                         | `492a66e`, 2026-09-22 — the commit that introduced this directory                              |
| Unit, integration and security | 2119 tests in 79 files, all passing                                                            |
| Real Chromium (Playwright)     | 189 tests, all passing                                                                         |
| Chromium                       | the Playwright-managed build at `/opt/pw-browsers/chromium` locally, and the build CI installs |
| Command                        | `./scripts/verify.sh --e2e`                                                                    |

Later waves added tests, so the suite is larger now than the figures above.
Those figures are left exactly as recorded, because rewriting a result to
match a later run would destroy the thing that makes it evidence. For the
count at any given commit, run `npm run verify` there, or read the CI run for
it — that is the current number, and this table is not.

This table is a statement about the suite as a whole at that commit. It is
deliberately not a per-item result: an item is `AUTOMATED` because named tests
establish it, and those tests are part of the run above.

---

## Manual execution

**Three of the fifteen written procedures have been executed, plus two that
were not on the list. Twelve remain blocked.**

**That count is dated and is not updated in place.** The §84 condition 3
census added twenty-two further written procedures, one per capability that had
none. **Sixteen of the twenty-two have since been executed** and are recorded
below; six still need a person and say exactly why. They are listed in
[`84-capabilities.md`](84-capabilities.md) and carried in
[`MATRIX.md`](MATRIX.md).

### §84 condition 3 — 2026-09-28 — sixteen procedures EXECUTED — MET (now automated)

- Commit: `0607ba9` plus this change · real Chromium · `./scripts/verify.sh --e2e`
- Route: the one already recorded for §89's P-1, S-1 and M-1 — execute the
  procedure, turn it into a test, and it runs on every build rather than waiting
  for somebody to remember.
- Executed: 84-P-006, 84-P-007, 84-P-010, 84-P-013, 84-P-017, 84-P-018,
  84-P-021, 84-P-022, 84-P-024, 84-P-027, 84-P-028, 84-P-029, 84-P-035,
  84-P-037, 84-P-038, 84-P-039.
- Of those, eleven were met by tests that already ran and were cited rather than
  rewritten; five needed a test written, and those are in
  `tests/e2e/acceptance-84.spec.ts`.

### §84 84-P-037 — Loop detection — 2026-09-28 — **EXECUTED — NOT MET**, defect fixed, re-executed MET

The one that justifies the whole exercise, and the reason a written procedure is
not a passed acceptance.

- Steps: a page whose button changes nothing; a provider scripted to press it
  twelve times and never conclude; nobody intervening.
- Expected: the agent stops, says it is repeating itself, and does not consume
  turns indefinitely.
- **Actual on first execution: FAIL.** The detector fired correctly and the
  worker logged "Loop detected; stopping the task" — and the task then sat in
  `WAITING_FOR_TOOL` for good. `WAITING_FOR_TOOL -> PARTIAL` was not in the task
  transition table, so `TaskManager.onComplete` rejected the terminal write with
  "Rejected an invalid terminal transition" and the task never finished. No
  terminal state means no §53 task-failed notification and no Retry, which are
  the two things the runtime's own comment says this path relies on.
- Scope: three production paths ran into the same gap, all of them deliberate
  fail-closed stops — the loop detector, a taint salt that could not be
  recovered, and a taint that could not be persisted. The last two are the
  security-critical ones: the product stops because it cannot record what a task
  has read, and then never reports that it stopped.
- Root cause: the table's own docstring claimed "every terminal state is
  reachable from every live state" and the tests checked `CANCELLED` and
  `FAILED` only, so `PARTIAL` was missing from `QUEUED`, `PLANNING` and all
  three waiting states under a claim that read as though it were guarded. The
  runtime picks between the two with one ternary —
  `completed.length > 0 ? 'PARTIAL' : 'FAILED'` — so the gap stranded precisely
  those tasks that had got something done before they stopped.
- Fix: `PARTIAL` added wherever `FAILED` is reachable, `COMPLETED` deliberately
  not; the docstring narrowed to what holds; and the unit invariant rewritten to
  check all four ways of stopping, with `PAUSED`'s exemption named and its real
  guard pointed at.
- Re-executed: **MET.** The task now reaches `PARTIAL` with the detector's own
  diagnosis as its summary. Reverting the table entry alone fails the case, so
  the fix is load-bearing.

Executed on 2026-09-22 against the built extension in real Chromium: §89's
P-1 (popup), S-1 (SPA navigation) and M-1 (modal) from the list of fifteen,
and two further procedures that were not on it — the iframe exclusion, and
§90's malformed persisted state. Two of the five **failed**. That is the reason they were worth
executing: both failures were product defects, both are fixed, and both are
recorded below with what the failure actually was rather than only that it
happened.

Executing them turned each procedure into an automated test, so they now run
on every build instead of waiting for somebody to remember. That is a better
outcome than a manual pass, and it is why the verdicts read
`EXECUTED — MET (now automated)`.

### §89 P-1 — Popup — 2026-09-22 — EXECUTED — MET (now automated)

- Commit: 1036aea · real Chromium · `tests/e2e/browser-failures.spec.ts`
- Steps: served a page with a `target=_blank` link and a `window.open`
  button; clicked each; counted real tabs before and after through
  `chrome.tabs`; asked the new tab's content script for a page model.
- Expected: the second tab exists, the agent sees it, and it is automatable.
- Actual: a real second tab opened both ways, `chrome.tabs.query` listed it,
  and the content script answered `content.readPage` inside it.
- Evidence: 2 cases in `browser-failures.spec.ts`.

### §89 S-1 — SPA navigation — 2026-09-22 — EXECUTED — MET (now automated)

- Steps: read a page; changed route with `history.pushState` so the document
  never reloaded; clicked a handle issued before the change; read again.
- Expected: the stale handle is refused, not resolved against the new route.
- Actual: refused with `ELEMENT_NOT_FOUND` — "The element was removed from
  the page. Read the page again." A fresh read showed the new route's
  elements and none of the old ones.
- Evidence: 2 cases in `browser-failures.spec.ts`.

### §89 M-1 — Modal — 2026-09-22 — **EXECUTED — NOT MET**, defect fixed, re-executed MET

- Steps: served a page with a full-screen overlay covering a "Buy now"
  button; confirmed with `document.elementFromPoint` that the overlay is what
  a person's click would hit; asked the extension to click the button.
- Expected, unchanged from before execution: not met if it reports a
  successful click on an element a person could not have clicked.
- **Actual on first execution: FAIL.** The click was reported successful and
  the page recorded it. A synthetic click reaches the node whatever is
  painted over it, and nothing hit-tested. `isVisible` said yes correctly —
  the button was displayed, opaque, had a box and passed `checkVisibility` —
  because none of those notice what is on top.
- Fix: `isObscured` in `src/content/interaction-engine.ts` samples the centre
  and four inset corners after scrolling, and the six interaction functions
  go through `scrollIntoViewAndAssertReachable`. An element counts as
  reachable if the topmost thing at any sampled point is itself, a descendant
  (a button's own `<span>`) or an ancestor (a `<label>`). Where nothing can
  be measured it reports not-obscured, so an unmeasurable page does not
  become an unusable one.
- Actual after the fix: refused with `ELEMENT_NOT_INTERACTABLE` — "Something
  is covering this element… A dialog, cookie banner or overlay is usually the
  cause" — and the page confirmed the button was never activated. Dismissing
  the dialog first makes it clickable, which is the positive control.
- Evidence: 4 cases in `browser-failures.spec.ts`, 12 in
  `tests/unit/occlusion.test.ts`, 7 mutations all caught.

### §89 — Iframe — 2026-09-22 — EXECUTED — MET (limit confirmed, not cleared)

- Steps: served a host document embedding a **same-origin** child — the
  harder case to exclude, since a cross-origin frame the browser excludes
  anyway; confirmed the child really loaded; read the page model; tried to act
  inside the frame; asked Chrome which frames answered a content-script
  message.
- Actual: the model held `Outer button` and nothing from the child. Frame 0
  answered `content.readPage`; frame 1 did not. An invented handle was
  refused and the child's field was untouched.
- This confirms the limitation rather than clearing it: a form field inside an
  iframe is unreachable, and that is the price of `all_frames: false`.
- Evidence: 4 cases in `browser-failures.spec.ts`.

### §90 — Malformed persisted state — 2026-09-22 — **EXECUTED — NOT MET**, defect fixed, re-executed MET

- Steps: wrote real garbage into real `chrome.storage.local` under the keys
  the stores read — a truncated task index, an unparseable task record, a
  truncated health record, an edited audit record — killed the service
  worker, and asked the revived worker what it believed.
- Expected: a read that cannot be understood fails closed. In particular the
  health record must not read as HEALTHY.
- **Actual on first execution: FAIL for the health record.** It reported
  `HEALTHY` and did not block. The read was
  `(await get(KEY))?.records ?? []`, so a present-but-malformed value took the
  same path as an absent one — and an empty list means a clean profile. Those
  mean opposite things: nothing written is a new install, something
  unreadable is evidence that storage misbehaved.
- Fix: `isHealthIndex` in `src/storage/persistence-health.ts` checks the
  container shape. A value that is not an object holding a list of records
  marks `storage` IRRECOVERABLE, with the reason "the health record could not
  be understood" — deliberately distinct from "could not be read", because
  the two faults have different remedies. Narrowed to the container on
  purpose: individually malformed _records_ inside a well-formed container
  are still dropped rather than interpreted, which is a separate decision,
  already settled and tested, that this execution did not test.
- Actual after the fix: gating is not HEALTHY, work is blocked, and an absent
  record still reads as a clean profile so a first run is not blocked.
- The other three held on first execution: a corrupt task index did not
  present as an empty healthy profile, an unreadable task record was never
  resumable, and an edited audit record was caught by the integrity check.
- Evidence: 4 cases in `tests/e2e/persisted-state.spec.ts`, 10 in
  `tests/unit/persistence-health.test.ts`, 5 mutations all caught.

### §90 — Service worker restart — already covered, not re-run by hand

Executed on every build by `mv3-lifecycle.spec.ts`, `persistence-health.spec.ts`,
`egress.spec.ts`, `audit.spec.ts`, `skills.spec.ts` and `route-trust.spec.ts`,
each against a real Chrome service-worker termination. A person repeating what
nine automated cases already do in a real browser would add nothing.

---

### §87 — multiple tool calls (87-07) — 2026-10-03 — EXECUTED — MET

- Commit: `efafc48` (fix in the commit that follows)
- Provider: Google Gemini API, `generativelanguage.googleapis.com/v1beta`
- Model: `gemini-flash-lite-latest`
- Procedure: three cities, one tool that answers for exactly one city, so a
  single call cannot be enough. Tool results carry numbers that appear nowhere
  else in the conversation.
- Observed: **3 tool calls across 2 turns.** The model called the tool for all
  three cities, read the results, and answered _"The current temperatures are
  31°C in Jakarta, 4°C in Oslo, and 27°C in Cairo."_ — every number from a
  tool result, none from the model's own idea of the weather.
- Evidence: `tests/integration/provider-live.test.ts :: F1 — many tool calls
across several turns, answered from their results`
- Verdict: EXECUTED — MET

### §87 / §84 P-009 — vision, with a real image — 2026-10-03 — EXECUTED — MET

- Commit: `efafc48`
- Provider: Google Gemini API
- Model: `gemini-flash-lite-latest`
- Procedure: §87's manual half asks for _"a question only answerable from the
  image"_. The capability doctor's probe is a 1×1 transparent PNG, which proves
  the adapter can encode an image and nothing about whether the model read it.
  A 24×24 PNG was generated with the left half red and the right half green,
  and the model asked which side is red.
- Observed: **"Left."** — correct, and underivable from the prompt. This also
  settles `84-P-009`, which was blocked precisely because _"a local server can
  claim vision and cannot read a picture"_.
- Evidence: `tests/integration/provider-live.test.ts :: F2 — a real image, and
a question only the image can answer`
- Verdict: EXECUTED — MET

### §87 — rate limit (87-11), manual half — 2026-10-03 — **EXECUTED — NOT MET**, defect fixed

- Commit: `efafc48` (fix in the commit that follows)
- Provider: Google Gemini API
- Model: `gemini-flash-lite-latest`
- Procedure: _"drive enough requests to be limited for real, and confirm the
  retry succeeds rather than compounding. Record the vendor's retry-after
  handling."_
- Observed: the **17th** small request in a minute was refused with 429
  `RESOURCE_EXHAUSTED`, naming the quota
  `generate_content_free_tier_requests` with a value of 15. The
  **`Retry-After` header was absent.** The wait was in the body instead, as
  `google.rpc.RetryInfo` with `retryDelay: "11s"`, alongside a `QuotaFailure`.
- Why NOT MET: every adapter read the wait from the `Retry-After` **header**
  only. So for the provider most likely to rate-limit, on the free tier this
  product is built around, the retry guidance honoured since `5e7270d` never
  engaged — the agent retried on its own ~8-second backoff, arrived three
  seconds early, and collected another 429.
- Fix: `retryDelayFromDetails` reads `google.rpc.RetryInfo` from the error
  body, and the Gemini adapter prefers the header when present and the body
  otherwise. Pinned by `tests/unit/gemini.test.ts` against the exact body
  recorded above, and by `tests/integration/agent-runtime.test.ts :: waits the
time a rate-limited provider stated, then succeeds`.
- This is the finding the procedure exists to surface: _"a vendor behaviour
  that differs from its own documentation"_.
- Verdict after fix: EXECUTED — MET

### §87 — the 9Router gateway, live — 2026-10-03 — EXECUTED — MET

- Commit: `efafc48`
- Provider: a 9Router gateway running on loopback, fronting a real upstream
  account; credentials from `.env.9router.local`, which exists for this.
- Observed: **35 models across 4 upstream groups**, and all 25 cases of
  `tests/integration/nine-router-live.test.ts` passed in 30.6s — discovery,
  selection, the provider pin, a completion that returned, a capability
  measurement, and the credential absent from the audit trail and the evidence
  digest after being proved present on the wire.
- Verdict: EXECUTED — MET

### §87 / §86 — a commercial provider reached from inside the extension — 2026-10-03 — EXECUTED — MET

- Commit: `efafc48` (spec added in the commit that follows)
- Chrome: the Playwright-managed Chromium, extension loaded unpacked from `dist/`
- Provider: Google Gemini API, `generativelanguage.googleapis.com`
- Model: `gemini-flash-lite-latest`
- **Why this was worth doing after the node harness already passed.** Every
  live run until now happened in Node: the production registry, transport, gate
  and adapters assembled in a process with no extension around them. So one
  thing was still unproven — that the extension's own **service worker** can
  reach a commercial endpoint. Those are the browser's questions rather than the
  adapter's: the manifest's host permissions, an extension page's CSP, a service
  worker's `fetch` under MV3, and the egress gate running where it actually
  runs. Every provider request ever made from inside this extension had gone to
  a local server on loopback.
- Observed, phase 1: the capability doctor ran **from inside the worker** and
  reported **AGENT_READY** with all twelve checks passing against the live
  endpoint. A real task then read `/details` and answered with the weight the
  page states — `COMPLETED`, `browser.read_page` among its completed actions,
  the answer carrying a number that appears only on that page, and the
  credential absent from the task record. The side panel showed the same
  finished task.
- Observed, phase 2 — **and this is the finding.** Pointed at the site root,
  which carries `<input type="password" value="hunter2-do-not-leak">`, the run
  was refused: `POLICY_BLOCKED`, _"this transfer contains credential-shaped
  data (named-secret-assignment) and cannot be sent anywhere"_, with the
  user-facing sentence _"this request was not permitted to leave the browser.
  It was refused before anything was sent."_ `browser.read_page` had succeeded
  first — reading is allowed, because nothing left the browser — and the
  transfer was stopped before the request.

  **The exfiltration guard's credential check had never run against a real
  external destination before**, because every test provider was on loopback
  and loopback is treated differently. The first time it ran, it fired, and it
  fired correctly.

- Not asserted: the refusal itself. Driven as the only page in the context it
  produced `POLICY_BLOCKED`; driven as the second page of two it produced
  `PARTIAL`. Both are defensible, and the difference is a scheduling detail
  about when taint attaches and which tab the agent picks. The spec therefore
  reports the outcome and asserts the invariant — the password never reaches
  the task record — which holds in both orders.
- Evidence: `tests/e2e/live-provider-in-browser.spec.ts`, opt-in on
  `ABA_E2E_GEMINI_KEY`; it skips without one, so `npm run test:e2e` neither
  needs a key nor spends one.
- Verdict: EXECUTED — MET

### §84 / §87 — the whole account journey, in the extension, two vendors — 2026-10-03 — **EXECUTED — NOT MET**, defect fixed, re-executed MET

- Commit: `8a7dc08` (fix in the commit that follows)
- Chrome: the Playwright-managed Chromium, extension loaded unpacked
- Vendors: Google Gemini API (`gemini-flash-lite-latest`) and a commercial
  OpenAI-compatible gateway (`nvidia/nemotron-3.5-lightning:free`)
- Procedure: the product's own journey, through the **account** routes rather
  than the adapter — connect, discover, choose, measure, run, switch,
  disconnect.
- **Why NOT MET on the first attempt.** `accounts.connect` returned `null` with
  `INVALID_ARGUMENT`. The Gemini and Anthropic adapters' `connect` refused a
  credential with no model, so the journey's own order was impossible: a user
  had to know a model id before they could ask what the model ids were. On
  Gemini that is worse than circular, because the three ids the vendor lists
  first are all models it has retired. It also made the pasted-key path
  disagree with the Google authorization path, which has always produced an
  account with `modelId: null`.
- Fix: the model requirement moved from `connect` to the operations that use a
  model. `generate` and `stream` now refuse with _"choose a model for this
  account before running a task"_ before a request is built — which matters
  because Gemini puts the model in the request path and Anthropic in the body,
  so without it the first would have built `/models/:generateContent` and the
  second would have omitted the field, each spending a vendor round trip on
  something known locally.
- Observed after the fix:
  - `accounts.connect` with no model → an account with `modelId: null`.
  - `accounts.listModels` → **44 models from Google, 466 from the gateway**.
    Real discovery, through the extension's own route.
  - `accounts.setBrain`, then `accounts.runDoctor` → **AGENT_READY** on both
    vendors, measured from inside the service worker.
  - A task on the first vendor completed; the brain was switched to the second
    and the next task recorded `providerId: openai-compatible` and completed.
    **The switch took effect at the vendor**, which two real companies are the
    only way to demonstrate.
  - `accounts.list` carried neither credential.
  - `accounts.disconnect` removed one account and left the brain on the
    survivor — no silent fallback, no stranding.
- Evidence: `tests/e2e/live-provider-in-browser.spec.ts`, opt-in on
  `ABA_E2E_GEMINI_KEY` and `ABA_E2E_OPENROUTER_KEY`; also pinned in
  `verify` by `tests/unit/gemini.test.ts`, `tests/unit/anthropic.test.ts` and
  `tests/integration/google-account-journey.test.ts :: 01b`.
- Verdict after fix: EXECUTED — MET

### §87 — a credential the vendor rejects — 2026-10-03 — EXECUTED — MET

- Commit: `8a7dc08`
- Provider: Google Gemini API, with the real key's last four characters changed
  so the shape is right and the value is not. A locally fabricated key can be
  refused by this build's own format checks before a request leaves, which
  tests nothing about the vendor.
- Observed: the account was created and `accounts.runDoctor` reported
  **`FAILED`** with the `credentials` check failing — the vendor's refusal,
  surfaced as the vendor's. The rejected key appears in neither the account
  record nor the error.
- Verdict: EXECUTED — MET

### §87 — `api.openai.com`, directly — 2026-10-03 — **EXECUTED — PARTIAL**, defect found and fixed

- Commit: `edea3d3` (fix in the commit that follows)
- Endpoint: `https://api.openai.com/v1`, the vendor itself rather than a
  gateway. This was the one provider path D14 deliberately left alone, to avoid
  spending money.
- Observed, at **zero cost**: `GET /v1/models` answered **HTTP 200 with 127
  models**. The credential is valid and model discovery works against the
  vendor directly, which is the half of this item that needs no spending.
- Observed, on the other half: every completion answered **429**, with
  `type: insufficient_quota`, `code: credit_balance_exhausted`, _"You have no
  credits remaining"_, and **no `Retry-After` header**. The account is
  unfunded. No amount of code changes that, and nothing in it is a finding
  about this build.
- **But the way it was reported was.** Every 429 was mapped to rate limiting,
  so the user was told _"The provider is rate limiting requests. Try again
  shortly."_ — advice that can never come true — and `rate_limited` is
  **retryable**, so the agent would spend its retry budget re-asking a question
  whose answer cannot change until somebody adds money. An unfunded account now
  reports as `access_denied`, which is terminal, with a sentence saying waiting
  will not help.
- Evidence: `tests/unit/openai-compatible.test.ts` pins the recorded body and
  both controls — an unfunded account is terminal, a genuinely throttled one
  stays retryable and keeps its `Retry-After`.
- Remaining evidence needed: credit on the account, then
  `ABA_LIVE_PROTOCOL=openai-compatible ABA_LIVE_BASE_URL=https://api.openai.com/v1
ABA_LIVE_MODEL=gpt-4.1-nano npx vitest run tests/integration/provider-live.test.ts`.
- Verdict: EXECUTED — PARTIAL (credential and discovery verified; generation
  blocked by billing, not by code)

### OAuth — revocation on disconnect — 2026-10-03 — **EXECUTED — NOT MET**, defect fixed

- Commit: `edea3d3` (fix in the commit that follows)
- What was inspected: every OAuth mechanism, against its implementation and its
  tests, for the readiness matrix's per-mechanism table.
- **Found:** `authorization.ts` declared
  `revokeEndpoint: 'https://oauth2.googleapis.com/revoke'` when the Google flow
  was built, and **nothing read it** — the constant appeared exactly once in
  the whole repository, in its own declaration. `accounts.disconnect` deleted
  the stored tokens and told Google nothing. The refresh token was destroyed
  locally, so this build could no longer use the grant; the user's Google
  account went on listing the extension as authorized indefinitely. Somebody
  who pressed _Disconnect_ to withdraw access had not withdrawn it.
- Fix: the grant is withdrawn at the provider **before** the local removal,
  because the removal destroys the token revocation needs. The refresh token is
  what is sent, because revoking it takes the access tokens with it. A
  disconnect still always disconnects: every failure is reported and none of
  them blocks, because a person must not be prevented from disconnecting by the
  state of a third party.
- Evidence: `tests/security/revoke-authorization.test.ts` (11 cases), with
  three mutation-controlled rules — revoking the access token instead of the
  refresh token, letting a failure throw, and revoking for a pasted key.
- **Not live-verified, and cannot be:** revocation needs a real grant, and no
  grant can exist until a client id does. Recorded as implemented and
  unexercised rather than as working.
- Verdict after fix: EXECUTED — NOT MET live; implemented and unit-verified

### §87 — the anthropic protocol path of the live harness — 2026-10-03 — EXECUTED — BLOCKED (no key)

- Commit: `efafc48`
- What was done: no Anthropic API key exists in this environment, so the
  provider cannot be reached. What **can** be verified without one is that the
  harness's `anthropic` path works, which matters because three of its early
  live failures were harness bugs rather than build bugs.
- Observed: a local stand-in speaking the Anthropic Messages protocol —
  `x-api-key`, `/v1/models`, `/v1/messages`, `tool_use` and `tool_result`
  blocks, SSE events — was served on loopback, and the harness reached
  **AGENT_READY** through it with the full two-turn tool round trip passing.
  A mutation that made the stand-in ignore the tool result failed case D1,
  so the case has teeth on this protocol too.
- What this is **not**: evidence about `api.anthropic.com`. Nothing here
  reached a commercial Anthropic endpoint.
- Owner action: see `OWNER-CHECKLIST.md`. One command, one key.
- Verdict: EXECUTED — BLOCKED (no credential); harness verified ready

## Still not executed

Each is blocked on something this repository does not hold and will not
invent. Stated per item rather than as one excuse.

| Package | Item                 | Procedure              | Status                | What unblocks it                             |
| ------- | -------------------- | ---------------------- | --------------------- | -------------------------------------------- |
| §85     | A. Basic browser     | A-1 summary quality    | BLOCKED               | a vendor API key                             |
| §85     | B. Multi-tab         | B-1 three tabs         | BLOCKED               | a vendor API key                             |
| §85     | C. Debugging         | C-1 a real diagnosis   | BLOCKED               | a vendor API key                             |
| §85     | F. Provider swap     | F-1 real endpoints     | BLOCKED               | keys for all three vendors                   |
| §86     | Duplicate write      | against a real service | BLOCKED               | a GitHub token from the owner's own account  |
| §87     | all twelve           | against a real vendor  | BLOCKED               | a vendor API key per provider                |
| §88     | Connect              | C-1 a real grant       | BLOCKED               | a GitHub token from the owner's own account  |
| §88     | Read                 | R-1                    | BLOCKED               | §88 C-1 first                                |
| §88     | Revocation           | V-1                    | BLOCKED               | §88 C-1 first                                |
| §90     | Browser restart      | B-1                    | BLOCKED — environment | a person able to quit and reopen Chrome      |
| §90     | Extension reload     | E-1                    | BLOCKED — environment | a person at `chrome://extensions`            |
| §90     | Network interruption | N-1                    | BLOCKED — environment | a person able to drop the interface mid-task |

The first nine need a credential. A session that fabricated one would produce
a green result describing nothing.

**This table is the §85–§90 remainder and is no longer the whole of it.** The
§84 condition-3 census added six further procedures that need a person, listed
in [`MATRIX.md`](MATRIX.md) under "Still needing a person". The complete and
current list — thirty-one procedures, ordered for one sitting and grouped by
what unlocks each — is
[`OWNER-CHECKLIST.md`](../../release/OWNER-CHECKLIST.md) step 8, which is the
one place to work from.

The last three need a person at a machine **and a provider key**: each starts
by running a task, so there is nothing to interrupt without one. Playwright drives the browser it
launched: it cannot quit that browser and reattach to the same profile, and it
cannot reload the extension out from under its own connection. Each is written
and each takes a few minutes.

**§85 E remains NOT POSSIBLE HERE** — it names Jira, Confluence, Figma and
Google Sheets and needs all four at once. Three of the four now exist; Google
Sheets does not, and the item also requires a Jira write that Basic
authentication cannot establish a scope for. That is a capability gap, not a
credential gap, and no credential would unblock it.

**§85 D no longer belongs with it.** It needed a Jira connector, which now
exists, so it is `BLOCKED — SERVICE TOKEN`: one Atlassian API token away from
executable. This paragraph used to hold both items and to say this repository
implements one connector; it implements four.

---

## Items that cannot be executed here at all

| Package | Item           | Reason                                                     |
| ------- | -------------- | ---------------------------------------------------------- |
| §85     | D. Connector   | No Jira connector exists in this repository                |
| §85     | E. QA workflow | Four of its six services have no connector here            |
| §89     | Iframe         | `all_frames` is false; the extension does not enter frames |

§85 D and E are capability gaps tracked in `PARITY_MATRIX.md`; nothing
external prevents them being built. §89's iframe item is a deliberate
security position, asserted as a standing invariant so it cannot be widened
quietly.

---

## How to append a result

Add a section under **Manual execution** in this shape:

```markdown
### §89 M-1 — Modal — 2026-10-01

- Commit: abc1234
- Chrome: 141.0.7390.54 (Linux)
- Page: a consent banner on example.test
- Observed: the agent reported the element was not interactable and offered to
  dismiss the banner first.
- Verdict: EXECUTED — MET
```

Verdicts are `EXECUTED — MET`, `EXECUTED — NOT MET`, or `EXECUTED — BLOCKED`
with what blocked it. An item not attempted stays `NOT YET EXECUTED`; there is
no verdict for having read the procedure.

Record the observation even when the item was met. A result that says only
"met" cannot be re-examined later by somebody who was not there.
