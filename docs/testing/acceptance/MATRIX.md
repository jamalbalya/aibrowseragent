# Acceptance matrix — the authoritative status of every §85–§90 procedure

One row per procedure. One classification per row, from exactly this set:

| Classification                | Means                                                                 |
| ----------------------------- | --------------------------------------------------------------------- |
| `PASS`                        | Executed, and it met its criterion. The evidence column says by what. |
| `FAIL`                        | Executed, and it did not meet its criterion. Still open.              |
| `BLOCKED — CREDENTIAL`        | Implemented; needs a vendor API key nobody here holds                 |
| `BLOCKED — OAUTH`             | Implemented; needs a registered OAuth application                     |
| `BLOCKED — HUMAN/ENVIRONMENT` | Implemented; needs a person at a machine, not a headless container    |
| `NOT IMPLEMENTED`             | The capability itself does not exist here. No credential unblocks it. |
| `NOT EXECUTED`                | Nothing has run it and nothing is stopping it                         |

Every row carries one of the seven classifications above and nothing else —
a hedge is not a status. Where a procedure has an automated half
and a manual half, it is split into two rows, because one classification
cannot honestly describe both.

**A `PASS` in the manual column never comes from automated evidence.** The two
columns are separate on purpose: `Automated coverage` says what runs on every
build, `Manual status` says whether a person executed the written procedure.

Verified at commit `a3da142cffd901ac056477eedcf9d01e57b5c6c7`, CI run #37
(all three jobs green): 2,128 unit/integration/security tests in 79 files, 189
in real Chromium, 0 dependency vulnerabilities.

---

## Totals

| Classification                | Count |
| ----------------------------- | ----- |
| `PASS`                        | 27    |
| `FAIL`                        | 0     |
| `BLOCKED — CREDENTIAL`        | 17    |
| `BLOCKED — OAUTH`             | 5     |
| `BLOCKED — HUMAN/ENVIRONMENT` | 3     |
| `NOT IMPLEMENTED`             | 3     |
| `NOT EXECUTED`                | 0     |

Two procedures were executed and **failed**; both were product defects, both
are fixed, and both now read `PASS` against the criterion they originally
failed. The failures are recorded in [RESULTS.md](RESULTS.md) rather than
erased — a criterion that was once failed and is now met is a different fact
from one that always passed.

---

## §85 — Mandatory acceptance

| ID        | Capability                                      | Prerequisite                             | Exact action required                                                          | Automated coverage                                                             | Manual status          | Evidence                                                                                | Owner action                                      |
| --------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 85-A-auto | Navigation, read, type, click, extraction       | none                                     | —                                                                              | `PASS` — 4 E2E cases in real Chromium                                          | n/a                    | `agent-task.spec.ts`, `extension-load.spec.ts`                                          | none                                              |
| 85-A-1    | Whether the summary is accurate and useful      | a vendor API key                         | Configure a provider, run the A-1 prompt, compare the summary against the page | not assertable                                                                 | `BLOCKED — CREDENTIAL` | [85-mandatory.md](85-mandatory.md) A-1                                                  | supply one API key                                |
| 85-B-auto | Tab discovery, switching, context separation    | none                                     | —                                                                              | `PASS` — multi-tab, tab groups, per-task isolation, taint per task             | n/a                    | `extension-load.spec.ts`, `agent-task.spec.ts`, `audit.spec.ts`, `exfiltration.test.ts` | none                                              |
| 85-B-1    | A three-tab comparison                          | a vendor API key                         | Open three comparable pages, ask for a comparison, close one mid-task          | two tabs covered, not three                                                    | `BLOCKED — CREDENTIAL` | [85-mandatory.md](85-mandatory.md) B-1                                                  | supply one API key                                |
| 85-C-auto | DOM, console, network and UI-state capture      | none                                     | —                                                                              | `PASS` — real debugger against a real tab, allowlist enforced                  | n/a                    | `mv3-lifecycle.spec.ts`, `security.spec.ts`                                             | none                                              |
| 85-C-1    | Whether the diagnosis is correct                | a vendor API key                         | Stage a genuinely broken Save, ask for the cause, compare                      | not assertable                                                                 | `BLOCKED — CREDENTIAL` | [85-mandatory.md](85-mandatory.md) C-1                                                  | supply one API key; stage the broken page         |
| 85-D      | Fetch PROJ-123, prefer the Jira connector       | **a Jira connector that does not exist** | Build a Jira connector                                                         | none, and none possible                                                        | `NOT IMPLEMENTED`      | [85-mandatory.md](85-mandatory.md) D                                                    | decide whether to build it; no credential helps   |
| 85-E      | Jira + Confluence + Figma + Sheets QA workflow  | **four connectors that do not exist**    | Build four connectors                                                          | skill, browser, debugger, evidence and permission halves covered               | `NOT IMPLEMENTED`      | [85-mandatory.md](85-mandatory.md) E                                                    | decide whether to build them; no credential helps |
| 85-F-auto | Same tools and policy across three adapters     | none                                     | —                                                                              | `PASS` — all three over real sockets against local servers in each wire format | n/a                    | `provider-switching.spec.ts` (10 cases)                                                 | none                                              |
| 85-F-1    | The same workflow against real vendor endpoints | **three** vendor API keys                | Run the identical prompt on each; compare tools, prompts and answer            | local servers only                                                             | `BLOCKED — CREDENTIAL` | [85-mandatory.md](85-mandatory.md) F-1                                                  | supply OpenAI + Anthropic + Gemini keys           |

