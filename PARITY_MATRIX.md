# Capability parity matrix

Tracks each mandatory capability (P-001 … P-040) from the specification
against what this repository actually contains.

**This project does not claim baseline capability parity.** This document
exists so the gap is visible rather than implied.

An earlier revision of this paragraph said "most capabilities are not
implemented", which was true when it was written and is not now: thirty rows
carry full automated evidence. What has not changed is the thing the sentence
was guarding — §84 condition 3 is unmet repository-wide, so no row here is
§84 PASS and the project still claims no parity.

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
| PARTIAL         | 8      |
| INTERFACES-ONLY | 0      |
| NOT-STARTED     | 2      |
| **Total**       | **40** |

These counts are checked against the table below, and the table against
`parity-evidence.json`, by `scripts/check-parity.mjs`, which CI runs. Two
separate classes of error have actually occurred here: a revision that claimed
17 PASS while its own table said 23, and a revision whose per-column coverage
claims were not backed by any test. The check now covers both.

Movement in this revision: scheduled tasks (P-020) move from NOT-STARTED to
PARTIAL, taking PARTIAL from 7 to 8 and NOT-STARTED from 3 to 2. It is **not**
PASS, and the reason is below rather than a missing test.

### Earlier movement, kept for the record

The audit trail (P-038) gained integration and security coverage and closed
both of the gaps its entry named — there is now one unified cross-task log,
and an export. The counts did not move: P-038 was already PARTIAL and stayed
PARTIAL, because §84 condition 3 is unmet repository-wide. An implementation
existing is not parity.

### Earlier movement, kept for the record

Shortcuts (P-021) moved from NOT-STARTED to PARTIAL, taking PARTIAL from 6 to
7 and NOT-STARTED from 4 to 3.

### Earlier movement, kept for the record

Workflow recording (P-022) moved from NOT-STARTED to PARTIAL, taking PARTIAL
from 5 to 6 and NOT-STARTED from 5 to 4.

### Earlier movement, kept for the record

Skills (P-024) moved from NOT-STARTED to PARTIAL, taking PARTIAL from 4 to 5
and NOT-STARTED from 6 to 5. **Not** PASS, for a reason stated below.

### Earlier movement, kept for the record

The connector framework (P-023) moved from INTERFACES-ONLY to PARTIAL, taking
PARTIAL from 3 to 4 and emptying the INTERFACES-ONLY category. It is **not**
PASS, for a reason stated below that is external rather than architectural.

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

