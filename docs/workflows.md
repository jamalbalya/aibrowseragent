# Recorded workflows (P-022)

A recorded workflow is a task you already ran, saved so you can run it again.
The recorder watches the steps a task completes and writes down what each one
did; replaying it does those steps again, from the top.

It is **structured data**, in the same shape a [skill](skills.md) is — the same
definition, the same validator, the same runner, the same dispatch. P-022 added
no execution code at all. What it added is a way for a recording to become one
of those definitions, and a way for you, and only you, to start it.

## What a recording is not

A recording is **not a permission**. Nothing about having recorded a step
authorises it later. Every step is re-adjudicated at replay by the same gates
that adjudicated it when it was recorded, against the world as it is then: a
site that has since been blocked, a connector that has since been
disconnected, a tool that has since been removed, a risk level that has since
been raised. What a recording saves you is re-describing the work, not the
approvals.

A recording is **not a skill**. It is deliberately not registered in the skill
registry, does not appear in `skills.list`, and is not in the tool list the
model is offered. Registration is what makes something model-invokable, and
the registry's bundled-only rule exists because a person has to review the
_combination_ of tools a workflow can reach before a model may choose it. You
recording yourself doing something is not that review.

So there is no `workflow.register`, no `workflow.install`, no route or tool
that accepts a definition, and no way for a model to name a recorded workflow.
The only way one runs is you pressing Replay.

A recording is **not a transcript**. It holds the steps, not the results. There
is no field for step output, page text, file contents or anything a step read —
not because callers are trusted to leave them out, but because the stored shape
has nowhere to put them and a recursive check refuses a record that grew one
anyway.

## The lifecycle

```
RECORDING → STORED DEFINITION → YOUR REVIEW → YOUR EXPLICIT REPLAY → EXECUTION
```

Only the last arrow executes anything. Starting a recording, stopping one,
saving it, renaming it, reviewing it and revalidating it are all storage and
display operations; none of them runs a step.

## What gets stored, and what does not

Every captured argument goes through three **independent** controls, in a fixed
order. They are not interchangeable and one never stands in for another.

1. **Secret detection**, first and unconditional. It runs on every value
   whatever the task's provenance, using the same redactor the logs, evidence
   and audit trail use — so a recording can never be laxer than they are. A
   secret-shaped value is never stored as a literal: not as a slot default, not
   truncated, not hashed.
2. **Sensitivity by argument name.** A `password`, `token` or `apiKey`
   argument becomes a runtime slot regardless of what its value looks like. An
   empty password is still a password field.
3. **Taint**, which decides literal-versus-slot for everything that survived
   the first two.

`KNOWN_UNTAINTED` means only that the task's provenance was established. It
does **not** mean a value is safe to persist, to export, to send, or that it is
non-sensitive — which is why secret detection runs first and can only ever
_remove_ a literal, never permit one that taint would have refused.

A task whose security context is `UNKNOWN` has nothing said about it, so
nothing from it is stored at all: the step is dropped rather than recorded with
values nobody can vouch for.

| Captured value                                     | Stored as                       |
| -------------------------------------------------- | ------------------------------- |
| A URL a clean task navigated to                    | a literal                       |
| A `submit` flag, an element handle                 | a literal — structure, not data |
| A short list of options or ids, element by element | a literal                       |
| Anything credential-shaped, at any provenance      | a slot, asked for at replay     |
| A long value from a task that had read a page      | a slot                          |
| A list that cannot be stored                       | nothing; the step is dropped    |
| Anything from a task with unknown provenance       | nothing; the step is dropped    |

A slot's description says what to supply. It never quotes what was captured,
because the captured value is the thing that must not reach disk.

### Why a list is either stored or dropped, and never asked for

A slot supplies one scalar: `SkillInputType` is `string | number | boolean` and
nothing coerces a scalar into a list. So an argument captured as a list has two
honest outcomes and not three. Either every element passes the same test a lone
value would — short, no whitespace, no scheme, no address, and the list itself
bounded — in which case it is kept as written; or it cannot be stored, in which
case the step is dropped, the recording says so in position, and it refuses to
replay.

The third outcome, turning it into a slot, was what the recorder did until
Wave 5, and it is the interesting kind of wrong: the step looked complete in the
review surface, the workflow reported no gaps, and the replayed call failed the
tool's own schema every single time. A multi-select recording could never run,
and nothing said why. Recording reads the page first, so a recording task is
almost always tainted, which is the branch that had no list case — the defect
applied to essentially every multi-select and tab-group recording ever made.

## Element bindings and provenance

A step may name an element declaratively — a role, an accessible name,
optionally a position and an expected state — and the binding is re-resolved
against a fresh page read at replay. That is what specification §49 asks for:
`click button "Save"` rather than a brittle `div:nth-child(7)`.

