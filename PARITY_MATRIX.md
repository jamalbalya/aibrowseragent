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

| Status        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `PASS`        | All five conditions met                                                    |
| `PARTIAL`     | Implemented and tested, but some condition is unmet — the gap is stated    |
| `FOUNDATION`  | Interfaces exist; no working implementation. Calls raise `NOT_IMPLEMENTED` |
| `NOT_STARTED` | Nothing exists                                                             |

"Automated" counts unit and integration tests. No end-to-end browser test suite
exists yet, so no row claims E2E.

---

## Summary

| Status      | Count  |
| ----------- | ------ |
| PASS        | 17     |
| PARTIAL     | 6      |
| FOUNDATION  | 5      |
| NOT_STARTED | 12     |
| **Total**   | **40** |

---

## Matrix

| ID    | Capability                           | Impl       | Unit | Integration | Security | E2E | Status      |
| ----- | ------------------------------------ | ---------- | ---- | ----------- | -------- | --- | ----------- |
| P-001 | Side panel                           | yes        | —    | —           | —        | no  | PARTIAL     |
| P-002 | Read page                            | yes        | yes  | yes         | yes      | no  | PASS        |
| P-003 | Click                                | yes        | yes  | yes         | yes      | no  | PASS        |
| P-004 | Type                                 | yes        | yes  | yes         | yes      | no  | PASS        |
| P-005 | Navigate                             | yes        | yes  | yes         | yes      | no  | PASS        |
| P-006 | Forms                                | yes        | yes  | yes         | yes      | no  | PARTIAL     |
| P-007 | Scroll                               | yes        | yes  | yes         | —        | no  | PASS        |
| P-008 | Screenshot                           | yes        | yes  | —           | yes      | no  | PASS        |
| P-009 | Image upload                         | no         | —    | —           | —        | —   | NOT_STARTED |
| P-010 | File upload                          | no         | —    | —           | —        | —   | NOT_STARTED |
| P-011 | Download                             | no         | —    | —           | —        | —   | NOT_STARTED |
| P-012 | Multi-tab                            | yes        | yes  | —           | yes      | no  | PASS        |
| P-013 | Tab grouping                         | yes        | yes  | —           | —        | no  | PASS        |
| P-014 | DOM inspection                       | yes        | yes  | —           | yes      | no  | PASS        |
| P-015 | Console inspection                   | yes        | yes  | —           | yes      | no  | PASS        |
| P-016 | Network inspection                   | yes        | yes  | —           | yes      | no  | PASS        |
| P-017 | Long-running task                    | yes        | —    | yes         | —        | no  | PARTIAL     |
| P-018 | Background task while Chrome is open | yes        | —    | yes         | —        | no  | PARTIAL     |
| P-019 | Notifications                        | yes        | no   | no          | —        | no  | PARTIAL     |
| P-020 | Scheduled tasks                      | no         | —    | —           | —        | —   | NOT_STARTED |
| P-021 | Shortcuts                            | no         | —    | —           | —        | —   | NOT_STARTED |
| P-022 | Workflow recording                   | no         | —    | —           | —        | —   | NOT_STARTED |
| P-023 | Connector framework                  | interfaces | —    | —           | —        | —   | FOUNDATION  |
| P-024 | Skills                               | no         | —    | —           | —        | —   | NOT_STARTED |
| P-025 | Plugins                              | no         | —    | —           | —        | —   | NOT_STARTED |
| P-026 | MCP                                  | no         | —    | —           | —        | —   | NOT_STARTED |
| P-027 | Permission modes                     | yes        | yes  | yes         | yes      | no  | PASS        |
| P-028 | Site permissions                     | yes        | yes  | —           | yes      | no  | PASS        |
| P-029 | Permission history                   | yes        | yes  | —           | —        | no  | PASS        |
| P-030 | Prompt injection defence             | yes        | yes  | yes         | yes      | no  | PASS        |
| P-031 | Session persistence                  | yes        | yes  | yes         | —        | no  | PASS        |
| P-032 | Task resume                          | yes        | yes  | yes         | —        | no  | PASS        |
| P-033 | Provider switching                   | yes        | yes  | —           | —        | no  | PARTIAL     |
| P-034 | Tool calling                         | yes        | yes  | yes         | yes      | no  | PASS        |
| P-035 | Capability doctor                    | yes        | yes  | —           | —        | no  | PASS        |
| P-036 | Error recovery                       | yes        | yes  | yes         | —        | no  | PASS        |
| P-037 | Loop detection                       | yes        | yes  | yes         | —        | no  | PASS        |
| P-038 | Audit trail                          | yes        | yes  | —           | —        | no  | PARTIAL     |
| P-039 | Evidence model                       | yes        | yes  | —           | yes      | no  | PASS        |
| P-040 | Provider/model capability detection  | yes        | yes  | —           | —        | no  | PASS        |

---

## Why each PARTIAL is partial

**P-001 Side panel** — Implemented and functional: header with live provider
and connection state, task view with per-step outcomes, permission prompts,
controls, settings, task history, and an evidence viewer that opens stored
screenshots and page snapshots. Marked PARTIAL because no automated test
renders it; its logic is covered through `useAgentState` and the message
handlers it calls, not through rendering.

**P-006 Forms** — Text input, textarea, contenteditable, select-by-value,
select-by-label and form submission all work and are tested. Checkbox and radio
are reported in the page model but have no dedicated tool; the model must click
them, which works but is less direct. File inputs are not handled at all.

**P-017 Long-running task** — The runtime runs unbounded turns within its
budget, and state persists. PARTIAL because the longest tested run is a handful
of turns; no sustained long-duration test exists.

**P-018 Background execution** — Tasks live in the service worker and survive
the side panel closing and the worker being evicted; `task-persistence.test.ts`
simulates eviction. PARTIAL because it has not been verified against a real
Chrome eviction, only a faithful simulation.

**P-019 Notifications** — Implemented for permission requests and gated on a
setting. PARTIAL because it has no test: `chrome.notifications` is called
directly in the service worker rather than behind an injectable seam, which is
a gap worth closing.

**P-033 Provider switching** — The architecture supports it and the registry
enforces explicit switching with no silent fallback. PARTIAL because only one
adapter exists, so switching _between_ providers has not been exercised. The
guarantee that switching preserves tools, policy and task state holds by
construction — none of those modules reference the provider — but it is not
demonstrated.

**P-038 Audit trail** — Permission decisions are recorded with task, tool,
site, risk, decision, reason and timestamp, capped at 500 entries. PARTIAL
because tool executions are recorded in task steps rather than in a single
unified audit log, and there is no export.

---

## FOUNDATION

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
2. The nine NOT_STARTED capability groups implemented and tested.
3. At least three provider adapters passing the same suite, proving P-033
   rather than asserting it.
4. The acceptance tests from specification §85–89 executed and recorded.

Progress against this list belongs in this file, updated in the same commit as
the code that changes it.