| ID    | Capability                           | Impl | Unit | Integration | Security | E2E | Status      |
| ----- | ------------------------------------ | ---- | ---- | ----------- | -------- | --- | ----------- |
| P-001 | Side panel                           | yes  | —    | —           | —        | yes | PASS        |
| P-002 | Read page                            | yes  | yes  | yes         | yes      | yes | PASS        |
| P-003 | Click                                | yes  | yes  | yes         | yes      | yes | PASS        |
| P-004 | Type                                 | yes  | yes  | yes         | yes      | yes | PASS        |
| P-005 | Navigate                             | yes  | yes  | yes         | yes      | yes | PASS        |
| P-006 | Forms                                | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-007 | Scroll                               | yes  | yes  | yes         | —        | yes | PASS        |
| P-008 | Screenshot                           | yes  | yes  | yes         | yes      | yes | PASS        |
| P-009 | Image upload                         | yes  | yes  | yes         | yes      | yes | PASS        |
| P-010 | File upload                          | yes  | yes  | yes         | yes      | yes | PASS        |
| P-011 | Download                             | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-012 | Multi-tab                            | yes  | yes  | —           | yes      | yes | PASS        |
| P-013 | Tab grouping                         | yes  | yes  | —           | —        | yes | PASS        |
| P-014 | DOM inspection                       | yes  | yes  | —           | yes      | yes | PASS        |
| P-015 | Console inspection                   | yes  | yes  | —           | yes      | yes | PASS        |
| P-016 | Network inspection                   | yes  | yes  | —           | yes      | yes | PASS        |
| P-017 | Long-running task                    | yes  | —    | yes         | —        | yes | PASS        |
| P-018 | Background task while Chrome is open | yes  | —    | yes         | —        | yes | PASS        |
| P-019 | Notifications                        | yes  | yes  | —           | —        | —   | PASS        |
| P-020 | Scheduled tasks                      | yes  | —    | —           | yes      | yes | PARTIAL     |
| P-021 | Shortcuts                            | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-022 | Workflow recording                   | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-023 | Connector framework                  | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-024 | Skills                               | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-025 | Plugins                              | no   | —    | —           | —        | —   | NOT-STARTED |
| P-026 | MCP                                  | no   | —    | —           | —        | —   | NOT-STARTED |
| P-027 | Permission modes                     | yes  | yes  | yes         | yes      | yes | PASS        |
| P-028 | Site permissions                     | yes  | yes  | —           | yes      | yes | PASS        |
| P-029 | Permission history                   | yes  | yes  | —           | yes      | yes | PASS        |
| P-030 | Prompt injection defence             | yes  | yes  | yes         | yes      | yes | PASS        |
| P-031 | Session persistence                  | yes  | yes  | yes         | —        | yes | PASS        |
| P-032 | Task resume                          | yes  | yes  | yes         | —        | yes | PASS        |
| P-033 | Provider switching                   | yes  | yes  | yes         | yes      | yes | PASS        |
| P-034 | Tool calling                         | yes  | yes  | yes         | yes      | yes | PASS        |
| P-035 | Capability doctor                    | yes  | yes  | —           | —        | yes | PASS        |
| P-036 | Error recovery                       | yes  | yes  | yes         | —        | yes | PASS        |
| P-037 | Loop detection                       | yes  | yes  | yes         | —        | —   | PASS        |
| P-038 | Audit trail                          | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-039 | Evidence model                       | yes  | yes  | yes         | yes      | yes | PASS        |
| P-040 | Provider/model capability detection  | yes  | yes  | —           | —        | yes | PASS        |

---

## Why each PARTIAL is partial

**P-006 Forms** — Text input, textarea, contenteditable, select-by-value,
select-by-label, form submission and checkbox/radio all work and are tested.
`browser.set_checked` covers checkbox and radio directly, with radio buttons
settable but not clearable — a group is changed by selecting a different
option, which is what the control actually does. File inputs are handled — see
P-010 — through `files.select` and `browser.attach_file` rather than through a
form tool, because choosing a file and sending it are two separate decisions.

An earlier revision of this entry said checkbox and radio had no dedicated
tool and had to be clicked. That was written before `browser.set_checked`
shipped and was never updated; it is corrected here rather than left to
mislead a reader deciding what is left to build.

Date, time, datetime-local, month, week, colour, range and number now have a
dedicated tool, `browser.set_value`, and a multi-select has
`browser.select_many`. They are separate from `browser.type` because these
controls are not typed into: a date field has segments and typing lands in
whichever one has focus, and a range has none at all. The page model reports
each control's `inputType` and the bounds it declares, so the choice between
the tools is read rather than guessed, and a multi-select reports its whole
selection rather than only its first option.

A value is checked against the format its type accepts and against the bounds
the page declared, then assigned, then read back — because a browser's way of
rejecting a value it cannot parse is to clear the field silently, and `2026-02-30`
is well-formed and is not a date. A rejected value is restored rather than left
cleared. Bounds are enforced rather than clamped: moving a date into the allowed
window would submit something nobody chose.

Field sensitivity now reaches the policy engine (Gate 1). A write into a
password or one-time-code field is refused outright in every permission mode; a
card, CVV or bank-detail field produces the `payment_instrument_entry`
prohibition, as does a Luhn-valid card number typed into a field the page
described as ordinary; a national-ID or API-secret field raises the action to
R3, which always confirms and can never be covered by a standing site grant. A
field the worker knows nothing about — an evicted service worker, a stale
handle — is R2 rather than R1, so uncertainty costs a confirmation instead of
running silently. A positively classified ordinary field keeps its R1 baseline,
so the usual case is unchanged.

