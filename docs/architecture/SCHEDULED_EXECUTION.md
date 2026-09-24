# Scheduled execution (P-020)

A schedule is a **clock attached to something that already exists**. It names
a shortcut, a recorded workflow or a bundled skill, says when to run it, and
holds nothing else. There is no field in a schedule for an objective, an
argument, a page value, a model reply or a credential, and
`assertScheduleSafe` refuses a record that grew one.

This document records the behaviour and, more importantly, the decisions —
including the one this feature exists to make, which is what happens when a
run nobody is watching reaches an action that needs a person.

---

## 1. The product decision

> **When a scheduled run reaches an action that requires interactive
> confirmation, it stops.** It does not proceed, it does not wait, and it does
> not convert the confirmation into an approval. The run ends in a recorded
> `blocked` state naming `CONFIRMATION_REQUIRED`, the user is notified, and
> the next occurrence is unaffected.

**This is an explicit AI Browser Agent product decision.** It is not derived
from, and does not claim to describe, how any other browser agent behaves.

It is worth being precise about that, because this phase was preceded by an
evidence exercise that went looking for documented behaviour from the Claude
in Chrome extension at exactly these two points — what a scheduled run does
when it needs approval, and what happens to an occurrence that was missed —
and **found none**. Not "found something ambiguous": found nothing published
that settles either question for that product. So:

- **Nothing here is a claim about Claude in Chrome's internals.** The
  behaviour at the approval boundary and at the missed-run boundary is not
  documented for that product, and this implementation neither infers it nor
  reproduces it.
- **Do not describe this behaviour as "Claude behaviour".** It is AI Browser
  Agent's behaviour. Calling it anything else would be asserting something
  about a product whose behaviour at these points nobody outside it knows.
- **Parity is a capability goal, not a permission to copy a weakness.** Where
  a benchmark's behaviour is unknown, the safe reading is the one taken here.

### The alternative that was deliberately not built

A "saved grant" model — a standing, revocable authorization that lets a
scheduled run approve its own confirmations — was considered and rejected for
this phase. Nothing in this implementation is a step towards one:

- no stored approval, and no field that could hold one;
- no per-task "always allow";
- no scheduled-execution authorization token;
- no second authorization hierarchy beside the permission engine.

A user who wants a confirmation approved runs the schedule themselves with
**Run now**, which is attended and can ask them. That is the whole recovery
path, and it is deliberately the only one.

---

## 2. What may run unattended

The risk model is unchanged. A scheduled run is evaluated by the same policy
engine, under the same permission mode, against the same six risk levels as a
run somebody started by hand. What differs is one fact the engine is told:
`PolicyContext.unattended`.

| Risk | Unattended behaviour                                                               |
| ---- | ---------------------------------------------------------------------------------- |
| R0   | Runs. Read-only, no page or external state change.                                 |
| R1   | Runs **where the permission mode permits it** — Auto and Skip do, Manual does not. |
| R2   | Never silently authorised. Becomes a confirmation, and therefore stops.            |
| R3   | Confirmation-required in every mode, as it already was. Stops.                     |
| R4   | Stops.                                                                             |
| R5   | Denied outright, as it already was. Recorded as `POLICY_DENIED`.                   |

Two things about that table are worth stating rather than leaving to be
inferred:

**Scheduled execution is not "R0 only".** R1 actions — clicking, typing,
navigating, closing a tab — run unattended in the modes that already permit
them attended. Restricting schedules to reads would have made the feature
useless without making it safer, because the thing that makes R1 acceptable in
Auto mode is the risk classification, not the presence of a witness.

**R2 is where the line moves.** In Skip mode an R2 action would otherwise be
allowed with no prompt at all, which would mean a file transfer or a page-state
change happening with nobody present and nobody asked. The single clause in
`evaluatePolicy` that reads `context.unattended` turns that into a
confirmation. It sits after the deny rules and before the mode switch, so it
can only ever make an answer stricter: a prohibition stays a denial, and
nothing it touches turns a refusal into a question.

Everything else is unchanged and was not re-implemented: hard prohibitions,
`ALWAYS_DENY_AT`, site blocks, origin automatability, origin drift,
credential and cross-site exfiltration, workspace membership, and
`SECRET_LOCAL_ONLY`.

---

## 3. How a run is recognised as unattended

From the **task record**, which is durable.

A scheduled run executes under a session id of the form
`unattended_<runId>` — a prefix `newSessionId()` cannot produce. Two places
read it:

1. `loadPolicyContext` in the service worker, which sets
   `PolicyContext.unattended` for every dispatch in that run.
2. `UnattendedPrompter`, which sits in front of the one permission prompter
   and answers `deny` instead of raising a prompt into a panel nobody has
   open.

Reading it from the task record rather than from a registry in worker memory
is deliberate: MV3 evicts the service worker constantly, and a run that woke
on the other side of an eviction must still be unattended. A registry would
have forgotten.

