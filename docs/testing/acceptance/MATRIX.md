# Acceptance matrix — the authoritative status of every acceptance procedure

One row per procedure. One classification per row, from exactly this set:

| Classification                | Means                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `PASS`                        | Executed, and it met its criterion. The evidence column says by what.            |
| `FAIL`                        | Executed, and it did not meet its criterion. Still open.                         |
| `BLOCKED — CREDENTIAL`        | Implemented; needs a vendor API key nobody here holds                            |
| `BLOCKED — SERVICE TOKEN`     | Implemented; needs a token for an external service, from the owner's own account |
| `BLOCKED — HUMAN/ENVIRONMENT` | Implemented; needs a person at a machine, not a headless container               |
| `NOT IMPLEMENTED`             | The capability itself does not exist here. No credential unblocks it.            |
| `NOT EXECUTED`                | Nothing has run it and nothing is stopping it                                    |

Every row carries one of the seven classifications above and nothing else —
a hedge is not a status.

**One classification was renamed, because its name asserted something false.**
It was `BLOCKED — OAUTH`, meaning "needs a registered OAuth application". Those
five rows do not need one, and registering one would not have unblocked them:
GitHub's web application flow requires a `client_secret` in the code exchange,
Atlassian requires one and supports no PKCE at all, Figma requires one even
with PKCE, and this extension must not carry a secret. What the rows need is a
token the owner creates in their own account, which is a different kind of
work and one that succeeds. The count is unchanged — five rows, still blocked,
on a correctly named blocker. `docs/connectors.md` has the table and the vendor
sources. Where a procedure has an automated half
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
| `PASS`                        | 45    |
| `FAIL`                        | 0     |
| `BLOCKED — CREDENTIAL`        | 17    |
| `BLOCKED — SERVICE TOKEN`     | 5     |
| `BLOCKED — HUMAN/ENVIRONMENT` | 10    |
| `NOT IMPLEMENTED`             | 4     |
| `NOT EXECUTED`                | 0     |

The §84 section below added twenty-three rows to the counts above: sixteen
`PASS` (executed, as automated tests), six `BLOCKED — HUMAN/ENVIRONMENT` and one
`NOT IMPLEMENTED`. That is the whole of the change from the figures this table
carried before §84 existed.

Two procedures were executed and **failed**; both were product defects, both
are fixed, and both now read `PASS` against the criterion they originally
failed. The failures are recorded in [RESULTS.md](RESULTS.md) rather than
erased — a criterion that was once failed and is now met is a different fact
from one that always passed.

---

## §84 — Per-capability manual acceptance

Specification §84 condition 3 is stated per capability, and nothing answered it
per capability until [`84-capabilities.md`](84-capabilities.md). Seventeen
capabilities were covered by procedures already on this page; P-025 has nothing
to put a person in front of; and twenty-two had no manual acceptance test at
all, so one was written for each.

**Sixteen of those twenty-two have since been executed**, and executing them is
what turned this from a documentation exercise into engineering: 84-P-037 found
a defect that stranded every looping task in `WAITING_FOR_TOOL` for good. The
route is the one [`RESULTS.md`](RESULTS.md) already records for §89's P-1, S-1
and M-1 — execute the procedure, turn it into a test, and it runs on every build
instead of waiting for somebody to remember.

Two of the written procedures were **wrong about the product** and were
corrected on execution rather than quietly rewritten: P-027 named a form
submission as its R3 action (a same-site submission is R2), and P-028 asked for
a subdomain the loopback fixture cannot have. Both corrections are recorded in
`84-capabilities.md` under the item they belong to.

### Executed

