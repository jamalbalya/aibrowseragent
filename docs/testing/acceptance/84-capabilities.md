# §84 condition 3, per capability

Specification §84 lists six conditions and says a capability is PASS only when
all six hold. Condition 3 is three words long:

> 3. manual acceptance test exists;

This directory has held sixty-three acceptance procedures and a per-procedure
status table since it was created, and every one of them is organised by
**specification section** — §85 mandatory, §86 security, §87 providers, §88
connectors, §89 browser failures, §90 MV3 failures, §91 downloads. Condition 3
is not stated per specification section. It is stated **per capability**, and
until this document there was no way to answer it for a capability: of the forty
in `PARITY_MATRIX.md`, exactly one — P-011 Download — appeared anywhere in this
directory at all.

So condition 3 had been answered repository-wide and never row by row. That is
the gap this file closes, and closing it is not a relaxation: every capability
below that has no procedure now gets one written, and a capability that still has
none says so.

## What this file is, and what it is not

**It is a census.** One item per capability, forty items, no exceptions and no
silent omissions. `scripts/check-acceptance.mjs` enumerates the matrix's own
table and fails if a capability is missing from here, so a forty-first capability
cannot be added without answering condition 3 for it.

**It is not an execution record.** Every procedure written here is
`NOT YET EXECUTED`, exactly like every other manual procedure in this directory,
and remains so until somebody runs it and appends the result to
[`RESULTS.md`](RESULTS.md). [`MATRIX.md`](MATRIX.md) carries the status.

**It does not re-litigate what condition 3 means.** The repository has read it
throughout as "a person has executed the manual acceptance test", recorded as
blocker B-1 and stated on every row as "unmet repository-wide". The
specification's own word is **exists**. Both readings are stated here because
the difference changes who is blocked and on what: under the literal reading,
condition 3 is engineering work that was not done; under the repository's
stricter reading, it is additionally a person's work that has not been done. The
engineering half is what this file does. The stricter half is untouched and is
still B-1 — the procedures below are written, not executed, and nothing here
moves a row.

## Two kinds of entry

| Entry           | Means                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| `- COVERED BY:` | An existing procedure in this directory is this capability's manual acceptance test |
| `- PROCEDURE:`  | No existing procedure covered it, so one is written here                            |

A `COVERED BY` is only allowed where executing the named procedure would **fail
if this capability were broken**. Pointing at a procedure that merely runs
alongside the capability would make the census agree with everything, which is
the failure mode every other census in this repository was built to avoid. The
checker verifies that the named procedure exists in `MATRIX.md`; it cannot
verify the judgement, and that is a review question.

Every written procedure states preconditions, numbered steps, the criterion, and
what a failure looks like. A procedure whose criterion is "it seems to work" is
not a procedure.

---

## P-001 — Side panel

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Load `dist/` unpacked at `chrome://extensions`.
  2. Open the side panel from the toolbar icon on an ordinary web page.
  3. Send one message and wait for a reply.
  4. Switch to a second tab, then back.
  5. Close the panel and reopen it.
- CRITERION: the panel opens beside the page rather than over it, the
  conversation is still there after the tab switch and after the reopen, and the
  page underneath is never obscured or reflowed.
- FAILS IF: the panel opens as a popup, the conversation is empty after
  reopening, or the page layout shifts when the panel opens.

## P-002 — Read page

**Verdict: `MANUAL`**

- COVERED BY: 85-A-1. Its prompt cannot be answered without reading the page,
  and its criterion is whether the summary matches what the page says.

## P-003 — Click

**Verdict: `MANUAL`**

- COVERED BY: 85-A-1, which requires opening a search result — a click on an
  element the agent located itself.

## P-004 — Type

**Verdict: `MANUAL`**

- COVERED BY: 85-A-1, which requires typing "QA" into a search field.

## P-005 — Navigate

**Verdict: `MANUAL`**

- COVERED BY: 85-A-1, which requires opening a test website and then a result.

