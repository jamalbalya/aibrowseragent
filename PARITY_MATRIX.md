# Capability parity matrix

Tracks each mandatory capability (P-001 … P-040) from the specification
against what this repository actually contains.

**This project does not claim baseline capability parity.** Most capabilities
are not implemented. This document exists so the gap is visible rather than
implied.

## Parity is not the same measure as a stage

This file measures one thing: progress toward full capability parity across
P-001…P-040. It is deliberately unforgiving, and it will read as "a long way
from done" for as long as that is true.

It is **not** a measure of whether a delivery stage is complete. A stage has
its own defined scope, and a capability outside that scope does not hold the
stage open. The two are reported separately, and the expected state for some
time is:

| Measure                   | Status                                                           |
| ------------------------- | ---------------------------------------------------------------- |
| Stage 2 scope             | see `docs/stage-2-status.md`                                     |
| Overall capability parity | **PARTIAL** — the table below, and it is the only thing it means |

Reading a PARTIAL or NOT-STARTED row here as a stage blocker is a mistake that
has already been made once in this repository's history. A row's status
answers "is this capability finished and proven?", never "does this block the
current stage?". The second question is answered against the stage's scope,
not against this file.

## How to read a status

The authoritative specification is committed at
[`docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`](docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md).
Every section reference below points into it.

Specification §84 sets **six** conditions for PASS:

1. implementation exists;
2. automated test exists where technically possible;
3. **manual acceptance test exists;**
4. failure path is tested;
5. security path is tested;
6. evidence is recorded.

### What the PASS column in this file actually means

It means conditions 1, 2, 4, 5 and 6 — **automated** evidence. Condition 3 is
**not met by any row**, because the manual acceptance tests are the §85 A–F
scenarios and none has been executed or recorded. Those scenarios span
connectors and three providers, so they belong to Phase 10 (parity
certification) in §96, not to the automated suites.

An earlier revision of this file listed five conditions and omitted the manual
acceptance test entirely, which quietly lowered the bar it was measuring
against. The wording is corrected here rather than the column being relabelled,
because the column is genuinely useful — it just does not, on its own, satisfy
§84. **No row in this file should be read as §84 PASS**, and the project
cannot claim parity under §99 until the §85–§89 acceptance tests are run and
recorded.

The `Status` column below records **automated-evidence status**. It is not, and
must not be read as, **full parity certification** under §84 — that requires the
manual acceptance tests and is Phase 10 work.

| Status            | Meaning (automated-evidence status)                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `PASS`            | §84 conditions 1, 2, 4, 5 and 6 met. Condition 3, the manual acceptance test, is unmet repository-wide |
| `PARTIAL`         | Implemented and tested, but some condition is unmet — the gap is stated                                |
| `INTERFACES-ONLY` | Interfaces exist; no working implementation. Calls raise `NOT_IMPLEMENTED`                             |
| `NOT-STARTED`     | Nothing exists                                                                                         |
| `BLOCKED`         | Cannot proceed until something external changes; the blocker is named                                  |
| `DEFERRED`        | Deliberately postponed to a later phase, with the reason recorded                                      |

"Automated" counts unit, integration and end-to-end tests. The E2E column means
the capability was exercised against the built extension running in a real
Chromium — not simulated.

### Every claim in this table is checked

The yes/— columns are **not** assertions. Each one is derived from
`parity-evidence.json`, which names the test files backing it, and
`scripts/check-parity.mjs` fails the build when a column claims coverage that
is not cited, when a cited file does not exist or sits in the wrong category,
or when the matrix under-reports coverage that does exist.

This exists because a previous revision claimed integration coverage for three
capabilities (P-001, P-035, P-040) that had no integration test at all, and
simultaneously under-reported two (P-008, P-039) that did. The arithmetic was
self-consistent throughout, so a self-consistency check could never have caught
it. A security citation names the test exercising the control that guards the
capability, not necessarily a test of the capability itself.

---

## Summary