| ID       | Capability               | What the procedure asks                                                      | Automated coverage                                                     | Manual status                          |
| -------- | ------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| 84-P-006 | P-006 Forms              | Five control kinds filled and submitted; the server got all five             | `PASS` — `acceptance-84.spec.ts` (1 case), read off the receiving side | `NOT EXECUTED` (covered automatically) |
| 84-P-007 | P-007 Scroll             | A target below the fold, and one inside a nested scrolling container         | `PASS` — `acceptance-84.spec.ts` (2 cases)                             | `NOT EXECUTED` (covered automatically) |
| 84-P-010 | P-010 File upload        | A chosen file reaches the input; declining attaches nothing                  | `PASS` — `file-transfer.spec.ts` (2 cases)                             | `NOT EXECUTED` (covered automatically) |
| 84-P-013 | P-013 Tab grouping       | A real Chrome group holding exactly the tabs named                           | `PASS` — `agent-task.spec.ts`, `tab-scope.spec.ts`                     | `NOT EXECUTED` (covered automatically) |
| 84-P-017 | P-017 Long-running task  | Survives eviction and finishes without repeating a step                      | `PASS` — `task-pause.spec.ts`, `mv3-lifecycle.spec.ts`                 | `NOT EXECUTED` (covered automatically) |
| 84-P-018 | P-018 Background task    | Keeps running with the panel closed; parked rather than resumed blind        | `PASS` — `agent-task.spec.ts`, `mv3-lifecycle.spec.ts`                 | `NOT EXECUTED` (covered automatically) |
| 84-P-021 | P-021 Shortcuts          | Invoke, export, import; the narrowing is not widened by the file             | `PASS` — `shortcuts.spec.ts`, `export-import.spec.ts`                  | `NOT EXECUTED` (covered automatically) |
| 84-P-022 | P-022 Workflow recording | Records, keeps no secret, refuses an incomplete replay                       | `PASS` — `workflows.spec.ts` (3 cases)                                 | `NOT EXECUTED` (covered automatically) |
| 84-P-024 | P-024 Skills             | Runs, is not silently resumed after eviction, refuses an invented definition | `PASS` — `skills.spec.ts` (3 cases)                                    | `NOT EXECUTED` (covered automatically) |
| 84-P-027 | P-027 Permission modes   | Manual asks and auto does not; all three modes confirm at R3                 | `PASS` — `acceptance-84.spec.ts` (2 cases)                             | `NOT EXECUTED` (covered automatically) |
| 84-P-028 | P-028 Site permissions   | A grant covers the site it names and does not survive the page moving        | `PASS` — `site-authorization.spec.ts` (3 cases)                        | `NOT EXECUTED` (covered automatically) |
| 84-P-029 | P-029 Permission history | An approval, a denial, a grant and a revocation are all recorded             | `PASS` — `audit.spec.ts`, `security.spec.ts`                           | `NOT EXECUTED` (covered automatically) |
| 84-P-035 | P-035 Capability doctor  | The missing capability is named before anything is sent                      | `PASS` — `provider-integration.spec.ts` (3 cases)                      | `NOT EXECUTED` (covered automatically) |
| 84-P-037 | P-037 Loop detection     | The task stops and says it repeated itself, rather than spending its budget  | `PASS` — `acceptance-84.spec.ts` (1 case) — **found a defect**         | `NOT EXECUTED` (covered automatically) |
| 84-P-038 | P-038 Audit trail        | Every authority-changing action recorded and exported, with no page text     | `PASS` — `audit.spec.ts` (3 cases)                                     | `NOT EXECUTED` (covered automatically) |
| 84-P-039 | P-039 Evidence model     | Every claim traces to something observed                                     | `PASS` — `agent-task.spec.ts` (2 cases)                                | `NOT EXECUTED` (covered automatically) |

### Still needing a person

Every row states what a person has to do and why no automation here reaches it.