## P-006 — Forms

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Open a page carrying a form with a text input, a `<select>`, a checkbox, a
     radio group and a `<textarea>`.
  2. Ask the agent to fill every field with named values and submit.
  3. Read the submitted values off the resulting page.
- CRITERION: every field holds the value that was asked for, the `<select>`
  moved by selecting an option rather than by typing into it, and the submission
  carried all five.
- FAILS IF: any field is left at its default, a value lands in the wrong field,
  or the agent reports success without the submission having happened.

## P-007 — Scroll

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Open a page whose content is several screens tall, with a target element
     far below the fold.
  2. Ask the agent to act on the target without mentioning scrolling.
  3. Repeat on a page where the scrolling container is a nested `overflow:auto`
     element rather than the document.
- CRITERION: the target is reached in both cases.
- FAILS IF: the agent reports the element missing on either page, or scrolls the
  document when the content lives in a nested container.

## P-008 — Screenshot

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Open a page with distinctive visible content.
  2. Ask the agent a question that can only be answered from the rendered
     appearance — a colour, a layout position, an image with no alt text.
  3. Inspect the captured image in the conversation.
- CRITERION: the capture is of the active tab at the moment of asking, it is
  legible, and the answer depends on it.
- FAILS IF: the capture is blank, is of a different tab, or the answer could have
  been produced from the DOM alone.

## P-009 — Image upload

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Configure a provider and a model that advertises vision.
  2. Attach an image file to a message from the panel and ask a question whose
     answer is only in the image.
  3. Repeat on a model that does not advertise vision.
- CRITERION: the vision model answers from the image; the non-vision model
  refuses before sending rather than sending an image it cannot read.
- FAILS IF: the image is silently dropped, or the refusal arrives as a provider
  error rather than as a capability refusal.

## P-010 — File upload

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Open a page with `<input type="file">`.
  2. Ask the agent to attach a file. Observe that selection is offered to you
     rather than performed.
  3. Choose a file, then confirm the attachment.
  4. Repeat and **decline** at the confirmation.
- CRITERION: the file reaches the input only after both your selection and your
  confirmation; declining leaves the input empty and the task reports a refusal.
- FAILS IF: any file reaches a page without a selection you made, or a decline
  still attaches.

## P-011 — Download

**Verdict: `MANUAL`**

- COVERED BY: 91-D-3, which is the grant dialog itself and is the one procedure
  in this directory already written against a capability ID.

## P-012 — Multi-tab

**Verdict: `MANUAL`**

- COVERED BY: 85-B-1, a three-tab comparison with one tab closed mid-task.

## P-013 — Tab grouping

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Open four unrelated tabs.
  2. Ask the agent to group the ones belonging to one task.
  3. Inspect the tab strip.
- CRITERION: a named group exists in Chrome's own tab strip holding exactly the
  tabs named, and tabs outside it are untouched.
- FAILS IF: the group is reported but not present in the strip, or unrelated
  tabs are swept into it.

## P-014 — DOM inspection

**Verdict: `MANUAL`**

- COVERED BY: 85-C-1, whose diagnosis requires inspecting the DOM of a genuinely
  broken page.

## P-015 — Console inspection

**Verdict: `MANUAL`**

- COVERED BY: 85-C-1, whose staged fault is only visible in console output.

## P-016 — Network inspection

**Verdict: `MANUAL`**

- COVERED BY: 85-C-1, whose staged Save failure is a failed request.

## P-017 — Long-running task

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Start a task that needs many turns — a multi-page extraction across at
     least ten pages.
  2. Leave it running, without touching the panel, for longer than Chrome's
     thirty-second service worker idle timeout.
  3. Watch the panel until it finishes.
- CRITERION: the task completes; progress is visible throughout; no step is
  repeated after a worker eviction.
- FAILS IF: the task stalls silently, restarts from the beginning, or performs
  any action twice.