**§85 D and E are `NOT IMPLEMENTED`, not credential-blocked.** They name Jira,
Confluence, Figma and Google Sheets. This repository implements one connector,
GitHub. Handing over every credential in the world would not make them
runnable; the code does not exist. That is a capability gap tracked in
`PARITY_MATRIX.md`, and it is the one item on this page that a purchase cannot
fix.

---

## §86 — Security acceptance

| ID          | Capability                               | Prerequisite                   | Exact action required                                                                             | Automated coverage                                                                                                                                    | Manual status                                                                | Evidence                                             | Owner action          |
| ----------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| 86-1        | Prompt injection                         | none                           | —                                                                                                 | `PASS` — a genuinely hostile page in real Chromium: override text, forged approval claim, a literal closing envelope marker, an API-key-shaped string | `NOT EXECUTED` (not required)                                                | `security.spec.ts`, `prompt-injection.test.ts`       | none                  |
| 86-2        | Exfiltration                             | none                           | —                                                                                                 | `PASS` — asserted at the receiving end (zero hits on a real collector) across five encodings, with positive controls                                  | `NOT EXECUTED` (not required)                                                | `egress.spec.ts` (12 cases)                          | none                  |
| 86-3        | Redirect / origin change                 | none                           | —                                                                                                 | `PASS` — cross-origin redirect forces revalidation; same-origin move does not                                                                         | `NOT EXECUTED` (not required)                                                | `origin-validation.test.ts`, `browser-tools.test.ts` | none                  |
| 86-4        | Credential leakage                       | none                           | —                                                                                                 | `PASS` — provider prompt and worker log checked separately                                                                                            | `security.spec.ts`, `provider-switching.spec.ts`, `secret-redaction.test.ts` | `NOT EXECUTED` (not required)                        | none                  |
| 86-5-auto   | Duplicate write — the guard              | none                           | —                                                                                                 | `PASS` — claim persisted before the request; timeout/abort/unclassified all resolve to _unknown_; replay refused                                      | n/a                                                                          | `write-guard.test.ts` (25 cases)                     | none                  |
| 86-5-manual | Duplicate write — against a real service | a registered OAuth application | Connect GitHub, start a write, kill the worker mid-flight, check the repository holds exactly one | guard only                                                                                                                                            | `BLOCKED — OAUTH`                                                            | [86-security.md](86-security.md)                     | register an OAuth app |

**No row here was upgraded from automated to manual.** Items 1–4 are marked
`NOT EXECUTED` in the manual column and `PASS` in the automated one, which is
the honest pair: they run in a real browser against real hostile input on
every build, and no person has separately sat down and done them by hand.
Nothing in §86 requires that they do.

---

## §87 — Provider acceptance

Every row is `PASS` against a local server implementing the provider's
documented wire format over real HTTP — real sockets, headers, CORS and SSE
framing — and `BLOCKED — CREDENTIAL` against the vendor's own endpoint. A
local server answers exactly what it was told to, so it proves the adapter
reads and writes the format and proves nothing about the vendor honouring its
own documentation.

