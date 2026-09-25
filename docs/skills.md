# Skills

A skill is a reusable workflow: an ordered list of steps, each naming a tool
that is already registered, with arguments assembled from values the
definition states and outputs earlier steps produced.

It is **structured data**. Not a script, not a plugin, not an MCP server, and
not a source of authority.

## What a skill cannot be

There is no expression language here, no template interpolation, no callback,
and no string that is ever parsed as code. A step cannot say "run this
JavaScript", because there is nowhere in the types to put JavaScript and
nothing that would execute it if there were.

That distinction matters. The absence of a scripting engine is not a policy
that could be relaxed later — it is a shape the data does not have. A literal
carrying a function, a class instance or a `RegExp` fails registration, because
a literal with behaviour is not a value a definition may hold.

| Not supported                  | Why                                                                  |
| ------------------------------ | -------------------------------------------------------------------- |
| JavaScript / TypeScript bodies | arbitrary code is the thing the whole architecture exists to prevent |
| Python, shell                  | same, and neither exists in a browser extension                      |
| `eval`, `Function`             | a test asserts the skill tree contains neither                       |
| Dynamic `import()`             | likewise; nothing is fetched and run                                 |
| Remote skill packages          | there is no loader, no installer, and no URL anywhere                |
| WASM from a skill              | nothing in a definition is executable content                        |

A test walks every file under `src/skills/` and `src/tools/skills/` and fails
if any of them gains an evaluator, a `fetch`, an `XMLHttpRequest`, a
`sendBeacon`, a `WebSocket` or a filesystem import.

## Not a second execution path

This is the design constraint everything else follows from.

A workflow is "several privileged things in a row", and the obvious
implementation is an engine that runs them. That engine would be a second path
to a real effect, and a second path is a bypass whatever its author intended.

So there is no second path. Every step goes through `ToolRegistry.dispatch`,
which is the same function the agent runtime calls for a model-proposed tool
call:

```
skill step
    ↓
ToolRegistry.dispatch
    ↓
schema → risk → policy → permission → egress → execute → sanitise → evidence
```

A skill therefore has no way to reach the network, the filesystem, a page or a
credential except by naming a tool that already can — and that tool already
guards it.

### Per step, not per run

Running a skill costs **an approval for the run, plus whatever its steps would
have cost on their own**. The run-level prompt names the workflow; the
step-level ones name the actual action and its destination. Neither substitutes
for the other.

Measured in real Chromium: running a two-step navigate-and-read workflow in
manual mode produces prompts for `skills.run` **and** `browser.navigate`.
Approving the workflow and then declining the navigation inside it stops the
run and leaves the browser where it was.

That is the failure mode a workflow feature invites — bundling risky steps
behind one click — and it is the one thing the design will not do.

## A skill is trusted because it shipped

`src/skills/bundled/index.ts` is the trust boundary made concrete. A skill is
trusted because it is in that file: reviewed as source, shipped in a build,
changeable only by editing it and releasing.

`provenance` is the check that makes this real. Only `bundled` registers;
`model_proposed`, `imported` and `unknown` are refused. A model can produce a
`SkillDefinition`-shaped object — it just cannot produce a registered one.

| Source                        | Can register a skill                        |
| ----------------------------- | ------------------------------------------- |
| The extension's build         | yes                                         |
| Model output                  | **no**                                      |
| Page content                  | **no**                                      |
| Connector output              | **no**                                      |
| Provider output               | **no**                                      |
| A message from the side panel | **no** — there is no `skill.register` route |

There is deliberately no remote installation, no ZIP package and no URL
loader. If installation is ever wanted it needs its own security design, not
an extra parameter here.

## What the model can and cannot do

The model can list the available skills and ask to run one by id, with values
for its declared inputs. That is the whole surface: `skills.list` and
`skills.run`, both ordinary tools in the ordinary registry.