## P-018 — Background task while Chrome is open

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Start a long task.
  2. Close the side panel. Switch to a different tab and use the browser
     normally for two minutes.
  3. Reopen the panel.
- CRITERION: the task ran while the panel was closed and its progress is there
  on reopening.
- FAILS IF: the task paused when the panel closed, or its progress is lost.

## P-019 — Notifications

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Start a task that will need a confirmation partway through.
  2. Close the panel and switch to another window.
  3. Wait for the notification, and click it.
  4. Separately, let a task run to completion with the panel closed.
- CRITERION: a system notification appears for the confirmation and for the
  completion, clicking it brings you to the panel at the right place, and the
  notification text names no page content.
- FAILS IF: no notification appears, clicking one does nothing, or the text
  carries anything read off a page.

## P-020 — Scheduled tasks

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Create a daily schedule a few minutes ahead, targeting a shortcut.
  2. Leave Chrome running and wait for it to fire.
  3. Restart Chrome and confirm the next occurrence is still listed.
  4. Pause it, wait past an occurrence, resume it.
- CRITERION: it runs once at its time, survives the restart, does not run while
  paused, and the run history records each outcome including the missed one.
- FAILS IF: it fires twice, silently stops after the restart, or runs while
  paused.

## P-021 — Shortcuts

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Create a shortcut with a parameter.
  2. Invoke it by name from the panel, supplying a value.
  3. Export it, delete it, and import the file back.
  4. Invoke the imported one.
- CRITERION: both invocations behave identically, and the imported shortcut has
  the same scope as the original.
- FAILS IF: the imported shortcut runs anywhere the original could not, or the
  parameter is ignored.

## P-022 — Workflow recording

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Start recording. Sign in to a test site, navigate two pages, fill a form
     including a password field, and stop.
  2. Review the recorded steps before saving.
  3. Replay it on a fresh profile.
- CRITERION: the replay reproduces the run; the password value is **not** in the
  recording; any step dropped during recording is visible in the review and the
  replay refuses rather than silently skipping it.
- FAILS IF: a secret appears in the saved workflow, or an incomplete recording
  replays as though complete.

## P-023 — Connector framework

**Verdict: `MANUAL`**

- COVERED BY: 88-connect through 88-least-privilege, all `BLOCKED — OAUTH`. The
  procedures exist; what is missing is a registered OAuth application (A-1).

## P-024 — Skills

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Run a bundled skill from the panel.
  2. Interrupt it midway by closing the panel; reopen and resume.
  3. Attempt to run a skill definition that did not ship in the build.
- CRITERION: the skill runs and resumes; the untrusted definition is inert and
  says why.
- FAILS IF: a definition the build did not ship executes.

## P-025 — Plugins

**Verdict: `NOT POSSIBLE HERE`**

- REASON: nothing is implemented, so there is no behaviour to put a person in
  front of. This is the one capability whose condition 3 cannot be satisfied by
  writing a procedure, and writing one anyway would be a procedure for a product
  that does not exist. See `PARITY_MATRIX.md` "P-025 Plugins — an internal
  specification requirement, not a parity gap": the row is NOT-STARTED, its
  eight clauses are classified, and whether it ships at all is owner decision
  C-1.

## P-026 — MCP

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Run a local MCP server. Add it in Settings.
  2. Confirm its tools appear in the panel's tool list under `mcp__<id>__`.
  3. Ask for something that needs one, and confirm at the prompt.
  4. Run the same request again and **decline**.
  5. Schedule a task that would use an MCP tool.
- CRITERION: every MCP call prompts, on every call; a decline performs nothing;
  the scheduled task refuses outright because it cannot confirm.
- FAILS IF: a second call runs without prompting, or an unattended run reaches
  an MCP tool.

## P-027 — Permission modes

**Verdict: `MANUAL`**

- PROCEDURE:
  1. In `manual`, run a task that clicks and then submits a form. Approve each.
  2. Switch to `auto` and repeat.
  3. Switch to `skip` and repeat.