| ID    | Item                   | Automated (local)                   | Manual (real vendor)   | Evidence                                                              |
| ----- | ---------------------- | ----------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| 87-01 | connect                | `PASS`                              | `BLOCKED — CREDENTIAL` | `provider-integration.spec.ts`, `provider-switching.spec.ts`          |
| 87-02 | validate               | `PASS`                              | `BLOCKED — CREDENTIAL` | `capability-doctor.test.ts` (17 cases)                                |
| 87-03 | list models            | `PASS`                              | `BLOCKED — CREDENTIAL` | `capability-doctor.test.ts`                                           |
| 87-04 | text generation        | `PASS`                              | `BLOCKED — CREDENTIAL` | `provider-switching.spec.ts`, `anthropic.test.ts`, `gemini.test.ts`   |
| 87-05 | streaming              | `PASS`                              | `BLOCKED — CREDENTIAL` | `openai-compatible.test.ts` (split chunks, CRLF, unterminated frame)  |
| 87-06 | tool calling           | `PASS`                              | `BLOCKED — CREDENTIAL` | `provider-switching.spec.ts`, `provider-integration.spec.ts`          |
| 87-07 | multiple tool calls    | `PASS`                              | `BLOCKED — CREDENTIAL` | `sustained-task.test.ts` (18 turns, 36 calls)                         |
| 87-08 | vision                 | `PASS` (encoding + capability gate) | `BLOCKED — CREDENTIAL` | `openai-compatible.test.ts`, `agent-task.spec.ts`                     |
| 87-09 | invalid credentials    | `PASS`                              | `BLOCKED — CREDENTIAL` | `provider-integration.spec.ts`, `capability-doctor.test.ts`           |
| 87-10 | expired auth           | `PASS`                              | `BLOCKED — CREDENTIAL` | `token-vault.test.ts` (an API key is revoked, not expired — see note) |
| 87-11 | rate limiting          | `PASS`                              | `BLOCKED — CREDENTIAL` | `provider-integration.spec.ts`, `budget-retry.test.ts`                |
| 87-12 | unsupported capability | `PASS`                              | `BLOCKED — CREDENTIAL` | `provider-integration.spec.ts`, `provider-switching.spec.ts`          |

### Minimum credentials required

| Purpose                              | Minimum                                                       | Why                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Items 87-01 … 87-12 for one provider | **1 key**, any one of the three                               | Every item is per-provider; one key exercises all twelve once                                                                 |
| §85 F-1 provider swap                | **3 keys** — one OpenAI-compatible, one Anthropic, one Gemini | The claim is that three _different adapters_ produce the same tools, prompts and answer. Two keys cannot test three adapters. |
| Item 87-08 vision                    | 1 key **for a model that advertises vision**                  | A text-only model reports the capability as unsupported, which is a different (already covered) path                          |
| Item 87-06/07 tool calling           | 1 key **for a model that can call tools**                     | The doctor refuses a task outright on a model that cannot; that refusal is already covered                                    |

**Three keys total** unblocks everything in §87 and §85 F. One key unblocks
§85 A-1, B-1 and C-1 and one provider's worth of §87.

Do not paste a key into this conversation, a file, a commit, a screenshot or
an issue. Enter it in the extension's own settings, in your own browser.

Note on 87-10: an API key does not expire on a schedule the way an OAuth grant
does — it is revoked, and the next call is rejected, which is the
invalid-credential path. Genuine timed expiry belongs to §88, and the vault
citations are listed here because §87 asks and that is the honest answer.

---

## §88 — Connector acceptance

Four different things, kept apart because conflating them is how a missing
feature gets described as a missing credential.

### A. Connector framework — implemented

| Capability                                                        | Status | Evidence                               |
| ----------------------------------------------------------------- | ------ | -------------------------------------- |
| OAuth with PKCE, one route into READY                             | `PASS` | `connector-session.test.ts` (26 cases) |
| Never reaches READY on any failing path                           | `PASS` | swept, not enumerated                  |
| Token vault exposing no bare token                                | `PASS` | `token-vault.test.ts`                  |
| Credential never in URL, result, evidence, log or status          | `PASS` | `connector-security.test.ts`           |
| Redirect handling: no auto-follow, no scheme downgrade, no loop   | `PASS` | `connector-security.test.ts`           |
| Write guard / idempotency                                         | `PASS` | `write-guard.test.ts`                  |
| No `identity` permission; `chrome.identity` genuinely unavailable | `PASS` | `connector.spec.ts`                    |