Both readers fail closed. A task that cannot be found, and a storage read that
throws, are both treated as unattended.

`UnattendedPrompter` is a filter, not a second permission path. It evaluates
no policy, classifies no risk, and can only turn a question into a denial;
everything it does not deny it hands to the interactive prompter unchanged.

---

## 4. Missed runs

> **A missed occurrence is recorded and is NOT automatically replayed.**

An occurrence that passed while the browser was closed, or while the worker
was not running and no alarm was delivered, is recorded as `missed` with the
reason `MISSED_WHILE_ASLEEP`, is claimed so no later wake-up can pick it up,
and is never executed late.

- There is **no catch-up run**, and no queue of owed runs.
- The **next occurrence proceeds normally**.
- The user can run it sooner with **Run now**, which is attended.
- Every missed occurrence is in the audit trail as `schedule.run_missed`.

The reason is not conservatism for its own sake. A browser agent acts on live
web pages. "Check the overnight orders at 07:00" run at 16:00 is a different
instruction, executed against a different page, with nobody expecting it.

**How late is late.** `RUN_GRACE_MS` is ten minutes. Inside it an occurrence
still runs, because Chrome's alarms are not delivered to the second and a
scheduler that insisted on exactness would never run anything. Outside it the
occurrence is missed. Where two or more occurrences are due at one wake-up,
at most one can run — the most recent, and only if it is inside the window;
everything earlier is missed by definition.

A schedule left alone for a very long time is re-anchored rather than
enumerated: past `MAX_ENUMERATED_OCCURRENCES`, the walk stops, the verdict is
marked `truncated`, and one record stands for the gap.

**A paused schedule misses nothing.** It was not expected to fire, so there is
nothing to record, and resuming re-anchors its clock to now.

---

## 5. Running at most once, ever

Chrome delivers alarms more than once in practice: a wake-up races a startup
reconciliation, an alarm survives an eviction and arrives again, two events
land in one worker generation. An agent that clicks things must not do it
twice.

**Execution identity is deterministic.** A run is identified by
`runIdFor(scheduleId, occurrenceAt)` — derived from the schedule and the
_scheduled_ instant, never the instant the alarm happened to fire. It is the
same value on every wake-up, in every worker generation, after every eviction.

**The claim is atomic and monotonic.** `ScheduleStore.claimOccurrence` reads,
checks and writes `lastClaimedOccurrenceAt` inside one transaction. A claim at
or before the recorded floor is refused, whoever is asking. A single number
rather than a set, because occurrences are ordered and the set would grow
without bound.

**Everything after the claim is best effort.** If the worker dies halfway, the
occurrence stays claimed and is never run again. That is the safe direction.

**An interrupted run is closed, not resumed.** On startup, a run still marked
`running` belongs to a worker generation that no longer exists; it is recorded
as `failed` / `INTERRUPTED`. Resuming halfway through a sequence of browser
actions is how a workflow does the second half of something to the wrong page.

---

## 6. Execution goes through the existing path

There is no second task engine, and no scheduled dispatch.

```
alarm → ScheduleRunner.tick
      → occurrencesDue           (arithmetic; no policy, no execution)
      → ScheduleStore.claim      (atomic; at most once)
      → resolveScheduleTarget    (shortcut → workflow | skill, resolved now)
      → WorkflowReplayer.replay | SkillLauncher.launch
      → SkillRunner → ToolRegistry.dispatch
      → policy engine → permission engine → egress gate → tool
```

`ScheduleRunner` decides _when_. It decides nothing about whether an action is
safe: there is no risk level, no permission mode, no site rule and no
prohibition list anywhere in it, and no code path from it to a tool. The
schedule module reaches no `ToolRegistry`, no `SkillRunner` and no
`WorkflowReplayer` at all.

The task lifecycle is the existing one. A scheduled run produces an ordinary
`AgentTask` and consumes the states it already has — `RUNNING`, `COMPLETED`,
`FAILED`, `BLOCKED`, `CANCELLED`. **No task state was added**: `BLOCKED`
already meant "stopped by a decision rather than by an error", which is
exactly what parking at the confirmation boundary is. What is new is the
schedule-run record beside it, which says _why_ in a closed vocabulary the
task record has nowhere to put.

**A target is resolved at every firing**, never trusted from creation. A
shortcut that was retargeted runs its new target; a workflow that was deleted
stops the run with `TARGET_MISSING`; a recording that is incomplete stops it
with `TARGET_UNUSABLE`.

**A target that asks for values cannot be scheduled.** A run with nobody
present cannot answer, so a workflow or skill with required inputs is refused
at creation and again at firing, with `INPUTS_REQUIRED`. This is also what
keeps a schedule from ever needing somewhere to store an answer.

---

## 7. Run now

**Run now is attended, deliberately.** A person pressed it with the panel
open, so the run gets an ordinary session and the ordinary interactive
prompter, and it can ask them to confirm an action.

That asymmetry is the recovery path for the boundary: a blocked run says what
it needed, and the user runs it themselves and answers.

