# Capability parity matrix

Tracks each mandatory capability (P-001 … P-040) from the specification
against what this repository actually contains.

**This project does not claim baseline capability parity.** Most capabilities
are not implemented. This document exists so the gap is visible rather than
implied.

## How to read a status

A capability is **PASS** only when all of these hold (specification §84):

1. an implementation exists;
2. an automated test exists where technically possible;
3. the failure path is tested;
4. the security path is tested;
5. evidence is recorded where applicable.

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
a handful of turns. An 18-turn run now asserts exact usage accounting, step
ordering with no duplicates, and that a model which never finishes is stopped
by the budget. Duration itself stays on an injected clock; a test that slept
would be slower, flakier and prove less.

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
| P-017 | Long-running task                    | yes        | —    | yes         | —        | —   | PASS            |
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
Shipping a second adapter is out of Stage 2 scope. The
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