| Status          | Count  |
| --------------- | ------ |
| PASS            | 30     |
| PARTIAL         | 4      |
| INTERFACES-ONLY | 0      |
| NOT-STARTED     | 6      |
| **Total**       | **40** |

These counts are checked against the table below, and the table against
`parity-evidence.json`, by `scripts/check-parity.mjs`, which CI runs. Two
separate classes of error have actually occurred here: a revision that claimed
17 PASS while its own table said 23, and a revision whose per-column coverage
claims were not backed by any test. The check now covers both.

Movement in this revision: the connector framework (P-023) moves from
INTERFACES-ONLY to PARTIAL, taking PARTIAL from 3 to 4 and emptying the
INTERFACES-ONLY category. It is **not** PASS, for a reason stated below that
is external rather than architectural.

### Earlier movement, kept for the record

PASS went from 28 to 30 and PARTIAL from 2 to 3, and NOT-STARTED from 9 to 6,
on evidence rather than on reassessment of the same evidence. Image upload
(P-009) and file upload (P-010) moved from NOT-STARTED to PASS; download
(P-011) moved from NOT-STARTED to PARTIAL, for a reason stated below rather
than a missing test.

### Earlier movement, kept for the record

Notifications (P-019) was PARTIAL for one stated reason — `chrome.notifications`
was called inline in the service worker, so nothing could test it. It now sits
behind `NotificationPort`, the same seam pattern the debugger and messaging
surfaces use, with tests covering what a notification may contain, the setting
being read live, and a Chrome refusal not failing the approval underneath it.
Headless Chromium surfaces no notifications, so the seam is the evidence and
an end-to-end test is not possible.

Long-running task (P-017) was PARTIAL because the longest tested trajectory was
a handful of turns. What exists now is **deterministic multi-turn lifecycle and
recovery validation**: an 18-turn run asserting exact usage accounting, step
ordering with no duplicates, and budget termination for a model that never
finishes, alongside a real service-worker kill and restart. It is not a
wall-clock endurance or soak test and is not described as one — duration is
enforced against an injected clock, because a test that slept would be slower,
flakier and prove less. The capability name below is the specification's
(§83); the evidence is what this paragraph says it is.

### P-009 / P-010 File and image upload — what PASS means here

Upload is implemented as four separate operations rather than one, because
that is what it is: the user selects a file, the extension reads it, the
extension puts it into a page input, and the site transmits it. Selection is
user-mediated through the side panel's own file picker — there is no tool that
takes a path, and no filesystem access to give one meaning. Reading a file
taints the task with a `local_file` source that carries no site, so sending it
anywhere needs consent rather than a same-origin pass. Putting it into the
input is the egress, gated like every other transfer, because a page can read
`input.files` the moment they are set.

Image upload (P-009) is the same path with an `accept` that names image types;
there is no separate image mechanism and none was added.

Real Chromium covers what jsdom cannot: a file input the page has hidden still
gets a handle while a hidden button still does not, and the `DataTransfer`
assignment actually populates `input.files` so the page's own `change`
listener fires.

**Stated limitation.** The `change` event an extension dispatches has
`isTrusted: false`. A site that requires a trusted event will ignore it. That
cannot be worked around, so the assignment is verified and a failure is
reported rather than assumed away. File inputs inside cross-origin iframes are
also out of reach, because `all_frames` is `false` and widening it is not
justified by this feature.

### P-011 Download — why PARTIAL

**P-011 Download** — The implementation is complete and tested: filename validation (traversal,
absolute paths, separators, control characters, reserved device names,
executables and browser extensions all refused), `conflictAction: 'uniquify'`
so nothing is ever overwritten, full lifecycle handling, and an audit record
for each outcome.

PARTIAL for one reason, and it is not a missing test: `downloads` is an
**optional** permission that a person grants from Settings under their own
gesture, and a headless Chromium profile cannot produce that gesture. So the
end-to-end path that has actually run is the refusal — the tool declining
cleanly because the permission is absent — rather than a completed download
landing on disk. Everything up to and including the refusal is verified in a
real browser; the granted path is verified in unit and integration tests
against the download port.