A click's argument is an element handle such as `e1-12`, valid only within the
page read that minted it. A replay reads the page again, which starts a new
snapshot, so a stored handle is refused as stale every time — measured in real
Chromium, not assumed. The handle is therefore **never stored**. What is
stored is a description of the element, built from what the tool reported
about the node it had already resolved in order to act on it.

That report is the whole mechanism, and it is a property of each interaction
tool rather than of the recorder. A tool that does not report the node it acted
on cannot be recorded: the recorder has nothing to build a binding from, so the
step is left out and the recording is then incomplete and refuses to replay
entirely. All six interaction tools report it — `browser.click`, `browser.type`,
`browser.select`, `browser.select_many`, `browser.set_value` and
`browser.set_checked`. `set_checked` was the one that did not, which meant
checkboxes and radio buttons were silently unrecordable until an E2E case went
looking; the test that found it fails again if the report is removed.

### Provenance is a separate property from validity

The description came out of a page, so it is tagged as having come out of a
page, and stays tagged:

```
provenance: 'PAGE_DERIVED'
purpose:    'ELEMENT_BINDING'
```

Both are required and non-optional, so an untagged page-derived binding cannot
be represented — there is no default to fall through to.

The tag never changes. Passing ARIA validation, secret detection, a length
check, a shape check or a uniqueness check gates **whether the binding may be
stored at all**. None of them says the value came from anywhere but a page, so
none of them makes it authored, untainted, trusted or privileged. An
ARIA-valid role read from a page is page-derived; an identical string typed by
a build author into a bundled skill is not. Same bytes, different fact, and
the fact is recorded at the point of origin rather than inferred from the
bytes.

`PAGE_DERIVED` is deliberately **not** a fourth state in the task taint
lattice. Taint is a property of a task and is compared throughout the
codebase; adding a state to it would make every one of those comparisons a
question again. This is a narrower property of one field of one binding type,
read by the code that stores and resolves it and by nothing else.

### Why storing it is not an exception to the taint model

The rule that a tainted value does not become a stored literal is unchanged
and has no carve-out, because an element binding **is not a literal**. A
literal supplies a value to a tool argument. A binding supplies nothing: it is
a match predicate, and what reaches the tool is a handle minted by the
replay's own page read. The stored strings are operands of an equality test.

So the persistence rule is a rule about a different category:

> A `PAGE_DERIVED` value may be persisted **only** as the match predicate of
> an `ElementBinding` tagged `ELEMENT_BINDING`, and never as, or inside, a
> literal binding, an input default, an output declaration or any other field.

Enforced in three independent places: the parameteriser produces a distinct
`element` outcome that the literal-producing path never sees; the store
refuses a tag outside a binding, and a binding that lost its tag, before
anything reaches disk; and the same check runs again at every replay.

### What the stored values may and may not do

`role`, `name`, `nth` and `expect` may be compared for equality against a
fresh page model, and displayed in the workflow review surface. That is the
whole list.

They never become a tool argument, a CSS selector, an XPath, a
`querySelector` argument, a `RegExp`, an input to risk classification, policy
or the permission engine, part of a destination URL, part of an egress
payload, an audit or evidence field, or model context. They are not shown in a
permission prompt either: a prompt is where someone makes a trust decision
quickly, and page-controlled text there invites a button named
`Cancel (safe)` to read as reassurance. Prompts keep their extension-authored
wording.

### What is bindable, and what fails closed

A role is page-controlled — a page sets `role="anything"`, and an element with
no mapping reports its tag name — so only a closed list of roles a recorded
interaction can meaningfully target is bindable. A name must be non-empty, at
most 64 characters, free of selector and scheme syntax, and must pass secret
detection. The element must have been unambiguous when the recording was made.

Anything else and the step is not recorded. Resolution then fails closed at
replay on: no match, more than one match without a position, a match not in
the required state, a stale or malformed page read, a missing or invalid
provenance tag, and a candidate whose _current_ name looks like a credential —
re-checked against the page as it is then, so a page that has since put a
token into a label does not have it read back into a comparison.

The match count recorded when the click happened is a fact about that page and
grants nothing. A replay recounts the candidates against the page in front of
it.

## Recordings that are missing something

When the recorder watches a step it cannot write down, it keeps the gap: what
it was, why, and where it was, persisted with the record rather than reported
once at save time.

That matters because a workflow missing a step does something materially
different from the task it came from. Dropping the click out of "navigate,
click Login, read" leaves something that completes successfully having never
logged in. So the review surface shows the gap in position:

```
Step 1: browser.navigate
Step 2: [NOT RECORDED] browser.click
        Reason: the element's name looked like it contained a credential
Step 3: browser.read_page
```

and **a workflow with any gap cannot be replayed at all**. Not the subset, and
not with a success status. Record it again.