Run now does **not** touch the schedule's clock. No occurrence is claimed, the
next firing is unchanged, and a missed occurrence stays missed.

---

## 8. What is stored

A schedule holds: id, format version, display name, target reference,
cadence, enabled flag, created and updated timestamps, next occurrence, the
monotonic claim floor, and a summary of the last run (when, status, reason).

A run holds: deterministic run id, schedule id, the scheduled instant, start
and finish timestamps, a status, a reason from a closed vocabulary, and the id
of the task it created.

**Never stored:** provider API keys, OAuth tokens, any credential, page
contents, model responses, tool arguments, tool results, or any browser
secret. `assertScheduleSafe` walks both record types recursively and refuses
a field whose name is any of those, at any depth.

Classification (`src/storage/data-classification.ts`):

| Kind           | Cloud eligibility | Export portability       | K1 at rest            |
| -------------- | ----------------- | ------------------------ | --------------------- |
| `schedule`     | `LOCAL_ONLY`      | `NOT_PORTABLE_BY_DESIGN` | `PLAINTEXT_BY_DESIGN` |
| `schedule-run` | `LOCAL_ONLY`      | `LOCAL_ONLY`             | `PLAINTEXT_BY_DESIGN` |

Two of those deserve their reasons in prose.

**Not portable, by design.** A schedule is a standing instruction to act with
nobody watching. An imported workflow sits there until a person runs it, so
importing one grants nothing; an imported schedule runs on a clock. Accepting
one from a file somebody may have been mailed would mean this browser starts
taking actions on websites every morning because of a decision made in an
archive — the same shape of problem site rules are excluded for. The user can
import the workflow and set their own schedule in seconds.

**Plaintext at rest, by design.** The alarm that fires a schedule wakes a
worker nobody is looking at. A schedule the extension could not read until
somebody typed a K1 passphrase would be a schedule that silently stopped
running. It holds no secret, so encryption would protect nothing.

---

## 9. Audit and notifications

Eleven event types, all in `AUDIT_EVENT_TYPES`:

`schedule.created`, `schedule.updated`, `schedule.paused`,
`schedule.resumed`, `schedule.deleted`, `schedule.run_started`,
`schedule.run_completed`, `schedule.run_failed`, `schedule.run_blocked`,
`schedule.run_cancelled`, `schedule.run_missed`.

Records carry `scheduleId`, `runId`, `taskId` and a code from the closed
reason vocabulary. They never carry the schedule's display name (free text a
user chose), a cadence, a tool argument or anything page-derived.

Notifications cover the four lifecycle points the user cannot otherwise see:
started, completed, failed, and blocked. The blocked notification distinguishes
"this needs your approval — run it yourself" from "an action it needed is not
permitted", because those ask different things of the reader.

---

## 10. No provider, no backend, no database

Scheduling is provider-agnostic and consults no model. A scheduled run of a
workflow or a skill executes fixed steps, so its task records `providerId:
'none'` and `modelId: 'none'` — it works with no AI account connected at all,
and switching providers cannot affect a schedule or a run in flight.

The schedule modules name no provider, reach no network, and read no
credential store, token vault or settings. There is no backend, no server, no
database and no cloud service anywhere in this feature; a schedule is
`chrome.storage` and a `chrome.alarms` alarm.

---

## 11. Reach

Every schedule route is panel-only (`CLASS_B_PANEL_CONTROL_PLANE` for the ones
that change something or run, `CLASS_E_PANEL_READ_ONLY` for the reads). There
is **no schedule tool**: a model can neither create a schedule, nor edit one,
nor cause one to fire, and schedules never enter model context.

---

## 12. Evidence

- `tests/security/scheduled-execution.test.ts` — 87 cases covering CRUD, all
  four cadences, pause and resume, Run now, shortcut targets, the R0–R5
  boundary in all three permission modes, the unattended policy clause,
  exfiltration, idempotency and concurrent claims, worker-restart recovery,
  missed runs, cancellation, notifications, audit, persistence, corrupt
  records, clock and grace-window edges, daylight saving in a real DST zone,
  and the provider/backend/secret exclusions. Two cases (`28b`, `42b`) are
  controls that change only who is watching and show the run completing.
- `tests/e2e/schedules.spec.ts` — 7 cases in real Chromium: the `alarms`
  permission is granted and usable, creating a schedule arms a real alarm and
  starts nothing, a due schedule survives a genuine service-worker kill and
  drives a real page through the real content script, the same schedule in
  Manual mode stops at the boundary with the page unmoved and no prompt left
  pending, a paused schedule does nothing, the shipped panel says what a run
  will not do, and no schedule tool or schedule text reaches the model.

Five negative controls were run and each discriminated: disabling the
unattended policy clause, making `UnattendedPrompter` delegate everything,
removing the monotonic occurrence claim, making a late occurrence replay, and
clamping a monthly day instead of skipping it. The confirmation-boundary
control was also run against real Chromium.