### P-033 Provider switching — what PASS means here

Three adapters ship and all three pass one shared conformance suite; switching between them is
exercised in integration and, in real Chromium, against local servers speaking
the Anthropic, Gemini and Chat Completions protocols. Every ordered pair is
tested, and each switch is shown to carry nothing with it: the egress
consent pin binds a canonical provider destination and a model, so changing
either invalidates the authorization rather than inheriting it, and the
refusal is reported as blocked — never as a retryable network fault.
What has **not** happened is a request to a commercial provider: no
project-owned credentials are configured in this environment, so live provider
E2E is blocked externally. The row is PASS on the capability as specified —
switch provider, keep the agent body — and that limitation is stated here
rather than folded into the verdict.

---

## Matrix

| ID    | Capability                           | Impl       | Unit | Integration | Security | E2E | Status          |
| ----- | ------------------------------------ | ---------- | ---- | ----------- | -------- | --- | --------------- |
| P-001 | Side panel                           | yes        | —    | —           | —        | yes | PASS            |
| P-002 | Read page                            | yes        | yes  | yes         | yes      | yes | PASS            |
| P-003 | Click                                | yes        | yes  | yes         | yes      | yes | PASS            |
| P-004 | Type                                 | yes        | yes  | yes         | yes      | yes | PASS            |
| P-005 | Navigate                             | yes        | yes  | yes         | yes      | yes | PASS            |
| P-006 | Forms                                | yes        | yes  | yes         | yes      | yes | PARTIAL         |
| P-007 | Scroll                               | yes        | yes  | yes         | —        | yes | PASS            |
| P-008 | Screenshot                           | yes        | yes  | yes         | yes      | yes | PASS            |
| P-009 | Image upload                         | yes        | yes  | yes         | yes      | yes | PASS            |
| P-010 | File upload                          | yes        | yes  | yes         | yes      | yes | PASS            |
| P-011 | Download                             | yes        | yes  | yes         | yes      | yes | PARTIAL         |
| P-012 | Multi-tab                            | yes        | yes  | —           | yes      | yes | PASS            |
| P-013 | Tab grouping                         | yes        | yes  | —           | —        | yes | PASS            |
| P-014 | DOM inspection                       | yes        | yes  | —           | yes      | yes | PASS            |
| P-015 | Console inspection                   | yes        | yes  | —           | yes      | yes | PASS            |
| P-016 | Network inspection                   | yes        | yes  | —           | yes      | yes | PASS            |
| P-017 | Long-running task                    | yes        | —    | yes         | —        | yes | PASS            |
| P-018 | Background task while Chrome is open | yes        | —    | yes         | —        | yes | PASS            |
| P-019 | Notifications                        | yes        | yes  | —           | —        | —   | PASS            |
| P-020 | Scheduled tasks                      | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-021 | Shortcuts                            | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-022 | Workflow recording                   | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-023 | Connector framework                  | yes        | yes  | yes         | yes      | yes | PARTIAL         |
| P-024 | Skills                               | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-025 | Plugins                              | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-026 | MCP                                  | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-027 | Permission modes                     | yes        | yes  | yes         | yes      | yes | PASS            |
| P-028 | Site permissions                     | yes        | yes  | —           | yes      | yes | PASS            |
| P-029 | Permission history                   | yes        | yes  | —           | yes      | yes | PASS            |
| P-030 | Prompt injection defence             | yes        | yes  | yes         | yes      | yes | PASS            |
| P-031 | Session persistence                  | yes        | yes  | yes         | —        | yes | PASS            |
| P-032 | Task resume                          | yes        | yes  | yes         | —        | yes | PASS            |
| P-033 | Provider switching                   | yes        | yes  | yes         | yes      | yes | PASS            |
| P-034 | Tool calling                         | yes        | yes  | yes         | yes      | yes | PASS            |
| P-035 | Capability doctor                    | yes        | yes  | —           | —        | yes | PASS            |
| P-036 | Error recovery                       | yes        | yes  | yes         | —        | yes | PASS            |
| P-037 | Loop detection                       | yes        | yes  | yes         | —        | —   | PASS            |
| P-038 | Audit trail                          | yes        | yes  | —           | —        | yes | PARTIAL         |
| P-039 | Evidence model                       | yes        | yes  | yes         | yes      | yes | PASS            |
| P-040 | Provider/model capability detection  | yes        | yes  | —           | —        | yes | PASS            |