## Identity and integrity

The store owns three things no caller may supply: the canonical form of a
definition, its hash, and its version. A caller that could hand in a hash could
hand in one computed over something else.

Renaming a workflow leaves its hash alone. Changing a step, an argument or a
declared tool produces a new canonical form, a new hash, a new version and a
full revalidation — there is no in-place edit that would leave a hash
describing something the record no longer holds.

Before every replay the store re-derives the hash from what is on disk and
compares. A record that does not match was altered underneath the store — by a
partial write, or by something editing extension storage directly — and is
refused rather than run.

## Replay

Replay revalidates first, and fails closed on every one of:

- a workflow that no longer exists
- a stored format this build cannot read
- a record that fails its integrity check
- a definition that no longer validates
- a tool that has since been removed
- a tool whose schema no longer accepts the arguments the recording holds
- a required input that was not supplied

Only then does it build the definition into the value `SkillRunner` already
takes and hand it over. From that point a replayed step is an ordinary
dispatch: schema validation, argument-aware risk classification, policy, the
permission prompt, the egress gate, sanitisation and evidence — per step, not
per run. There is no second execution path and no second security path.

A replay runs as a task of its own, so it is visible, cancellable and on the
audit trail like any other work. Two things about that task are worth knowing:

- It records **no provider**. A replay consults no model, so claiming one would
  be false — and it is a property worth being able to read off the record, because
  it means no model output chose any of its arguments.
- It starts **clean**. It is a new task that has read nothing; inheriting the
  recording task's taint would be inheriting a fact about a different run.

Three consequences of re-adjudicating per step, each of which is a real-browser
test rather than a claim:

- **The site is the one the tab is on now.** A standing grant earned while
  recording does not travel: replaying the same recording on a second origin is
  judged against that origin and prompts where the granted one does not. Shown
  on the _same_ markup served under a second hostname, so the page cannot be
  what makes the difference.
- **The risk is what the step reaches now.** A field that has become a
  national-identifier or API-secret field confirms at R3 even in the permission
  mode that asks for nothing, and one that has become a password or
  one-time-code field is denied without a prompt. Neither is written anywhere in
  the record; both are computed from the page read the replay itself performed.
- **The stored risk is a floor, not a prediction.** What the review surface
  shows for a recording is the maximum of its tools' _declared_ risks. An
  escalation that depends on the arguments — `browser.type` with `submit`, or a
  sensitive field — can only be computed against a live page, so a recording
  that will submit a form is listed at R1 and prompts at R2 when it runs. The
  floor therefore understates a review screen and never an authorization.

## The observation hook

The recorder learns what happened through a hook on `ToolRegistry.dispatch`
that is an observer and nothing else. It is called after the result exists, on
a path the return value does not depend on, and anything it throws is caught.

What it is handed is a derived record — task id, tool call id, tool name, a
deep-cloned and recursively frozen copy of the validated arguments, the risk,
whether the call executed, and its status. It carries no live reference to the
invocation or the result, and no security, policy, permission, consent or
evidence state. There is nothing in it an observer could act on, so an observer
cannot modify a decision, grant or revoke authorization, alter an egress,
dispatch another tool, retry, or cancel an already-authorized execution.

## Audit

A replay is recorded by workflow id, version and definition hash, with its
outcome. Never by its steps, its arguments or anything they produced.

## Scope

Recording and replay cover navigation, page reads, element interactions, and
tab and connector steps. Every interaction tool this build ships is recorded
and replayed against a real browser: a click, a checkbox, a radio group, a
single-select dropdown, a multi-select listbox, the structured inputs of P-006,
and a text field that submits.

### What is left

Two things, both named rather than implied:

- **A multi-connector workflow.** Specification §44 names a reference workflow
  spanning four services. None of those connectors exists (see P-023), so the
  workflow cannot be recorded against anything real. This is the only remaining
  item that is blocked externally rather than by effort.
- **The §85 A–F manual acceptance scenarios**, which are unmet for every
  capability in this repository, not only this one.

And one thing that is a stated position rather than a gap: the risk a review
surface shows for a stored recording is the maximum of its tools' _declared_
risks. That is a floor. An escalation that depends on the arguments — a form
submit, a field that has become sensitive — can only be computed against a live
page, so it appears when the step runs and not before. The floor therefore
understates a review screen and never an authorization.

P-022 is recording and replay, and nothing else. It does not add Web AI
inference, provider-site automation, MCP, plugins, remote execution, a
marketplace, cloud sync or sharing. It added no Chrome permission and no host
access: the manifest is unchanged.

P-022 being complete is a statement about P-022. It is not a claim about
overall product parity — see [`PARITY_MATRIX.md`](../PARITY_MATRIX.md) for
where the product actually stands.