| ID       | Capability            | Exact action required                                                           | Why automation is insufficient                                                                                                                                                                                                                                                                                                                                  | Status                        |
| -------- | --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 84-P-001 | P-001 Side panel      | The panel opens beside the page and never obscures or reflows it                | Chrome's own side-panel chrome; Playwright loads the document as an ordinary page                                                                                                                                                                                                                                                                               | `BLOCKED — HUMAN/ENVIRONMENT` |
| 84-P-008 | P-008 Screenshot      | A question only the rendered appearance can answer is answered from the capture | A real model's judgement; the mock provider answers from a script (also needs a key)                                                                                                                                                                                                                                                                            | `BLOCKED — HUMAN/ENVIRONMENT` |
| 84-P-009 | P-009 Image upload    | Answered from the image on a vision model; refused before sending without one   | A local server can claim vision and cannot read a picture (also needs a key)                                                                                                                                                                                                                                                                                    | `BLOCKED — HUMAN/ENVIRONMENT` |
| 84-P-019 | P-019 Notifications   | Clicking the notification brings you to the panel at the right place            | The click is delivered by the OS notification centre, outside the browser                                                                                                                                                                                                                                                                                       | `BLOCKED — HUMAN/ENVIRONMENT` |
| 84-P-020 | P-020 Scheduled tasks | The schedule survives a full browser restart                                    | 90-08's reason: Playwright cannot quit the browser it launched and reattach                                                                                                                                                                                                                                                                                     | `BLOCKED — HUMAN/ENVIRONMENT` |
| 84-P-026 | P-026 MCP             | Every MCP call prompts, on every call, and a decline performs nothing           | The origin check refuses a plain-http destination, so a loopback server's tools discover and never run — needs an https origin somebody else operates. The **clause** `P-026-C2` is VERIFIED against exactly such a server; what is left is a person driving this procedure, which is why this row is HUMAN/ENVIRONMENT and no longer cites an external blocker | `BLOCKED — HUMAN/ENVIRONMENT` |

| 84-P-025 | P-025 Plugins | — | Nothing is implemented, so there is no behaviour to put a person in front of | `NOT IMPLEMENTED` |

`84-P-025` is the one capability whose condition 3 cannot be answered by writing
a procedure, and whether it ships at all is owner decision C-1 in
[`BLOCKER-CERTIFICATION.md`](../../release/BLOCKER-CERTIFICATION.md).

---

## §85 — Mandatory acceptance

| ID        | Capability                                      | Prerequisite                             | Exact action required                                                          | Automated coverage                                                                                   | Manual status             | Evidence                                                                                | Owner action                                        |
| --------- | ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 85-A-auto | Navigation, read, type, click, extraction       | none                                     | —                                                                              | `PASS` — 4 E2E cases in real Chromium                                                                | n/a                       | `agent-task.spec.ts`, `extension-load.spec.ts`                                          | none                                                |
| 85-A-1    | Whether the summary is accurate and useful      | a vendor API key                         | Configure a provider, run the A-1 prompt, compare the summary against the page | not assertable                                                                                       | `BLOCKED — CREDENTIAL`    | [85-mandatory.md](85-mandatory.md) A-1                                                  | supply one API key                                  |
| 85-B-auto | Tab discovery, switching, context separation    | none                                     | —                                                                              | `PASS` — multi-tab, tab groups, per-task isolation, taint per task                                   | n/a                       | `extension-load.spec.ts`, `agent-task.spec.ts`, `audit.spec.ts`, `exfiltration.test.ts` | none                                                |
| 85-B-1    | A three-tab comparison                          | a vendor API key                         | Open three comparable pages, ask for a comparison, close one mid-task          | two tabs covered, not three                                                                          | `BLOCKED — CREDENTIAL`    | [85-mandatory.md](85-mandatory.md) B-1                                                  | supply one API key                                  |
| 85-C-auto | DOM, console, network and UI-state capture      | none                                     | —                                                                              | `PASS` — real debugger against a real tab, allowlist enforced                                        | n/a                       | `mv3-lifecycle.spec.ts`, `security.spec.ts`                                             | none                                                |
| 85-C-1    | Whether the diagnosis is correct                | a vendor API key                         | Stage a genuinely broken Save, ask for the cause, compare                      | not assertable                                                                                       | `BLOCKED — CREDENTIAL`    | [85-mandatory.md](85-mandatory.md) C-1                                                  | supply one API key; stage the broken page           |
| 85-D      | Fetch PROJ-123, prefer the Jira connector       | an Atlassian API token                   | Connect Jira with your own token and site, then ask for one of your issues     | the connector, its binding and its tools in the registry are covered                                 | `BLOCKED — SERVICE TOKEN` | [85-mandatory.md](85-mandatory.md) D                                                    | create one API token                                |
| 85-E      | Jira + Confluence + Figma + Sheets QA workflow  | **a Sheets connector, and a Jira write** | Build a Sheets connector; a Jira write needs scopes Basic auth cannot report   | three of its four connectors exist; skill, browser, debugger, evidence and permission halves covered | `NOT IMPLEMENTED`         | [85-mandatory.md](85-mandatory.md) E                                                    | decide whether to build Sheets; no credential helps |
| 85-F-auto | Same tools and policy across three adapters     | none                                     | —                                                                              | `PASS` — all three over real sockets against local servers in each wire format                       | n/a                       | `provider-switching.spec.ts` (10 cases)                                                 | none                                                |
| 85-F-1    | The same workflow against real vendor endpoints | **three** vendor API keys                | Run the identical prompt on each; compare tools, prompts and answer            | local servers only                                                                                   | `BLOCKED — CREDENTIAL`    | [85-mandatory.md](85-mandatory.md) F-1                                                  | supply OpenAI + Anthropic + Gemini keys             |