- CRITERION: `manual` asks for everything; `auto` stops asking for low-risk
  actions; **all three still stop at R3** — the submission is confirmed in every
  mode, including `skip`.
- FAILS IF: any mode carries an R3 action through without a confirmation.

## P-028 — Site permissions

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Grant a standing permission for one site.
  2. Run the same action on that site — it should not ask again.
  3. Run it on a different site, and on a subdomain of the granted one.
  4. Attempt an R3 action on the granted site.
- CRITERION: the grant covers exactly the site it names and neither the
  subdomain nor the other site, and it never covers R3.
- FAILS IF: a grant spreads to another origin, or raises what it can approve.

## P-029 — Permission history

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Approve one action and decline another.
  2. Grant a site permission, then revoke it.
  3. Open the permission history view.
- CRITERION: all four appear, each with what was asked, what was decided and
  when; the revocation is recorded as its own entry rather than by the grant
  disappearing.
- FAILS IF: a decision is absent, or revoking erases the grant's record.

## P-030 — Prompt injection defence

**Verdict: `MANUAL`**

- COVERED BY: 86-1 through 86-4. The written procedures exist; §86 marks them
  `NOT EXECUTED (not required)` because the same hostile pages run in real
  Chromium on every build.

## P-031 — Session persistence

**Verdict: `MANUAL`**

- COVERED BY: 90-08, the browser restart, which asks what survives a full quit
  and reopen — task state, settings, and a connector grant that deliberately does
  not.

## P-032 — Task resume

**Verdict: `MANUAL`**

- COVERED BY: 90-09, the extension reload, which interrupts a running task and
  asks whether it is parked rather than silently resumed.

## P-033 — Provider switching

**Verdict: `MANUAL`**

- COVERED BY: 85-F-1, which needs three vendor keys and compares the identical
  prompt across three adapters.

## P-034 — Tool calling

**Verdict: `MANUAL`**

- COVERED BY: 87-06 and 87-07 — one tool call and many, against a real vendor.

## P-035 — Capability doctor

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Configure a model that cannot call tools, and start a task needing one.
  2. Configure a valid provider with an invalid key.
  3. Configure a working provider and open the doctor.
- CRITERION: each case is named before anything is sent, in words that say what
  to change; the refusal is a capability refusal, not a provider error relayed.
- FAILS IF: the task starts and fails partway, or the message is a raw vendor
  error.

## P-036 — Error recovery

**Verdict: `MANUAL`**

- COVERED BY: 89-01 through 89-12, twelve browser failure procedures, each
  asking what the agent does when the page does not cooperate.

## P-037 — Loop detection

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Stage a page whose button never changes anything.
  2. Ask for something that can only be achieved through it.
  3. Watch without intervening.
- CRITERION: the agent stops, says it is repeating itself without progress, and
  does not consume turns indefinitely.
- FAILS IF: it keeps going until a budget runs out, or reports success.

## P-038 — Audit trail

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Run a task involving a confirmation, a denial and a site grant.
  2. Open the Activity view and read the entries.
  3. Export the audit trail and open the file.
  4. Check the export for page text, a URL query string, and anything
     credential-shaped.
- CRITERION: every authority-changing action is there; the export is the same
  set; no page-derived text and no secret is in it.
- FAILS IF: an approval or a grant is missing, or the export carries content read
  off a page.

## P-039 — Evidence model

**Verdict: `MANUAL`**

- PROCEDURE:
  1. Run a task that reaches a conclusion from a page.
  2. Open the evidence attached to the answer and follow each item back.
- CRITERION: every claim is traceable to something observed, and evidence names
  its source and time; nothing is attributed to a page that did not say it.
- FAILS IF: a claim has no evidence, or evidence names a page the task never
  read.

## P-040 — Provider/model capability detection

**Verdict: `MANUAL`**

- COVERED BY: 87-02, 87-03 and 87-12 — validate, list models, and the
  unsupported-capability path, against a real vendor.