The classification happens in the worker, from raw attributes the content
script reports without drawing any conclusion, and the write is re-checked
against the live element immediately before it lands — which is the only way to
catch a page that changes a field after it was read. See `docs/security.md`.

PARTIAL still, and for three narrow reasons. The §85 A–F manual acceptance
scenarios are unexecuted, as for every row in this file. Two controls remain
without a dedicated tool: `<input type="file">` is handled through the separate
user-mediated path (see P-010) rather than as a form control, and a
`<datalist>`-backed combobox is typed into like the text input it is, which
works but is not a distinct capability. And field sensitivity is not detectable
inside a shadow root or a cross-origin iframe — neither is walked by the page
model, and neither is reachable by the agent either, so the limit bounds what
the agent can do as well as what it can see.

**P-038 Audit trail** — One append-only stream across every task, recording
what was proposed and what was decided. Tool executions now reach it through
the single observation hook on `ToolRegistry.dispatch`, alongside task
lifecycle, permission, egress, connector, file, skill, workflow and shortcut
events — nine event types were declared from the start and never written,
which is why the trail could say what was _decided_ but not what was _done_.

The trail observes and never authorises: nothing reads it to decide anything,
and a write that fails is a gap in the record of an execution that already
happened rather than a failed execution. Records are flat and bounded, hold
identifiers, closed vocabularies, flags and references only, and are refused
rather than trimmed when they exceed a limit. A persisted sequence and a
digest chain give corruption and reordering detection — explicitly not tamper
protection, since anyone who can rewrite extension storage can rewrite the
chain with it. Eviction writes a marker in the same transaction that removes
the records. Export is local only, needs no permission and has no network
carrier, and its scope is required rather than inferred: an omitted or
unrecognised scope is refused before any document is built, because one task
and every task are different things to be handed. The audit routes, like
every other panel route, are reachable only from the side panel — checked at
the receiver rather than inferred from the absence of another caller.

Covered by a unit suite, an integration suite, a thirty-four-case security
suite and an eight-test real-Chromium suite, with sixteen mutations proved to
fail; the export scope contract and the route boundary add a forty-one-case
security suite and a fourteen-test real-Chromium suite of their own.

Both reasons this row was PARTIAL are now closed. It **stays PARTIAL**, for
the reason every row in this file does: §84 condition 3, the manual
acceptance test, is unmet repository-wide. An implementation existing is not
parity certification. Two smaller limits are also worth stating: deletion is
deliberately not exposed, so a user cannot yet clear their own history from
the panel, and the read surface scans the retained trail rather than a
secondary index — bounded, but it would not stay so if the cap were raised
much further.

**P-024 Skills** — The skill system is implemented: a structured definition
with no scripting engine, a validator that refuses anything that would
describe a privilege into being, a trusted registry that takes only
definitions shipped in the build, a step runner where every step dispatches
through the one `ToolRegistry` so policy, permission, egress and evidence
apply per step, composition with pinned versions and a depth limit, a
definition hash for audit, and run persistence that deliberately stores no
step data. Covered by two unit suites, an integration suite, a security suite
covering the wave's twenty threat cases, and a real-Chromium E2E suite that
measures the per-step approval property rather than asserting it.

Skills can now be **switched off**, which is the half of the benchmark's
enabled-by-default behaviour that was missing. The switch is the user's, it is
durable, and it survives a worker eviction. What makes it a control rather
than a filter is where it is enforced: `SkillRegistry.get`, `latest` and
`list` all answer as though a disabled skill were not registered, so it is
gone from the model's listing, from `skills.run`, from the panel's launcher
and from a shortcut resolving its target at once — a build that filtered only
the listing would leave a model able to run a skill it was never shown. The
settings surface has its own read that does include disabled skills, because
offering to turn one back on requires showing it, and the number of callers of
that read is asserted from source. Nothing here installs, obtains or changes a
skill: the only decision is whether one the build already shipped, validated
and hashed is available.