### B. Individual connectors

| Connector     | Implementation                                    | Status                                       |
| ------------- | ------------------------------------------------- | -------------------------------------------- |
| GitHub        | implemented (`src/connectors/adapters/github.ts`) | framework `PASS`; live use `BLOCKED — OAUTH` |
| Jira          | **does not exist**                                | `NOT IMPLEMENTED`                            |
| Confluence    | **does not exist**                                | `NOT IMPLEMENTED`                            |
| Figma         | **does not exist**                                | `NOT IMPLEMENTED`                            |
| Google Sheets | **does not exist**                                | `NOT IMPLEMENTED`                            |

The four absent connectors are `NOT IMPLEMENTED`. They are not waiting on an
OAuth application. Registering one for Jira would produce a client id with
nothing to use it.

### C. OAuth application requirement — GitHub only

| Item                 | Status             | Needs                                                                          |
| -------------------- | ------------------ | ------------------------------------------------------------------------------ |
| 88-connect (C-1)     | `BLOCKED — OAUTH`  | a GitHub OAuth app with callback `chrome-extension://<id>/oauth/callback.html` |
| 88-scope-validation  | `PASS` (automated) | —                                                                              |
| 88-read (R-1)        | `BLOCKED — OAUTH`  | C-1 first                                                                      |
| 88-write             | `BLOCKED — OAUTH`  | C-1 first                                                                      |
| 88-auth-expiry       | `PASS` (automated) | —                                                                              |
| 88-revocation (V-1)  | `BLOCKED — OAUTH`  | C-1 first                                                                      |
| 88-rate-limit        | `PASS` (automated) | —                                                                              |
| 88-permission-denied | `PASS` (automated) | —                                                                              |
| 88-least-privilege   | `PASS` (automated) | —                                                                              |

### D. User credential requirement

None beyond the OAuth grant itself. The connector holds no username or
password: the user approves at github.com and the extension stores only what
the service granted, in session storage, which does not survive a browser
restart.

---

## §89 — Browser failure

| ID    | Scenario             | Automated coverage                                                    | Manual                                               | Architectural limit | Status                        |
| ----- | -------------------- | --------------------------------------------------------------------- | ---------------------------------------------------- | ------------------- | ----------------------------- |
| 89-01 | page not loaded      | `browser-tools.test.ts`, `file-access.spec.ts`                        | n/a                                                  | —                   | `PASS`                        |
| 89-02 | element missing      | `browser-tools.test.ts`, `workflows.spec.ts`                          | n/a                                                  | —                   | `PASS`                        |
| 89-03 | element disabled     | `advanced-form-controls.test.ts`, `advanced-forms.spec.ts`            | n/a                                                  | —                   | `PASS`                        |
| 89-04 | tab closed           | `browser-tools.test.ts`, `mv3-lifecycle.spec.ts`, `tab-tools.test.ts` | n/a                                                  | —                   | `PASS`                        |
| 89-05 | navigation timeout   | `browser-tools.test.ts`, `budget-retry.test.ts`                       | n/a                                                  | —                   | `PASS`                        |
| 89-06 | **iframe**           | `browser-failures.spec.ts` (4 cases)                                  | executed 2026-09-22                                  | **yes — see below** | `NOT IMPLEMENTED` (by design) |
| 89-07 | **popup**            | `browser-failures.spec.ts` (2 cases)                                  | executed 2026-09-22                                  | —                   | `PASS`                        |
| 89-08 | redirect             | `origin-validation.test.ts`, `browser-tools.test.ts`                  | n/a                                                  | —                   | `PASS`                        |
| 89-09 | **SPA navigation**   | `browser-failures.spec.ts` (2 cases)                                  | executed 2026-09-22                                  | —                   | `PASS`                        |
| 89-10 | **modal**            | `browser-failures.spec.ts` (4), `occlusion.test.ts` (12)              | executed 2026-09-22 — **failed**, fixed, re-executed | —                   | `PASS` (was `FAIL`)           |
| 89-11 | stale element        | `agent-task.spec.ts`, `interaction-engine.test.ts`                    | n/a                                                  | —                   | `PASS`                        |
| 89-12 | debugger unavailable | `browser-tools.test.ts` (6 cases), `file-access.spec.ts`              | n/a                                                  | —                   | `PASS`                        |