**§85 E is `NOT IMPLEMENTED`, not credential-blocked.** It names Jira,
Confluence, Figma and Google Sheets and needs all four at once. Three now
exist; Google Sheets does not, and the item also requires a Jira **write** that
Basic authentication cannot establish a scope for. Handing over every
credential in the world would not make it runnable. That is a capability gap
tracked in `PARITY_MATRIX.md`, and it is the one item on this page that a
purchase cannot fix.

**§85 D has moved.** This paragraph used to hold D alongside E, on the grounds
that _"this repository implements one connector, GitHub"_. Four connectors now
exist, Jira among them, so D is `BLOCKED — SERVICE TOKEN`: executable by
anybody with an Atlassian API token, which is section D-2 of
`docs/release/OWNER-CHECKLIST.md`.

---

## §86 — Security acceptance

| ID          | Capability                               | Prerequisite                                | Exact action required                                                                             | Automated coverage                                                                                                                                    | Manual status                                                                | Evidence                                             | Owner action          |
| ----------- | ---------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------- |
| 86-1        | Prompt injection                         | none                                        | —                                                                                                 | `PASS` — a genuinely hostile page in real Chromium: override text, forged approval claim, a literal closing envelope marker, an API-key-shaped string | `NOT EXECUTED` (not required)                                                | `security.spec.ts`, `prompt-injection.test.ts`       | none                  |
| 86-2        | Exfiltration                             | none                                        | —                                                                                                 | `PASS` — asserted at the receiving end (zero hits on a real collector) across five encodings, with positive controls                                  | `NOT EXECUTED` (not required)                                                | `egress.spec.ts` (12 cases)                          | none                  |
| 86-3        | Redirect / origin change                 | none                                        | —                                                                                                 | `PASS` — cross-origin redirect forces revalidation; same-origin move does not                                                                         | `NOT EXECUTED` (not required)                                                | `origin-validation.test.ts`, `browser-tools.test.ts` | none                  |
| 86-4        | Credential leakage                       | none                                        | —                                                                                                 | `PASS` — provider prompt and worker log checked separately                                                                                            | `security.spec.ts`, `provider-switching.spec.ts`, `secret-redaction.test.ts` | `NOT EXECUTED` (not required)                        | none                  |
| 86-5-auto   | Duplicate write — the guard              | none                                        | —                                                                                                 | `PASS` — claim persisted before the request; timeout/abort/unclassified all resolve to _unknown_; replay refused                                      | n/a                                                                          | `write-guard.test.ts` (25 cases)                     | none                  |
| 86-5-manual | Duplicate write — against a real service | a GitHub token from the owner's own account | Connect GitHub, start a write, kill the worker mid-flight, check the repository holds exactly one | guard only                                                                                                                                            | `BLOCKED — SERVICE TOKEN`                                                    | [86-security.md](86-security.md)                     | create a GitHub token |

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

