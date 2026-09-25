# Phase C — negative-control record

The Classic plan is an authorization, so the tests that matter are the ones
asserting what it cannot do. Every such test below was run against a build with
the protection deliberately removed, the result was recorded, and the source was
restored. Controls that did **not** discriminate are recorded here too, with
what was changed to make them real — hiding one would defeat the purpose of the
file.

Run on 2026-09-24 against `src/` as it stands in the Phase C commit.
Target suite unless stated otherwise:
`tests/security/classic-plan-authorization.test.ts` (37 cases).

## Mutants that discriminated

| #    | Protection removed                                                               | Result                                                                     |
| ---- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| NC-1 | The plan stage hoisted to the top of `evaluatePolicy`, ahead of every deny stage | **6 failed** / 31 passed — cases 08, 11, 12, 13, 14, 16 — discriminates    |
| NC-2 | `planCoversSite(...)` replaced with `true`                                       | **3 failed** / 34 passed — cases 16, 21, 24 — discriminates                |
| NC-3 | `context.unattended !== true` dropped from the plan clause                       | **1 failed** / 36 passed — case 15 — discriminates _(after the fix below)_ |
| NC-4 | The R3 floor (`ALWAYS_CONFIRM_AT`) never fires                                   | **3 failed** / 34 passed — cases 10, 20, 25 — discriminates                |
| NC-5 | The R5 deny stage (`ALWAYS_DENY_AT`) never fires                                 | **1 failed** / 36 passed — case 09 — discriminates                         |
| NC-6 | Both the scope guard **and** the parse treat an absent scope as covered          | **1 failed** / 36 passed — case 23 — discriminates                         |

## The three that did not discriminate first time

### NC-3 — the unattended condition

Case 15 originally ran at **R2**, and passed with the condition removed. The
reason is that the unattended stage above the plan already returns a
confirmation for R2 and up, so the case was proving that stage and nothing
about this one.

The condition is live only at R0–R1, where nothing above it fires. The case was
rewritten to run at R1 and to assert that the decision is _not_ `PLAN_ALLOWED`,
with the R2 case kept alongside it so both boundaries stay covered. NC-3 then
failed as required.

The condition was **not** removed.

### The plan's own risk ceiling — `PLAN_MAX_RISK`

Removing `RISK_RANK[effectiveRisk] <= RISK_RANK[PLAN_MAX_RISK]` from the plan
clause changed **no** answer, and the suite stayed green. That is not a test
defect to patch around: the ceiling genuinely cannot bind today, because the R3
floor returns before the plan is ever consulted, so every request that reaches
the clause is already at R2 or below.

Rather than claim a control that does not exist, case 20 now states this
plainly and asserts the property that makes the redundancy safe: the two
constants are **adjacent** — `RISK_RANK[ALWAYS_CONFIRM_AT]` is exactly
`RISK_RANK[PLAN_MAX_RISK] + 1` — so no risk level can sit between the highest a
plan covers and the lowest that always confirms. If somebody raised the floor
without raising the ceiling, the ceiling would start to bind and the case would
say so.

The ceiling was **not** removed. It is defence in depth against exactly that
change; what would have been wrong is a test claiming it is what stops an R3
action today.

### The absent-scope guard

Removing `request.siteScope !== undefined` alone also changed no answer,
because `planCoversSite` refuses an unparseable URL on its own — and the
one-line removal does not even typecheck, so it is not a mutant the build could
carry. NC-6 above removes **both** halves, and case 23 then fails. The case
tests the property rather than either line, which is the intent.

## Real-Chromium controls

`tests/e2e/classic-plan.spec.ts` carries its discriminating halves inside the
suite rather than as mutants, because each is a full browser run:

| Case | Claim                                      | Its control                                              |
| ---- | ------------------------------------------ | -------------------------------------------------------- |
| 04   | a click inside the plan does not ask       | 05 — the same click, a site the plan does not name, asks |
| 06   | "allow for this task" writes no `SiteRule` | 07 — "always allow" writes one                           |
| 09   | a credential field is refused under a plan | 10 — an ordinary field on the same page is written       |
| 01   | a Classic task stops at its proposal       | 02 — a Cowork task never plans                           |

Case 09 asserts the step status is **`denied`** specifically rather than merely
"not success": a write that failed because the element could not be found would
be `error`, and would pass a looser assertion while proving nothing about the
refusal.

## Re-run at the Phase C closure audit

Every mutant above was run again against the tree as it stands after the closure
audit's remediation. Results unchanged: NC-1 through NC-6 discriminate, and the
`PLAN_MAX_RISK` ceiling is still redundant for the reason recorded above — the
R3 floor returns before the plan clause is reached, so removing the ceiling
changes no answer. It is kept, and case 20 asserts the adjacency that makes the
redundancy safe rather than claiming the line is what enforces the bound.

The closure audit added four mutants of its own, against
`tests/security/authorization-site-record.test.ts` (15 cases):

| #     | Protection removed                                             | Result                                                  |
| ----- | -------------------------------------------------------------- | ------------------------------------------------------- |
| NC-7  | The permission history derives its site from `targetUrl` alone | **4 failed** — cases 01, 04, 07, 12 — discriminates     |
| NC-8  | The dispatch observation carries no site                       | **5 failed** — cases 02, 03, 04, 12, 13 — discriminates |
| NC-9  | `browser.download` names no destination                        | **3 failed** — cases 08, 09, 10 — discriminates         |
| NC-10 | The standing-grant offer is not gated on grantable risk        | **1 failed** — case 14 — discriminates                  |

NC-7 and NC-9 are the two defects the closure audit found; each mutant is the
code as it stood in `88e9b81`, so the failures above are the defects reproducing.

### What NC-10 does and does not prove

Case 14 reads the component's source instead of rendering it, because this
repository has no React test harness and adding one is not a closure-audit
change. It catches the guard being deleted. It does not prove what a rendered
panel shows, and it is labelled that way in the test.

## How to re-run

Each unit mutant is a one-line edit to `src/policy/policy-engine.ts`. The driver
used copies the file, applies one `str.replace`, runs the one target suite and
restores the file unconditionally, so a crashed run cannot leave a weakened
source behind. Re-run `npx tsc --noEmit` afterwards: two of the mutants above do
not typecheck, which is itself part of the record.
