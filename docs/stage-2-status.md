# Stage 2 status

Stage 2 is scoped work, not the whole product. This file records what that
scope required, what was proven, and what is blocked — separately from
`PARITY_MATRIX.md`, which tracks progress toward full capability parity and
means nothing else.

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

Neither is an implementation defect, and neither can be resolved from inside
the repository.

**The authoritative specification is not here.** Stage 2 includes validating
this repository against the specification kit. That document has never been
committed — see `docs/repository-state.md`. Every status in this repository is
therefore checked against a restatement of a requirement rather than against
the requirement. The owner holds the document.

**Live provider E2E has no credentials.** Stage 2 asks for it _when valid
credentials are configured_; none are. No borrowed, harness, invented or
other-project credentials were used, and the mock-provider suite is never
described as a live one.

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

## Repository administration

`main` is the canonical branch and carries the validated history, but the
GitHub default branch still points at an obsolete temporary branch. See
`docs/repository-state.md`. This is a repository-administration blocker, not a
product one, and the two are reported separately.