`skills.run` takes an **id**, never a definition. Nothing in its schema accepts
steps, tools or code, so an unknown id is refused rather than created. In real
Chromium a model asking for `exfiltrate.everything` gets `TOOL_NOT_FOUND` and
the registry still holds exactly the three bundled skills.

## Validation at registration

A definition is checked when it is registered, not when it runs, and every
problem is reported at once rather than one per attempt.

| Refused                                                | Because                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| A step naming a tool that is not registered            | a skill cannot bring a capability into being by naming it            |
| A tool used but not in `requiredTools`                 | least privilege is only checkable if intent is written down          |
| A tool declared but never used                         | privilege asked for and not needed                                   |
| `admin`, `root`, `bypass`, `all`, `*` …                | none corresponds to anything the permission system grants            |
| A binding reading a step that runs later               | forward references — and therefore cycles — are inexpressible        |
| A path through `__proto__`, `constructor`, `prototype` | `a.constructor.constructor` is the route to the Function constructor |
| A literal that is not plain JSON                       | where "no code in a skill" stops being a convention                  |
| A skill composing itself, or a composition cycle       | unbounded recursion                                                  |
| More than 24 steps, or composition deeper than 3       | a bounded graph                                                      |
| A version that is not `major.minor.patch`              | an invocation has to bind to something exact                         |

## Risk

A skill's declared risk is a **floor, not a cap**. The effective risk is the
highest of that floor and every tool the skill reaches, composition included —
so understating it makes a skill stricter to approve, never laxer, and a skill
that composes a deleting skill deletes.

`skills.run` classifies from the registry rather than from itself: the risk of
running a workflow is a property of the workflow named in the arguments. A tool
the registry cannot price is assumed to be R3, because guessing low would be
the wrong way to be wrong.

## Bindings

Three sources, all data:

| Binding   | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| `literal` | a value written in the definition                        |
| `input`   | a value the caller supplied                              |
| `step`    | a value an earlier step returned, at a plain dotted path |

There is deliberately no fourth. No concatenation, no arithmetic, no
conditional, no format string — each would be a small language, and a small
language is what grows into an interpreter.

A binding whose source produced nothing yields an absent argument, and the
tool's own schema then refuses the call. That is the correct outcome and it
needs no conditional to express: the GitHub workflow reads "the first match",
and a search that matched nothing simply fails at the read.

### Reading a result is not reading untrusted text

`github.search_issues` returns issue titles and bodies wrapped as untrusted
external content, and nothing mechanical parses that. It separately returns
`numbers`: the matched issue numbers, as validated integers. A workflow binds
on those.

The distinction is the point. An integer the service assigned cannot carry an
instruction; a title a stranger wrote can. A binding reads the former.

## Taint

A skill preserves task taint and only ever grows it.

Taint accumulated by one step is carried into the next, so a later step's
egress decision accounts for what an earlier one read — and the consent
signature is recomputed per step rather than reused from before the taint grew.
Everything a run acquired is reported back so the **task** ends up carrying it;
the run does not keep it to itself.

There is no field in a definition in which to declare a skill untainted,
trusted, or exempt. `UNKNOWN` stays `UNKNOWN`: a task whose provenance could
not be established cannot send anything outward from inside a workflow any more
than from outside one.

## Egress

Skills do not get their own egress system. A step that transfers data uses the
tool that declares that transfer, and the tool's declaration reaches
`authorizeEgress` exactly as it would outside a workflow.

A definition cannot say "bypass consent", "allow all domains" or "skip policy",
because there is no field for it — a step names a tool, and the tool declares
its own destination when it is classified.

## Connectors and providers

A skill reaches a connector only through that connector's registered tools, so
the credential stays inside the connector boundary and the response comes back
wrapped as untrusted external content. There is no skill-to-raw-HTTP path.

Likewise for AI providers: a skill has no way to reach one except through the
existing provider architecture and its guarded transport.

**D4 and D5 remain gated.** No skill submits a prompt to an AI website, reads a
model response from one, or touches a private provider endpoint. Nothing in
this wave opens either.