PARTIAL for two reasons, both about reach rather than architecture. Three
workflows ship and all three are read-only: a write workflow is a reasonable
thing to want and a bad thing to make the easiest path through a brand-new
feature, so writes stay individually requested for now. And specification §44
names a reference QA workflow spanning Jira, Confluence, Figma and Google
Sheets as "the primary reference integration workflow for validating the
multi-tool architecture" — none of those connectors exists (see P-023), so
that workflow cannot be built and the multi-connector case is untested against
anything real.

Installing a skill stays **deferred**, and deliberately: an install surface is
a trust decision about code that did not ship in the build, which is the
plugin trust model (P-025) and is not being invented here. The lifecycle
implemented is the part that needs no such decision.

Nothing here is blocked externally. Both reasons resolve by building more, not
by obtaining anything.

**P-020 Scheduled tasks** — Schedules are implemented: create, edit, pause,
resume, delete and Run now; daily, weekly, monthly and annual cadences;
shortcut, workflow and skill targets; persisted state that survives a service
worker eviction; a deterministic execution identity so a duplicate alarm
cannot run an occurrence twice; missed-run recording; run history;
cancellation; four notifications; and eleven audit event types. Execution goes
through the existing replay and launch routes and the existing task lifecycle
— there is no second task engine, no scheduled dispatch, and no policy
evaluation inside the scheduler.

Two columns show "—" rather than "yes" and are accurate: there is no
`tests/unit/` or `tests/integration/` file for scheduling. The coverage is in
`tests/security/scheduled-execution.test.ts` (87 cases, including the cadence
arithmetic, the store and the clock, which would otherwise have been unit
tests) and `tests/e2e/schedules.spec.ts` (7 cases in real Chromium). Citing
those files under columns they do not sit in is exactly what this matrix's
evidence check exists to prevent.

It is **not** PASS for two reasons, neither of which is a missing test.

The first is the §84 condition 3 that holds every other PARTIAL below PASS
repository-wide. An implementation existing is not parity.

The second is specific to this capability and is worth stating plainly.
Parity is measured against a benchmark, and at the two points that matter most
here — what a scheduled run does when it reaches an action needing approval,
and what happens to an occurrence that was missed — **nothing published
settles the benchmark's behaviour**. An evidence exercise went looking and
found none for the Claude in Chrome extension specifically. So AI Browser
Agent made its own decision, which is documented as its own decision in
`docs/architecture/SCHEDULED_EXECUTION.md`: a run that reaches the
confirmation boundary stops, and a missed occurrence is recorded and never
replayed. Marking this PASS would be claiming a match with behaviour nobody
has established. Calling the chosen behaviour "Claude behaviour" would be the
same claim in different words, and the documentation says so explicitly.

Nothing here is blocked externally.

**P-021 Shortcuts** — A shortcut is a name for something that already exists
and has already been reviewed: a stored workflow (P-022) or a bundled skill
(P-024). It holds a name and a reference and nothing else — no steps, no tool
arguments, no prompt, no code — and it adds no execution path. Resolving one
is a read that runs nothing; what it points at then runs through the route
that already existed for that kind of target, with risk, policy, permission,
egress and evidence all re-applied per step. A confirmation shows what a name
means before anything starts, and is deliberately not an authorization.

Names are identifiers, not patterns: normalisation is fixed and idempotent,
lookup is exact equality with no nearest match, and a name that collides with
an existing one — identically, or only under a confusability key that folds
digit and letter lookalikes — is refused rather than merged or renamed.
Targets are re-checked at every resolution, so a deleted workflow, an
incomplete recording or an unregistered skill fails closed and never falls
through to something else. No `shortcut.*` tool exists and no model can
create, choose or invoke one.

Covered by a unit suite, an integration suite, a twenty-seven-case security
suite and an eight-test real-Chromium suite, with twelve mutations proved to
fail. No new permission and no new host access.

