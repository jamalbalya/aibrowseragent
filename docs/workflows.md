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

| Captured value                                | Stored as                       |
| --------------------------------------------- | ------------------------------- |
| A URL a clean task navigated to               | a literal                       |
| A `submit` flag, an element handle            | a literal — structure, not data |
| Anything credential-shaped, at any provenance | a slot, asked for at replay     |
| A long value from a task that had read a page | a slot                          |
| Anything from a task with unknown provenance  | nothing; the step is dropped    |

A slot's description says what to supply. It never quotes what was captured,
because the captured value is the thing that must not reach disk.

## Element bindings, and what is not recorded yet

A step may name an element declaratively — a role, an accessible name,
optionally a position and an expected state — and the binding is re-resolved
against a fresh page read at replay. That is the whole vocabulary. There are no
CSS selectors, no XPath, no `javascript:` URLs, no callbacks and no
expressions; a role is validated as an ARIA token rather than merely checked
for selector-looking characters. A binding resolves to nothing — which fails
the step closed — when the page has no match, when it has more than one and the
binding did not say which, when the match is not in the state the binding
requires, or when the page read is stale or malformed. Nothing is guessed, and
there is no positional fallback.

**Clicks, typing and other element interactions are not recorded yet.** This is
a real gap against specification §49, which asks for recorded actions to be
converted into semantic ones — `click button "Submit"` rather than a brittle
`div:nth-child(7)`. The binding shape above is that semantic form, and both the
validator and the runner support it; what is missing is the conversion at
record time.

The obstacle is specific. A click's argument is an element handle such as
`e1-12`, which names an element within one page read. A replay reads the page
again, which starts a new snapshot, so a stored handle is refused as stale
every time — measured in real Chromium, not assumed. Converting it to a role
and a name needs the `browser.read_page` result that minted it, and a dispatch
observation deliberately carries no result.

So a step naming an element is **left out of the recording**, with a reason
shown next to it, rather than stored in a form that could never run. Recording
a task that clicks produces a workflow of the steps that can replay, and says
plainly which ones it dropped. What recording covers today is navigation, page
reads, tab and connector steps.

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

Recording and replay work for navigation, page reads, and tab and connector
steps. Element interactions are not recorded — see above; that is the one
open gap against specification §49 and it is a limitation of the recorder, not
of replay.

P-022 is recording and replay, and nothing else. It does not add Web AI
inference, provider-site automation, MCP, plugins, remote execution, a
marketplace, cloud sync or sharing. It added no Chrome permission and no host
access: the manifest is unchanged.

P-022 being complete is a statement about P-022. It is not a claim about
overall product parity — see [`PARITY_MATRIX.md`](../PARITY_MATRIX.md) for
where the product actually stands.