## Budget, cancellation and failure

A skill gets **no budget of its own** — it spends the task's, read live, because
a second budget is a way past the first. A run that finds nothing left stops
partway rather than continuing.

Cancellation is checked before every step and handed to every dispatch, so a
cancelled task starts no further work. A step that fails stops the run unless
the definition marked it `optional`, because the rest of the skill assumed
something that is not true and continuing would be guessing.

A retry is a new run. Nothing is carried forward from a previous attempt — two
runs of a workflow with a risky step cost two approvals.

## Persistence

A run record holds identifiers, a step index, the task's taint state and
timestamps. That is all.

It deliberately holds **no step results, no arguments, no page text, no file
contents and no credentials** — not because a caller is trusted to leave them
out, but because `SkillRunRecord` has nowhere to put them and `assertRecordSafe`
refuses a record that grew a field anyway. A skill's intermediate results can
contain anything the task has read; writing them to disk so a run could resume
would turn a workflow feature into a second, unaudited copy of the page.

The consequence is deliberate: **an interrupted run is not resumed.** At worker
startup every record still marked `running` is marked `interrupted`, so nothing
later concludes that something is still executing it. Resuming would mean
re-deriving a later step's arguments from an earlier step's result, and that
result is gone by design.

`assessResume` states what would have to hold for a resume to be safe, and
refuses on any of:

| Refusal                  | Meaning                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `NO_RECORD`              | nothing to resume                                                                          |
| `NOT_INTERRUPTED`        | it is running, finished or cancelled                                                       |
| `SKILL_GONE`             | the skill is no longer registered                                                          |
| `VERSION_CHANGED`        | a different version now answers to that id                                                 |
| `HASH_CHANGED`           | same id and version, different definition — an edited skill shipped without a version bump |
| `SECURITY_STATE_UNKNOWN` | what the task had read cannot be established                                               |

## The definition hash

A SHA-256 over the canonicalised definition — steps, bindings, declared tools,
risk — with object keys sorted so formatting cannot change it. Renaming a skill
does not change its hash; changing a step does.

It is used for audit, for provenance on a run, and to notice that a definition
changed under a run that was already in progress.

It is **not an authorization mechanism**. A matching hash says a definition is
the one recorded earlier; it says nothing about whether it was ever trusted, and
a hash presented by a caller proves nothing at all. Trust comes from the
registry, which holds only bundled definitions. The registry computes the hash
itself at registration, so every later comparison is between two values this
extension produced.

## Audit

Recorded: which skill ran, at what version and hash, which step, what it ran,
the permission and egress decisions, cancellation, retry and final status.

Not recorded: the run's inputs, its step results, its outputs, or anything they
contained. The audit log refuses a record carrying any of them — at any depth,
through objects and arrays alike — for the same reason the run store does.

Being precise about what that check is: it is a **denylist of field names**,
applied recursively, on top of a closed `AuditEvent` type. It is not a content
filter. A caller that invented a benign-sounding field and put a page's text in
it would not be refused; what stops that is the type having no such field.
Credentials are defended more heavily — redaction is recursive and matches the
_value_ as well as the name, so a token under any name at any depth is stored
as `[REDACTED]`.

The recursion was added during post-implementation verification. The check was
top-level only, so `{ detail: { inputs: pageText } }` reached the store
verbatim. No credential was ever exposed by it, and the closed event type meant
no shipped call site produced such a record — but the control did not do what
this document claimed it did.

## What ships

| Skill                  | Risk | Steps | Reaches                                                     |
| ---------------------- | ---- | ----- | ----------------------------------------------------------- |
| `page.inspect`         | R0   | 3     | `browser.read_page`, `debugger.console`, `debugger.network` |
| `page.open_and_read`   | R1   | 2     | `browser.navigate`, `browser.read_page`                     |
| `form.fill_and_submit` | R2   | 3     | `browser.type`, `browser.wait`, `browser.read_page`         |
| `github.find_issue`    | R1   | 2     | `github.search_issues`, `github.read_issue`                 |

