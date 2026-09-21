# Stage 2 status

Stage 2 is scoped work, not the whole product. This file records what that
scope required, what was proven, and what is blocked — separately from
`PARITY_MATRIX.md`, which tracks progress toward full capability parity and
means nothing else.

## How Stage 2 relates to the specification

The authoritative specification is committed at
[`docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`](spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md).
It is the document of record and is stored verbatim; it is excluded from
formatting so it cannot drift.

The specification contains no "Stage 2". It defines Phases 0–10 in §96, and
"Stage 2" is the owner's delivery construct laid over them. They line up:

| Specification phase (§96)       | In Stage 2?                                 |
| ------------------------------- | ------------------------------------------- |
| Phase 1 — Chrome shell          | Yes                                         |
| Phase 2 — Agent runtime         | Yes                                         |
| Phase 3 — Deep browser          | Yes                                         |
| Phase 4 — Security              | Yes                                         |
| Phase 5 — Providers             | Partly — the OpenAI-compatible adapter only |
| Phase 6 — Connectors            | No                                          |
| Phase 7 — Skills                | No                                          |
| Phase 8 — Workflow, scheduler   | No                                          |
| Phase 9 — MCP, plugins          | No                                          |
| Phase 10 — Parity certification | No                                          |

This is why the open parity rows do not block Stage 2: P-023 is Phase 6,
P-024 Phase 7, P-020/021/022 Phase 8, P-025/026 Phase 9, and the §85–§89
acceptance tests are Phase 10. Every one of them is mandatory for parity under
§83 and §99, and every one of them sits after the phases Stage 2 covers.

The distinction matters because it has already caused one wrong conclusion
here: an audit read "overall parity is PARTIAL" and reported Stage 2 as
PARTIAL on that basis alone. A capability outside Stage 2's scope does not
hold Stage 2 open.

## Status

| Measure                   | Status                                      |
| ------------------------- | ------------------------------------------- |
| Stage 2 scope             | **PASS**, with two external blockers below  |
| Overall capability parity | **PARTIAL** — 27 PASS of 40; see the matrix |
| Repository administration | **BLOCKED** — awaiting the owner            |

Stage 2 may be declared complete when every required scope item is PASS or
explicitly blocked by an external dependency that cannot be resolved inside
the repository. Nothing stubbed, mocked, interface-only, partially
implemented or unverified is counted as PASS.

## What Stage 2 required, and the evidence

Real-browser foundation, all exercised against the built extension running in
a real Chromium rather than simulated:

| Scope area                                        | Evidence                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unpacked MV3 extension loads; service worker runs | `extension-load.spec.ts`, including an anti-vacuity guard                                           |
| Content script, side panel, three-way messaging   | `extension-load.spec.ts`, `file-access.spec.ts`, `messaging.test.ts`                                |
| DOM interaction, navigation, tabs, multi-tab      | `agent-task.spec.ts`, `extension-load.spec.ts`                                                      |
| Task lifecycle, cancellation, persistence         | `agent-task.spec.ts`, `task-persistence.test.ts`, `sustained-task.test.ts`                          |
| Service-worker eviction and restart resilience    | `mv3-lifecycle.spec.ts` — a real worker kill, not a simulation                                      |
| Evidence generation and persistence               | `evidence-pipeline.test.ts`, `agent-task.spec.ts`                                                   |
| Browser failure and recovery                      | `mv3-lifecycle.spec.ts`, `agent-runtime.test.ts`                                                    |
| Provider abstraction; OpenAI-compatible adapter   | `provider-registry.test.ts`, `openai-compatible.test.ts`                                            |
| Provider-independent E2E without live credentials | `provider-integration.spec.ts` (mock provider, real HTTP)                                           |
| Prompt injection, exfiltration, origin safety     | `prompt-injection.test.ts`, `exfiltration.test.ts`, `origin-validation.test.ts`, `security.spec.ts` |
| Permission-policy bypass, tool-schema security    | `security.spec.ts`, `tool-registry.test.ts`, `policy-engine.test.ts`                                |
| Debugger allowlist, secret redaction              | `debugger-allowlist.test.ts`, `secret-redaction.test.ts`, `screenshot-capture.test.ts`              |
| Cross-task isolation                              | `evidence-store.test.ts`, `tab-tools.test.ts`, `storage.test.ts`                                    |
| Regression coverage for defects found in testing  | the defect table in `docs/testing.md`                                                               |

## Blocked by external dependencies

One remains. Neither of the two reported in earlier audits is an
implementation defect.

**Live provider E2E was not executed because no project-owned provider
credentials were configured.** Stage 2 asks for it _when valid credentials are
configured_. This is an environment condition, not an implementation defect:
the provider abstraction and the OpenAI-compatible adapter are implemented and
validated, and the mock-provider suite exercises real HTTP — it is simply never
described as a live one. No borrowed, harness, invented, personal or
other-project credentials were used. Unblocking it needs the owner to configure
project-owned provider credentials.

**Resolved since the last audit: the authoritative specification.** It is now
committed verbatim at `docs/spec/` and is no longer a blocker. Validating
against it immediately found a real defect in this repository's own
documentation — `PARITY_MATRIX.md` had been stating five PASS conditions where
§84 sets six — which is the clearest argument that keeping the document out of
the repository was itself the problem.

## Explicitly outside Stage 2

These remain open in the parity matrix and do **not** block Stage 2: complete
connector, MCP, skills and plugin ecosystems (P-023 to P-026); scheduling,
shortcuts and workflow recording (P-020 to P-022); upload and download
(P-009 to P-011); every possible provider and model.

Two capabilities are PARTIAL for parity while being satisfied for Stage 2's
purposes:

- **P-033 provider switching.** Parity wants three adapters proving it. Stage 2
  wants provider abstraction and the OpenAI-compatible adapter validated, which
  they are. Not a Stage 2 blocker.
- **P-038 audit trail.** Parity wants a unified cross-task log and an export.
  Stage 2 wants evidence generation, persistence and truthful documentation,
  which exist. Not a Stage 2 blocker.

Isolated React component tests are not a Stage 2 requirement; the side panel is
validated through real-browser E2E.

Notifications are a **supporting** item, not an independent Stage 2 exit
criterion. The specification does not make them one. The seam and its tests
exist and are described accurately in `docs/testing.md`; they were not expanded
into a subsystem.

**Terminology.** Nothing here has been soak-tested or run for hours. What
exists is deterministic multi-turn lifecycle and recovery validation: an
18-turn trajectory with exact usage accounting and step ordering, plus a real
service-worker kill and restart. Calling that "long-running endurance" would
overstate it, so this file does not.

## What "parity PARTIAL" now means precisely

Specification §84 requires six things for a capability to be PASS, and one of
them is a manual acceptance test. None has been run — the §85 A–F scenarios
need connectors and three providers, which are Phases 6 and 5, and the
acceptance run is Phase 10. So no row in `PARITY_MATRIX.md` satisfies §84 on
its own, and the project cannot claim parity under §99. The matrix's PASS
column means _automated_ evidence, and it now says so.

This does not change Stage 2, whose scope stops well before Phase 10.

## Repository administration

Complete. The owner has set the GitHub default branch to `main` and deleted the
obsolete temporary branch; `main` is now the only branch. Verified against the
GitHub API rather than assumed. See `docs/repository-state.md`.
