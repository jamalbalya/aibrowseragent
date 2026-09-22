# Shortcuts (P-021)

A shortcut is a **name** for something you already have. Type `/qa-regression`
in the composer and it runs the workflow or built-in workflow you gave that
name to.

That is the whole feature, and the narrowness is the point.

## What a shortcut is not

A shortcut is **not a script**. It holds a name and a reference — a workflow
id, or a skill id and version — and nothing else. There is no field for steps,
tool arguments, a prompt, a selector or code, because a shortcut is not a
thing that runs. It is a thing that names something that runs.

A shortcut is **not a prompt template**. `/summarize-page` does not expand into
text that gets sent to a model. It resolves to an id, and that id is looked up
in the store or the registry that owns it. Nothing a shortcut holds is ever
parsed, interpolated or evaluated.

A shortcut is **not a permission**. It adds no execution path: what it points
at runs through the route that already existed for that kind of target, with
every gate re-applied. Naming something does not pre-approve it, and the
confirmation you see before it runs is not an authorization either — see
below.

A shortcut is **not model-reachable**. There is no `shortcut.*` tool and no
`shortcut.run` route. A model cannot create, change, delete, choose or invoke
one, and shortcuts never appear in `skills.list` or in the tool schemas a
model is offered.

## What happens when you type one

```
/qa-regression
  → the name is normalised
  → looked up, exactly
  → the target is checked: does it still exist, can it still run
  → you are shown what it means
  → you confirm
  → workflow.replay  or  skill.run
  → the normal pipeline: risk, policy, permission, egress, evidence, execution
```

Everything up to the confirmation is a **read**. Resolving a name runs nothing,
starts no task and takes no side effect, which is why it is safe to do while
you are still typing.

### The confirmation

Before anything starts you are shown the shortcut you typed, the kind of thing
it found, and that thing's own name. Those three facts are what separate the
shortcut you meant from one you mistyped.

It is deliberately **not** a security decision. It answers "which reviewed
thing is about to start", not "may it do what it does". Every permission,
policy and egress decision the target would have faced, it still faces, step by
step, once it starts. Confirming here buys none of them.

It also deliberately does not show a step list. That would be a second,
abbreviated review surface competing with the real one, and the place to
inspect what a workflow does is the review surface that already exists for it.

## Names

A name is an identifier, not a pattern. There is no glob, no fuzzy match and
no regular expression applied to what you type. A name either equals a stored
one after normalisation, or it does not exist — there is no nearest match.

Normalisation is fixed and idempotent:

1. NFKC, so a compatibility spelling is not a second name.
2. Trim, strip leading slashes, trim again.
3. Case-fold to lowercase.
4. Whitespace and underscores become single hyphens; repeated hyphens
   collapse; leading and trailing ones go.
5. What is left must be lowercase letters, digits and single hyphens between
   them, at most 48 characters. Anything else is refused rather than repaired.

So `/QA-Regression`, `qa_regression` and ` //qa   regression` are all the
same name. That is the point — but it is also the risk, which is why:

### Collisions are refused, never merged

If a new name normalises onto an existing one, creating it **fails** and you
are told which name it clashed with. It is never merged into the existing
shortcut and never silently renamed. Two distinct choices must not become one
executable shortcut, because then one of them silently runs the other's target.

The same applies to names that merely _look_ alike. `dep1oy` and `depl0y` read
as `deploy` in most interface fonts, and a person confirming the wrong one has
confirmed the wrong target. A confusability key — digit and letter lookalikes
folded together, hyphens ignored — is computed for every name and must also be
unique.

That key is used for **one thing only: deciding whether a new name may be
created.** Nothing is ever looked up by it. Two genuinely different names can
share one, and resolving through it would run something you did not name.

Non-ASCII characters that render as Latin letters — Cyrillic `а`, Greek `ο` —
are refused outright, with a message saying so rather than a generic syntax
error.

## Targets

A shortcut may point at a **stored workflow** (P-022) or a **bundled skill**
(P-024). Nothing else: not an arbitrary tool, not a tool with arguments, not a
definition of any kind.

Targets are checked when a shortcut is created **and** again every time it is
resolved. Passing the first check says nothing about the second, because a
target that exists today can be deleted tomorrow.

Resolution fails closed on all of:

- the workflow was deleted
- the workflow is missing steps it watched, so P-022 will not replay it
- the skill is not registered, or not at the pinned version
- the stored record is malformed, or from a format this build cannot read
- the target kind is one this build does not understand

A shortcut whose target is gone stays listed and marked unusable, so you can
see it and remove it — silently deleting the name would hide that it ever
existed. It resolves to nothing and runs nothing. It never falls through to
another target, by name, by recency or by anything else.

A skill target pins an exact version. A shortcut never floats to a newer one:
that would be the target changing under a name you already approved.

## Running a built-in workflow

A shortcut can name a bundled skill, and a shortcut is a user action — so
there is a user-initiated route to run one, `skill.run`, alongside the
`skills.run` tool a model uses. Both reach the same `SkillRunner`, and every
step dispatches through the one `ToolRegistry.dispatch`. What differs is only
who asked. It takes an id and a pinned version, never a definition, and being
a panel route rather than a tool is what keeps it out of a model's reach.

## Scope

P-021 added no Chrome permission, no host permission and no execution
primitive. The manifest is unchanged.

P-021 being implemented is a statement about P-021. It is not a claim about
overall product parity — see [`PARITY_MATRIX.md`](../PARITY_MATRIX.md) for
where the product actually stands.