A shortcut may now also name a **saved prompt**: an objective the user stored,
which starts an ordinary task through the ordinary route. That is content
rather than a reference, and it is allowed for one reason — an objective is
the same string the composer already accepts, it reaches only `task.create`,
and it names no tool, argument, element or step. Typing it and recalling it
are the same act, so it grants what typing would grant, which is a task that
must still ask for everything it does. The fields that would make a shortcut
executable — steps, arguments, selectors, code, `prompt`, `instructions` —
stay refused at any depth, a prompt target is refused unless it carries the
objective and nothing else, and the confirmation shows the objective rather
than a risk level it cannot know before the run exists.

PARTIAL because the §85 A–F manual acceptance scenarios have not been
executed — as for every row in this file — and for two reach limits. A
shortcut names a whole target and takes no per-run inputs, so a workflow with
runtime slots is reached through the review surface rather than by name;
extending shortcuts to carry input values would mean storing values, which is
a different security question and deliberately out of P-021's scope. And a
shortcut cannot be scheduled: schedules target skills and workflows, and
adding a target kind to them is a P-020 change, which is frozen.

**P-022 Workflow recording** — Recording and replay are implemented, on top
of the skill definition, validator, runner and dispatch path rather than
beside them: P-022 added no execution code. The recorder observes completed
dispatches through a hook that hands it a deep-cloned, frozen record carrying
no result and no authorization state; a store owns each definition's canonical
form, hash and version; and replay revalidates and then runs every step
through the one `ToolRegistry.dispatch`, so each is re-adjudicated by the same
policy, permission and egress gates that adjudicated it when it was recorded.
A recording is never registered, never appears in `skills.list` and is never
model-selectable — replay is an explicit user action.

Element interactions are recorded as specification §49 asks: a click stores a
role and an accessible name, not a handle and not a selector. That data is
tagged `PAGE_DERIVED` permanently — passing ARIA validation, secret detection
or a uniqueness check gates whether it may be stored, never where it came from
— and may only ever be compared for equality against a fresh page read or
shown in the review surface. A recording the recorder could not complete keeps
its gaps, shows them in position, and cannot be replayed at all.

Covered by a unit suite, an integration suite, a twenty-four-case security
suite and a twelve-test real-Chromium E2E suite, with each source-scan and
real-browser claim proved to fail when its mechanism is removed.

PARTIAL for one reason, and it is reach rather than architecture: the §85 A–F
manual acceptance scenarios have not been run for this capability, as for
every other row in this file (see "What the PASS column actually means"), and
recording covers the tool surface this build ships rather than every
interaction a reference implementation offers — checkbox and radio bindings
ride the same path but have no dedicated recorded workflow, and the
multi-connector reference workflow of §44 cannot be recorded because those
connectors do not exist (see P-023).

Nothing here is blocked externally. The remaining work is building more, not
obtaining anything.

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

What _was_ closed is narrower and worth naming precisely: the framework is now
shown to hold more than one connector rather than assumed to. A second,
test-only descriptor registers alongside the shipped one, and the suite proves
what keeps them apart — per-connector scopes, a vault keyed by connector, no
pooling of API origins, per-descriptor validation, and a duplicate id refused
rather than silently replacing an authorised one. The worker's registration
helper was typed to the single shipped adapter class and is now typed to the
`Connector` interface, so the framework is extensible at the point where a
connector is actually added and not merely everywhere else.

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
2. The remaining NOT-STARTED capabilities implemented and tested — **two**
   today, P-025 Plugins and P-026 MCP. This line read "nine" until the count
   was checked against the table beneath it.
3. ~~At least three provider adapters passing the same suite, proving P-033
   rather than asserting it.~~ **Done.** Three adapters —
   `openai-compatible`, `anthropic`, `gemini` — pass one 21-case conformance
   suite, and switching between them runs in real Chromium against servers
   speaking each provider's real protocol. Live commercial endpoints remain
   unexercised (see P-033 below).
4. The acceptance tests from specification §85–89 executed and recorded.

Progress against this list belongs in this file, updated in the same commit as
the code that changes it.
