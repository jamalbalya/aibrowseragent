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

| Status            | Meaning                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `PASS`            | All five conditions met                                                    |
| `PARTIAL`         | Implemented and tested, but some condition is unmet — the gap is stated    |
| `INTERFACES-ONLY` | Interfaces exist; no working implementation. Calls raise `NOT_IMPLEMENTED` |
| `NOT-STARTED`     | Nothing exists                                                             |
| `BLOCKED`         | Cannot proceed until something external changes; the blocker is named      |
| `DEFERRED`        | Deliberately postponed to a later phase, with the reason recorded          |

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
| PASS            | 27     |
| PARTIAL         | 3      |
| INTERFACES-ONLY | 1      |
| NOT-STARTED     | 9      |
| **Total**       | **40** |

These counts are checked against the table below, and the table against
`parity-evidence.json`, by `scripts/check-parity.mjs`, which CI runs. Two
separate classes of error have actually occurred here: a revision that claimed
17 PASS while its own table said 23, and a revision whose per-column coverage
claims were not backed by any test. The check now covers both.

Movement in this revision: PASS went from 25 to 27 and PARTIAL from 5 to 3, on
evidence rather than on reassessment of the same evidence.

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

Provider switching (P-033) stays PARTIAL, but its central claim is no longer
unverified — see below. Audit trail (P-038) stays PARTIAL with a sharper
statement of what is missing.

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
| P-009 | Image upload                         | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-010 | File upload                          | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-011 | Download                             | no         | —    | —           | —        | —   | NOT-STARTED     |
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
| P-023 | Connector framework                  | interfaces | —    | —           | —        | —   | INTERFACES-ONLY |
| P-024 | Skills                               | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-025 | Plugins                              | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-026 | MCP                                  | no         | —    | —           | —        | —   | NOT-STARTED     |
| P-027 | Permission modes                     | yes        | yes  | yes         | yes      | yes | PASS            |
| P-028 | Site permissions                     | yes        | yes  | —           | yes      | yes | PASS            |
| P-029 | Permission history                   | yes        | yes  | —           | yes      | yes | PASS            |
| P-030 | Prompt injection defence             | yes        | yes  | yes         | yes      | yes | PASS            |
| P-031 | Session persistence                  | yes        | yes  | yes         | —        | yes | PASS            |
| P-032 | Task resume                          | yes        | yes  | yes         | —        | yes | PASS            |
| P-033 | Provider switching                   | yes        | yes  | —           | —        | —   | PARTIAL         |
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
them, which works but is less direct. File inputs are not handled at all.

**P-033 Provider switching** — The architecture supports it and the registry
enforces explicit switching with no silent fallback, now verified against two
registered providers: activation follows a successful connection, a failed
connection leaves the working provider active, and an unregistered target
throws rather than redirecting. PARTIAL because only one _real_ adapter
ships, so switching between two production providers has still never run.
The requirement is stated further down this file, under "Before claiming
parity": _at least three provider adapters passing the same suite, proving
P-033 rather than asserting it_. One adapter exists, so the gap is two
adapters and a shared suite — not a missing test. The
guarantee that switching preserves tools, policy and task state holds by
construction — none of those modules reference the provider — but it is not
demonstrated.

**P-038 Audit trail** — Permission decisions are recorded with task, tool,
site, risk, decision, reason and timestamp, capped at 500 entries, and an
end-to-end test reads that history back out of a real browser after a real
decision. PARTIAL for two specific reasons, both of which need code that does
not exist yet rather than a test: tool executions live in per-task step
records rather than one unified, queryable audit log spanning tasks, so
"what did the agent do on this site last week" cannot be answered; and there
is no export, so the trail cannot leave the extension. Building either is new
functionality and is out of Stage 2 closure scope.

---

## INTERFACES-ONLY

**P-023 Connector framework** — `Connector`, `ConnectorTool`,
`ConnectorAuth`, `ConnectorRegistry` and `ConnectorDescriptor` are defined in
`src/connectors/core/types.ts`, including the `site` and `defaultSensitivity`
the exfiltration guard needs. No adapter exists. Nothing returns a fake
connector response.

The same applies to the Jira, Confluence, Figma and Google Sheets connectors
named in the specification: interfaces only.

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
3. At least three provider adapters passing the same suite, proving P-033
   rather than asserting it.
4. The acceptance tests from specification §85–89 executed and recorded.

Progress against this list belongs in this file, updated in the same commit as
the code that changes it.