| Connector     | Implementation                                        | Status                                               |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| GitHub        | implemented (`src/connectors/adapters/github.ts`)     | framework `PASS`; live use `BLOCKED — SERVICE TOKEN` |
| Figma         | implemented (`src/connectors/adapters/figma.ts`)      | framework `PASS`; live use `BLOCKED — SERVICE TOKEN` |
| Jira          | implemented (`src/connectors/adapters/jira.ts`)       | framework `PASS`; live use `BLOCKED — SERVICE TOKEN` |
| Confluence    | implemented (`src/connectors/adapters/confluence.ts`) | framework `PASS`; live use `BLOCKED — SERVICE TOKEN` |
| Google Sheets | **does not exist**                                    | `NOT IMPLEMENTED`                                    |

Google Sheets is the one that remains `NOT IMPLEMENTED`, and it is the only one
of the five where a registered client id would actually be the thing needed:
Google's Chrome client type takes no secret. For the other four it never was —
GitHub's web flow, Atlassian 3LO and Figma all require a `client_secret` this
extension must not hold, so each is connected with a token the user creates in
their own account instead. `docs/connectors.md` has the table and the sources.

This paragraph used to say _"the four absent connectors are NOT IMPLEMENTED"_
and that registering an application for Jira _"would produce a client id with
nothing to use it"_. The second half was right for the wrong reason, and the
first stopped being true.

### C. OAuth application requirement — GitHub only

| Item                 | Status                    | Needs                                                                                   |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| 88-connect (C-1)     | `BLOCKED — SERVICE TOKEN` | a classic GitHub personal access token with `public_repo`, from the owner's own account |
| 88-scope-validation  | `PASS` (automated)        | —                                                                                       |
| 88-read (R-1)        | `BLOCKED — SERVICE TOKEN` | C-1 first                                                                               |
| 88-write             | `BLOCKED — SERVICE TOKEN` | C-1 first                                                                               |
| 88-auth-expiry       | `PASS` (automated)        | —                                                                                       |
| 88-revocation (V-1)  | `BLOCKED — SERVICE TOKEN` | C-1 first                                                                               |
| 88-rate-limit        | `PASS` (automated)        | —                                                                                       |
| 88-permission-denied | `PASS` (automated)        | —                                                                                       |
| 88-least-privilege   | `PASS` (automated)        | —                                                                                       |

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