### 89-06 iframe — the architectural limitation, stated explicitly

**The extension cannot see inside any iframe, and this will not change
without a manifest change nobody should make lightly.**

`content_scripts.all_frames` is `false`. The content script is injected into
the top-level document only. Consequences, in plain terms:

- A form field inside an iframe **cannot be filled**. It is not in the page
  model at all.
- A button inside an iframe **cannot be clicked**.
- Text inside an iframe **is not read** and does not reach the model.
- This applies to **same-origin** iframes too, not only cross-origin ones.
  The executed procedure used a same-origin child deliberately, because that
  is the case the browser would otherwise permit.

This is a deliberate security position. Setting `all_frames: true` would
inject the content script into every third-party frame on every page the user
visits — ad frames, embedded widgets, payment iframes — which is a materially
larger attack surface than the feature repays. It is enforced as a standing
invariant so it cannot be widened quietly.

The user-visible behaviour is the `element missing` path: the agent reports it
cannot see the element, rather than failing in some stranger way. Any checkout
flow, embedded editor or payment form that lives in an iframe is out of scope
for this extension. That belongs in the store listing, and it is there.

---

## §90 — MV3 failure

| ID    | Scenario                   | What automation proved                                                                                                                                                                                                  | What still needs a human                                                                                                                                 | Status                        |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 90-01 | service worker restart     | A real Chrome worker termination, nine times over: task state, settings, taint, audit sequence, skill security state, health record and route trust all survive, and route trust is restored _before_ routes are served | nothing                                                                                                                                                  | `PASS`                        |
| 90-02 | pending task recovery      | An interrupted task is **parked, not resumed** — the runtime cannot know what happened in the gap, so the user decides                                                                                                  | nothing                                                                                                                                                  | `PASS`                        |
| 90-03 | persistence degradation    | A degraded record blocks work until acknowledged; a degraded _audit_ domain deliberately does not                                                                                                                       | nothing                                                                                                                                                  | `PASS`                        |
| 90-04 | malformed persisted state  | Real garbage written into real `chrome.storage.local`, worker killed, revived worker interrogated: corrupt task index, unreadable task record, truncated health record, edited audit record                             | nothing                                                                                                                                                  | `PASS` (was `FAIL`)           |
| 90-05 | recovery-required state    | The five-state ladder is monotone and the in-memory floor survives a read failure                                                                                                                                       | nothing                                                                                                                                                  | `PASS`                        |
| 90-06 | no fail-open authorization | A worker termination never reduces a task's security state; UNKNOWN taint blocks                                                                                                                                        | nothing                                                                                                                                                  | `PASS`                        |
| 90-07 | side panel close           | A prompt open when the panel closes resolves as **denial**; a late answer changes nothing                                                                                                                               | nothing                                                                                                                                                  | `PASS`                        |
| 90-08 | **browser restart**        | nothing — Playwright cannot quit the browser it launched and reattach to the same profile                                                                                                                               | Quit Chrome fully, reopen, confirm the task is parked, settings survive, **and the connector needs re-authorization** (session storage does not survive) | `BLOCKED — HUMAN/ENVIRONMENT` |
| 90-09 | **extension reload**       | nothing — Playwright cannot reload the extension out from under its own connection                                                                                                                                      | Reload at `chrome://extensions`, confirm the task is parked and that acting on a pre-existing tab reports the page must be reloaded                      | `BLOCKED — HUMAN/ENVIRONMENT` |
| 90-10 | **network interruption**   | classification and retry: timeout, abort and unclassified transport failures all resolve to _unknown_; transient codes retry with backoff and stop at the attempt limit                                                 | Drop the interface mid-task; confirm it retries and continues when restored, and fails cleanly when left down past the limit                             | `BLOCKED — HUMAN/ENVIRONMENT` |

Three rows need a person. None needs a credential, and none takes long.
90-08's connector re-authorization is the detail most likely to look like a
bug and is correct: connector tokens live in session storage precisely so they
do not survive a browser restart.