---

## Why each PARTIAL is partial

**P-006 Forms** — Text input, textarea, contenteditable, select-by-value,
select-by-label and form submission all work and are tested. Checkbox and radio
are reported in the page model but have no dedicated tool; the model must click
them, which works but is less direct. File inputs are handled — see P-010 —
through `files.select` and `browser.attach_file` rather than through a form
tool, because choosing a file and sending it are two separate decisions.

**P-038 Audit trail** — Permission decisions are recorded with task, tool,
site, risk, decision, reason and timestamp, capped at 500 entries, and an
end-to-end test reads that history back out of a real browser after a real
decision. PARTIAL for two specific reasons, both of which need code that does
not exist yet rather than a test: tool executions live in per-task step
records rather than one unified, queryable audit log spanning tasks, so
"what did the agent do on this site last week" cannot be answered; and there
is no export, so the trail cannot leave the extension. Building either is new
functionality and is out of Stage 2 closure scope.

**P-023 Connector framework** — The framework is implemented and one adapter
exists, for GitHub: OAuth (authorization code + PKCE, no client secret), a
token vault whose only exit is an `Authorization` header, a guarded transport
that shares the one egress gate rather than duplicating it, least-privilege
scopes with a stated rationale for each, duplicate-write protection, and four
tools in the same registry as every other tool. Covered by four unit suites,
an integration suite against a mock service, a security suite and a
real-Chromium E2E suite.

PARTIAL for one reason, and it is external rather than architectural: **this
project registers no OAuth application**, so no connector can actually be
connected in this build and no live authorization has ever been performed.
The extension says so and refuses to start a flow it cannot finish, rather
than faking one. Everything below that line is exercised against a local mock
authorization server and API over real HTTP.

PARTIAL also because one connector is not a connector ecosystem. The Jira,
Confluence, Figma and Google Sheets connectors named in the specification are
not implemented, and nothing returns a fake response for them.

---

## Platform limitations

Per specification §99, capabilities unavailable for platform reasons:

| Reference capability                 | This project  | Limitation                                      | Impact                                      | Workaround                                                                  | Accepted        |
| ------------------------------------ | ------------- | ----------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- | --------------- |
| Continue while the browser is closed | Not available | A Chrome extension cannot run without Chrome    | Tasks stop when Chrome closes               | Would require a cloud runtime (specification §94)                           | Yes, for v1     |
| Automate `chrome://` pages           | Refused       | Chrome forbids content scripts there            | Browser settings cannot be automated        | None; this is also a deliberate safety boundary                             | Yes             |
| Automate the extension gallery       | Refused       | Chrome forbids it                               | Extensions cannot be installed by the agent | None; also a privilege-escalation boundary                                  | Yes             |
| Encrypted credential storage         | Not available | `chrome.storage.local` is not encrypted at rest | A local attacker can read a stored API key  | Use a scoped key with a spend limit; a desktop bridge could use OS keychain | Yes, documented |

---

## Before claiming parity

Not claimable until every P-001…P-040 row reaches PASS, which requires at
minimum:

1. Playwright E2E coverage, so no row reads `E2E: no`.
2. The nine NOT-STARTED capability groups implemented and tested.
3. ~~At least three provider adapters passing the same suite, proving P-033
   rather than asserting it.~~ **Done.** Three adapters —
   `openai-compatible`, `anthropic`, `gemini` — pass one 21-case conformance
   suite, and switching between them runs in real Chromium against servers
   speaking each provider's real protocol. Live commercial endpoints remain
   unexercised (see P-033 below).
4. The acceptance tests from specification §85–89 executed and recorded.

Progress against this list belongs in this file, updated in the same commit as
the code that changes it.