| ID    | Scenario                   | What automation proved                                                                                                                                                                                                  | What still needs a human                                                                                                                                 | Status                                                    |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 90-01 | service worker restart     | A real Chrome worker termination, nine times over: task state, settings, taint, audit sequence, skill security state, health record and route trust all survive, and route trust is restored _before_ routes are served | nothing                                                                                                                                                  | `PASS`                                                    |
| 90-02 | pending task recovery      | An interrupted task is **parked, not resumed** — the runtime cannot know what happened in the gap, so the user decides                                                                                                  | nothing                                                                                                                                                  | `PASS`                                                    |
| 90-03 | persistence degradation    | A degraded record blocks work until acknowledged; a degraded _audit_ domain deliberately does not                                                                                                                       | nothing                                                                                                                                                  | `PASS`                                                    |
| 90-04 | malformed persisted state  | Real garbage written into real `chrome.storage.local`, worker killed, revived worker interrogated: corrupt task index, unreadable task record, truncated health record, edited audit record                             | nothing                                                                                                                                                  | `PASS` (was `FAIL`)                                       |
| 90-05 | recovery-required state    | The five-state ladder is monotone and the in-memory floor survives a read failure                                                                                                                                       | nothing                                                                                                                                                  | `PASS`                                                    |
| 90-06 | no fail-open authorization | A worker termination never reduces a task's security state; UNKNOWN taint blocks                                                                                                                                        | nothing                                                                                                                                                  | `PASS`                                                    |
| 90-07 | side panel close           | A prompt open when the panel closes resolves as **denial**; a late answer changes nothing                                                                                                                               | nothing                                                                                                                                                  | `PASS`                                                    |
| 90-08 | **browser restart**        | nothing — Playwright cannot quit the browser it launched and reattach to the same profile                                                                                                                               | Quit Chrome fully, reopen, confirm the task is parked, settings survive, **and the connector needs re-authorization** (session storage does not survive) | `BLOCKED — HUMAN/ENVIRONMENT` (also needs a provider key) |
| 90-09 | **extension reload**       | nothing — Playwright cannot reload the extension out from under its own connection                                                                                                                                      | Reload at `chrome://extensions`, confirm the task is parked and that acting on a pre-existing tab reports the page must be reloaded                      | `BLOCKED — HUMAN/ENVIRONMENT` (also needs a provider key) |
| 90-10 | **network interruption**   | classification and retry: timeout, abort and unclassified transport failures all resolve to _unknown_; transient codes retry with backoff and stop at the attempt limit                                                 | Drop the interface mid-task; confirm it retries and continues when restored, and fails cleanly when left down past the limit                             | `BLOCKED — HUMAN/ENVIRONMENT` (also needs a provider key) |

Three rows need a person **and a provider key**. Each begins "start a task and
let it get several steps in", and there is no task to interrupt without a
configured provider — so `BLOCKED — HUMAN/ENVIRONMENT` is the reason
automation cannot do them, not the whole prerequisite. An earlier version of
this page said they needed no credential at all. That was wrong, and it would
have sent an owner to a dead end: loading the build, starting a task, and
finding the panel reports no provider.
90-08's connector re-authorization is the detail most likely to look like a
bug and is correct: connector tokens live in session storage precisely so they
do not survive a browser restart.

---

## §91 — Downloads (P-011)

Not a specification section. See [91-downloads.md](91-downloads.md) for why it
exists: the recorded blocker for downloads named the wrong mechanism and the
wrong scope, and correcting it left exactly one step that needs a person.

| ID     | Capability                                  | Prerequisite         | Exact action required                                                       | Automated coverage                                                                                      | Manual status                 | Evidence                                 | Owner action            |
| ------ | ------------------------------------------- | -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------- | ----------------------- |
| 91-D-1 | Refusal while the permission is absent      | none                 | —                                                                           | `PASS` — the shipped bundle refuses and writes nothing                                                  | n/a                           | `file-transfer.spec.ts`                  | none                    |
| 91-D-2 | The granted download path, end to end       | none                 | —                                                                           | `PASS` — 7 cases against `dist-downloads/`: R3 gate, filename gate, real bytes on disk, audit, eviction | n/a                           | `download-granted.spec.ts`               | none                    |
| 91-D-3 | Granting the permission from the side panel | a person at a screen | Press the Settings button, answer Chrome's dialog, download, then revoke it | neither side of the dialog is the dialog                                                                | `BLOCKED — HUMAN/ENVIRONMENT` | [91-downloads.md](91-downloads.md) D-3-1 | execute procedure D-3-1 |

**91-D-3 is blocked by a dialog, not by a gesture.** A Playwright click does
supply a real user activation, and Chrome does accept the
`chrome.permissions.request` made from it. What cannot be answered is the
confirmation Chrome then raises, which is browser chrome with no frame, no
exposed accessibility tree and no CDP domain behind it. Granting the
permission any other way — mutating extension permission state directly, or
replacing the API — would remove the only thing the item is about, so it is
left blocked rather than made to look covered.