Three of the four are read-only. `form.fill_and_submit` is the exception and it
is deliberately the smallest write there is: it types into a field the caller
already has a handle for and submits the form around it, using
`browser.type` — which escalates itself from R1 to R2 when asked to submit —
and nothing else. No new tool, no new permission, no connector.

What it is not is an easier path to a write. The skill's declared R2 is the
risk of _starting_ it; each step is dispatched on its own and meets its own
policy decision, so approving the skill does not approve the write inside it,
and declining the write stops the write without stopping the steps that already
ran. What the field turns out to be is decided when the write runs, not when the
skill was written: a password or one-time-code field refuses outright, and a
national-identifier or API-secret field confirms at R3 whatever the permission
mode says.

A workflow that writes to an external _service_ — "file a bug" — is still a
reasonable thing to want and a bad thing to make the easiest path through a
young feature. It would be irreversible and publicly visible, so writes to a
service stay individually requested.

## Switching a skill off

Every shipped skill is enabled, and the user can switch any of them off in
Settings. The choice is durable and survives a worker eviction.

What makes it a control rather than a filter is where it is enforced.
`SkillRegistry.get`, `latest` and `list` all answer as though a disabled skill
were not registered, so it is gone from the model's listing, from `skills.run`,
from the panel's launcher, from a shortcut resolving its target and from a
schedule checking one — at once. A build that filtered only the listing would
leave a model able to run a skill it was never shown, which is the version of
this feature that looks identical in the settings screen and is not a control
at all.

Five things can start a skill run, and all five read through that one seam: the
model's `skills.run`, the panel's launcher, a shortcut, a schedule, and a step
inside another skill. The last one means switching a skill off also stops
anything that composes it, including partway through a run that had already
started. A recorded workflow is the sixth and the exception: it carries its own
definition, validated against its own hash, and never consults the registry, so
switching every skill off does not switch a replay off.

The settings surface has a read of its own — `getIncludingDisabled` — because
offering to turn something back on requires showing it. It is consulted in
exactly three places, and how many is asserted from source, because "one
enforcement point" is a claim about today unless something counts it.

When a shortcut or a launch names a skill that is switched off, it says so
rather than reporting the target missing. Those are two different facts and only
one of them is actionable — the earlier message sent people looking for
something that was sitting in Settings with its toggle off. The distinct message
is chosen only after the enforcing read has already refused, so knowing why is
never a way in.

Nothing here installs, obtains or changes a skill. The only decision is whether
one the build already shipped, already validated and already hashed is
available.

## Workflow recording (P-022) — the contract it must obey

Implemented, in `docs/workflows.md`. The contract below was fixed before it was
built and still holds; it is kept here because it is the shape a _change_ to
recording has to keep, not a description of unwritten work:

```
recorded workflow
    → the existing validator
    → the existing registered tools
    → ToolRegistry.dispatch
    → the existing security controls
```

It must **not** introduce a second execution engine. A recording is a
`SkillDefinition` like any other, so:

- it validates through `validateSkillDefinition`, with no relaxation for having
  been recorded rather than written;
- every step names an already-registered tool, and recording one does not
  create it;
- it carries no code, and a recorded value is a literal or a binding, never an
  expression;
- it earns no trust from having been performed. A user doing something by hand
  once is not a grant to do it unattended later, so a recording is never
  registered at all: the only registering provenance is `bundled`, and a
  recording lives in its own store and runs only through an explicit replay;
- replay is a fresh run: it re-enters every gate, carries no approval forward,
  and is subject to the same per-step permission and egress evaluation.

If recording ever needs a run to be _resumed_ rather than re-run, that is a
separate capability with its own design: the current run record deliberately
holds no step results, and the reason is above.

## What skills did not add

No new manifest permission, no new host access, no `<all_urls>`, and no
`identity`, `cookies`, `webRequest`, `management` or `nativeMessaging`. A skill
reaches exactly what the tools it names already reached.
