# Plugin trust model (P-025 design gate)

**Status: design only. Nothing here is implemented.** No plugin loading,
installing, updating or running exists in this build, and this document does
not authorise writing any. It exists so that the question "can plugin and MCP
capability enter the existing security pipeline without creating a bypass?" has
an answer that can be reviewed before code makes it moot.

The benchmark position is recorded in
[`CLAUDE_BENCHMARK.md`](./CLAUDE_BENCHMARK.md) §4 and is **E2** — documentation
about a related product, not observation of the shipping extension. A plugin
there _"bundles skills, connectors, and sub-agents into a single package"_, may
include _"local MCP servers that run on your computer with the same permissions
as any other program you run"_, installs from a marketplace, a git URL or a
custom upload, auto-updates, and delegates the trust decision to the user —
_"Only install plugins from sources you trust"_.

That last sentence is the whole problem. It is a reasonable position for a
product that can execute code the user chose to trust. This project is locked
against native messaging, local process execution and arbitrary JavaScript
evaluation, and its Content Security Policy is `script-src 'self'` with no
`unsafe-eval`. So "the user decided to trust it" cannot be converted into
"therefore it may run", because there is nothing here that can run it. The
model below is what remains once that is taken seriously, and it turns out to
be smaller than the roadmap implies rather than larger.

---

## 0. The finding this document exists to record

**A plugin, as this architecture can safely support one, is a shape the
repository already has.**

A `RecordedWorkflow` is: a declarative step list, over tools that are already
registered, carrying no code, identified by a hash the store computes itself,
never entered into the skill registry, invisible to the model, runnable only by
an explicit user action, and re-adjudicated per step at every run. Every one of
those properties is a property a plugin needs. The differences between a
recorded workflow and a plugin are **provenance** (it came from somewhere else)
and **origin** (something has to say where), not execution.

This matters for scoping P-025: the expensive part of a plugin system is the
runtime, and this architecture does not need one. What it needs is a package
format, a provenance that is not `bundled`, and the conditions under which that
provenance is accepted. Sections 2 to 8 are almost entirely about that third
thing.

---

## 1. The objects, and what each one has to carry

Seven object kinds are named in the benchmark and the specification. Three
exist in this build, two exist as ideas with no representation, and two are
P-026's problem. Every row states what the object would have to carry to be
admissible; a row with "n/a" is not an omission but a statement that the
property does not apply to an object of that kind.

| Property                    | PLUGIN                                             | SKILL                                            | CONNECTOR                                | SUB-AGENT          | MCP-SERVER                           | MCP-TOOL                       | MCP-RESOURCE                                     |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- | ------------------ | ------------------------------------ | ------------------------------ | ------------------------------------------------ |
| **Exists today**            | no                                                 | **yes** (`SkillDefinition`)                      | **yes** (`ConnectorDescriptor`)          | no                 | no                                   | no                             | no                                               |
| **Identity**                | `pluginId` + version, package-unique               | `id@version`, registry-unique                    | `descriptor.id`, registry-unique         | would be a task id | server id + origin                   | server id + tool name          | server id + URI                                  |
| **Source**                  | local file the user supplied                       | the build                                        | the build                                | n/a                | an HTTPS origin                      | inherited from its server      | inherited from its server                        |
| **Provenance**              | `user_installed` (new)                             | `bundled` in the registry, `recorded` outside it | `bundled`                                | n/a                | `user_declared`                      | `server_declared` (untrusted)  | `server_declared` (untrusted)                    |
| **Version**                 | semver, immutable once installed                   | semver, immutable                                | implicit in the build                    | n/a                | server-reported, advisory only       | server-reported, advisory only | server-reported, advisory only                   |
| **Integrity**               | SHA-256 over the canonical package                 | `skillHash` over canonical JSON                  | the build's own integrity                | n/a                | TLS + declared origin only           | none obtainable                | none obtainable                                  |
| **Trust state**             | §2                                                 | implicit `VALIDATED` (it shipped)                | implicit `VALIDATED` (it shipped)        | n/a                | §2                                   | §2, per tool                   | not trusted, ever                                |
| **Enabled state**           | per plugin                                         | **exists** (`SkillEnablementStore`)              | implicit in connection state             | n/a                | per server                           | per tool                       | n/a                                              |
| **Lifecycle state**         | installed / disabled / revoked / removed           | registered                                       | disconnected / authorizing / connected   | task lifecycle     | declared / reachable / unreachable   | n/a                            | n/a                                              |
| **Permission declaration**  | the union its contents declare, restated           | `requiredTools`, `requiredConnectors`            | `apiOrigins`, scopes + rationale         | n/a                | origins it may be called at          | its own risk, assigned locally | n/a                                              |
| **Risk declaration**        | a floor; never a cap (§6)                          | a floor (`risk`)                                 | per operation                            | n/a                | a floor for every tool it offers     | a floor, assigned by **us**    | n/a                                              |
| **Dependencies**            | connectors and tools by name, never bundled        | tools, composed skills                           | none                                     | n/a                | none                                 | its server                     | its server                                       |
| **Data classification**     | `USER_SELECTABLE` (like `workflow`)                | in the build, so not persisted as data           | `connector-token` is `SECRET_LOCAL_ONLY` | n/a                | `USER_SELECTABLE`                    | n/a                            | **`NEVER_PERSISTED`** — it is page-class content |
| **Egress classification**   | none of its own                                    | none of its own                                  | its `apiOrigins`, through the one gate   | n/a                | its origin, a declared destination   | its server's origin            | inbound only; taints the task                    |
| **Credential requirements** | **none, ever** (§5)                                | none                                             | OAuth app owned by the build             | n/a                | whatever its origin needs — deferred | n/a                            | n/a                                              |
| **Audit requirements**      | install, validate, enable, disable, revoke, update | run start/finish by hash                         | auth state changes, calls                | n/a                | declare, enable, disable, call       | every call                     | every read                                       |
| **Revocation**              | terminal, per version (§2)                         | n/a (ships with the build)                       | token revocation exists                  | n/a                | remove the declaration               | disable the tool               | n/a                                              |
| **Update/rollback**         | §7                                                 | with the build                                   | with the build                           | n/a                | none — a server changes under you    | none                           | none                                             |

Two rows deserve emphasis, because they are the ones a plausible-looking design
gets wrong:

**MCP-RESOURCE is never trusted and never persisted.** A resource is content
fetched from somewhere on the model's behalf. That is the same category as page
text: it is data that may be adversarial, it taints the task that reads it, and
it must reach the model inside the data envelope the prompt-injection defence
already uses. Treating it as configuration — because it arrived over a
structured protocol rather than from a `<div>` — is the single most likely way
MCP introduces an injection channel.

**MCP-TOOL risk is assigned locally, never accepted from the server.** A server
that could declare its own tool R0 would be a server that could decide it needs
no approval. The server's declaration is a description; the risk is ours.

---

## 2. Trust states

The proposal to evaluate was UNTRUSTED, DECLARED, VALIDATED, TRUSTED, ENABLED,
DISABLED, REVOKED, INVALID. Six survive. Two are rejected, and the reasons
matter more than the list.

### The six

| State         | Means                                                                                                                     | Contents reachable |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **DECLARED**  | A package is present and its manifest parsed. Nothing has been checked against this build.                                | no                 |
| **VALIDATED** | Integrity re-derived here, schema accepted, every referenced tool and connector exists, no prohibited field at any depth. | no                 |
| **ENABLED**   | VALIDATED, and the user has switched it on.                                                                               | **yes**            |
| **DISABLED**  | VALIDATED, and the user has switched it off, or never switched it on.                                                     | no                 |
| **INVALID**   | Validation failed, or integrity no longer re-derives. Terminal for this version.                                          | no                 |
| **REVOKED**   | The user removed trust. Terminal for this version, including after a reinstall of the same bytes.                         | no                 |

### UNTRUSTED is rejected

It is the absence of a record, and modelling absence as a state creates a
stored object that something can later find and promote. The safe shape is the
one `SkillRegistry` already has: a thing either is in the registry or is not,
and there is no method that takes anything but a definition. A plugin that has
not been installed has no record.

### TRUSTED is rejected

There is no authority that a TRUSTED state would grant which VALIDATED plus
ENABLED does not. Its only function would be to mean "and therefore its
contents may be believed", which is precisely the circular authority §8
forbids. A word that invites `if (plugin.trust === 'TRUSTED')` to appear
somewhere other than the one place that decides reachability is a word worth
not having. This is the same reasoning that made `PlanApproval` a separate
object rather than a boolean on `PlanProposal`.

### Legal transitions

```text
(nothing)  --install-->        DECLARED
DECLARED   --validate ok-->    DISABLED        (validated, off by default)
DECLARED   --validate fails--> INVALID         (terminal)
DISABLED   --user enables-->   ENABLED
ENABLED    --user disables-->  DISABLED
ENABLED    --revalidate fails->INVALID         (terminal; checked before every use)
ENABLED    --user revokes-->   REVOKED         (terminal)
DISABLED   --user revokes-->   REVOKED         (terminal)
INVALID    --(none)
REVOKED    --(none)
```

Four properties this graph has on purpose:

1. **A new install lands DISABLED, not ENABLED.** The benchmark's plugins are
   usable once installed; ours are not, because installing is a decision about
   provenance and enabling is a decision about capability, and collapsing them
   means the second is never actually taken.
2. **Only the user moves an object toward reachability.** No transition into
   ENABLED has an automatic trigger. An update does not carry enablement
   forward silently where it widens what the package declares (§7).
3. **INVALID and REVOKED are terminal.** There is no path back. Reinstalling
   the same bytes after a revocation produces the same package identity and the
   same terminal state — otherwise revocation would be a suggestion.
4. **Monotonic with respect to privilege.** No transition grants authority; the
   most any of them does is make contents _reachable_, and reaching them still
   means the whole pipeline. Editing a plugin's metadata cannot move it along
   this graph, because every edge is either a user action or a validation
   result computed here.

---

## 3. Sources

Claude documents four. Each is classified by what this architecture can
actually honour.

| Source                    | Verdict           | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Custom upload**         | **ADAPT**         | A local file the user chose. The file-selection broker already exists (`files.select` is user-mediated, and a file reaches the extension only because a person picked it at a real picker). The adaptation is that what is accepted is a declarative package, not code.                                                                                                                                                                                                                                             |
| **Directory/marketplace** | **DEFER**         | Needs a distribution service, a publisher identity and a revocation feed. This project owns none of them, and inventing a marketplace URL would be the same class of mistake as inventing an OAuth client id. Not rejected on principle — deferred for want of infrastructure.                                                                                                                                                                                                                                      |
| **Git URL**               | **REJECT** for v1 | Fetching a package from an arbitrary origin at install time is an outbound request to a destination the user typed, which the egress architecture would have to treat as a declared destination with consent. That is buildable. What is not buildable is the part that makes it worth doing: a git URL's content is expected to be code, and the reason the benchmark can accept it is a runtime this project does not have. Revisit only if §4's content model is ever widened, which §4 argues it should not be. |
| **Organization library**  | **DEFER**         | Requires managed policy (Chrome enterprise policy) and an organization identity. Neither exists. Note also that the benchmark's org libraries can make a plugin **non-uninstallable**, which conflicts with this product's position that the user's switch is the user's; if this is ever adopted, that conflict has to be resolved explicitly rather than inherited.                                                                                                                                               |

### What a plugin therefore is

The four candidate models were: declarative only; signed/hashed bundle;
sandboxed declarative tool composition; or something the repository already
supports.

**The answer is the fourth, and it turns out to equal the first two combined.**

A plugin is a **hash-identified declarative package whose only active content is
skill definitions over tools this build already registers.** It is the
`RecordedWorkflow` shape with a different provenance. There is no sandbox
because there is nothing to sandbox: a `SkillDefinition` contains no evaluator,
no expression, no selector and no literal with behaviour — `workflow-security`
already asserts all of that from source.

"Signed" is deliberately not part of it. Signing implies a publisher identity
and a key distribution mechanism, and this project has neither; a self-signed
package proves only that whoever produced the bytes also produced the
signature, which the hash already establishes. **Integrity without authenticity
is exactly why the content model must forbid executable content** — a hash pins
what the user approved, but nothing here can tell them who wrote it.

---

## 4. Content model

A plugin package contains:

| Content                 | Allowed                 | Executable                  | May add a tool | May add a permission | May add an egress channel | May add a credential | May alter policy |
| ----------------------- | ----------------------- | --------------------------- | -------------- | -------------------- | ------------------------- | -------------------- | ---------------- |
| **Metadata**            | yes                     | no                          | no             | no                   | no                        | no                   | no               |
| **Skills**              | yes                     | no — declarative steps only | **no**         | **no**               | **no**                    | **no**               | **no**           |
| **Connector refs**      | yes, by id              | no                          | no             | no                   | no                        | no                   | no               |
| **Connectors**          | **no**                  | —                           | —              | —                    | —                         | —                    | —                |
| **Sub-agents**          | **no**                  | —                           | —              | —                    | —                         | —                    | —                |
| **MCP references**      | **no** until P-026      | —                           | —              | —                    | —                         | —                    | —                |
| **Policy declarations** | **no**                  | —                           | —              | —                    | —                         | —                    | —                |
| **Permissions**         | as a _declaration_ only | no                          | no             | no                   | no                        | no                   | no               |

Every "no" in the tool/permission/egress/credential/policy columns is the same
rule stated per column: **a plugin declares what it needs and receives
nothing.** A declaration is checked against what already exists — a skill
naming a tool this build does not have fails validation, exactly as
`SkillRegistry.register` already refuses one — and a plugin whose declaration is
satisfied is still subject to every decision the pipeline takes at run time.

Four contents are excluded outright, and the reasons are not symmetrical:

- **Connectors** need an OAuth application, an origin allowlist, a scope set
  with a written rationale, and a place in the token vault. Every one of those
  is a build-level decision about credentials, and §5 forbids a plugin
  supplying credentials at all. A plugin may _reference_ a connector that the
  build ships and the user has already authorized; that reference grants
  nothing (§8).
- **Sub-agents** have no representation in this architecture. The nearest
  object is a task, and tasks are created by a person, a schedule or a replay.
  A package that could create tasks would be a package that could act without
  anyone asking it to, which is a different product.
- **MCP references** are P-026's, and P-026 has an unresolved transport
  question (§9). A plugin that carried an MCP reference today would carry a
  reference to nothing.
- **Policy declarations** would be a second policy engine by another name. The
  one call site is the one call site.

**The prohibition that carries the most weight:** plugin content must not
create a second execution pipeline. Concretely, and stated so a reviewer can
check it against a diff — a plugin's contents reach execution only through
`SkillRunner`, and every step only through `ToolRegistry.dispatch`. There is no
`plugin.run`, no plugin tool, and nothing a plugin contains is offered to a
model as a callable except through the same `skills.run` a bundled skill uses.

---

## 5. Credentials

**A plugin never carries, requests, receives or is asked for a credential.**

This is not a conservative default; it is forced. `SECRET_LOCAL_ONLY` data —
provider credentials, connector tokens, refresh tokens — must not reach any
model or any provider, and a plugin is a thing the user obtained from
elsewhere. There is no mechanism by which a package could hold a secret safely,
and no mechanism by which one could be given a secret without widening the
credential boundary that Wave 4's audit exists to keep narrow.

A plugin whose skills call a connector's tools gets what every skill gets: the
connector's credential is used inside the guarded transport, leaves only as an
`Authorization` header, and is never visible to the definition that caused the
call.

---

## 6. Permission derivation

The rule is the one already established for skills, restated for a container
one level further out:

```text
effective risk = max(
  plugin declared risk,      // a floor
  skill declared risk,       // a floor
  tool declared risk,        // a floor
  risk computed from the arguments and the live page   // may only raise
)
then: prohibitions → R5 → site scope → origin drift → exfiltration
      → R3 floor → unattended → task plan → mode
```

Three consequences, each already proved for skills and inherited unchanged:

1. **Plugin-level approval is not authority over contained actions.** Enabling
   a plugin makes its skills reachable. Each child action is dispatched
   separately and meets its own decision —
   `tests/security/write-skill-authority.test.ts` establishes this for a
   skill's steps, and a plugin adds no new relationship that would change it.
2. **A declared risk can only be too low, never too high to matter.** A plugin
   declaring R0 over a skill that reaches an R3 tool runs at R3. The floor
   semantics mean understating is useless rather than dangerous.
3. **There is no second permission engine.** A plugin's declaration is checked
   at validation and is an input to nothing at run time except the floor above.

---

## 7. Supply chain and update

Claude auto-updates plugins. The minimum safe adaptation here, stated per
operation. None of this is implemented.

| Operation      | Minimum safe behaviour                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Install**    | A user-chosen local file. Parse, compute the hash here, store. Lands DISABLED.                                                                                                                                                                                                                                                                   |
| **Validation** | Re-derived from the stored bytes, not read from the package. Re-run before every use, not only at install — the same thing `WorkflowReplayer.revalidate` already does, and for the same reason: a record can be altered underneath the store.                                                                                                    |
| **Versioning** | A version is immutable. An update is a new record with its own hash, never an edit — the shape `PlanApproval` uses, so "what was approved when this ran" stays answerable.                                                                                                                                                                       |
| **Update**     | Never automatic in the sense that matters. An update that **narrows or preserves** the declared capability set may be applied and keep its enabled state, because the user's decision still covers it. An update that **widens** it — a new tool, a new connector reference, a higher risk floor — lands DISABLED and requires a fresh decision. |
| **Rollback**   | The previous version's record is retained, so rolling back is selecting an existing validated record rather than re-fetching anything.                                                                                                                                                                                                           |
| **Uninstall**  | Removes the record. Not terminal: the same package may be installed again.                                                                                                                                                                                                                                                                       |
| **Disable**    | Reversible, and the enforcement point is a read that the execution path already uses — the `SkillRegistry.get` / `latest` / `list` shape, whose single-seam property is asserted from source in `skill-enablement`.                                                                                                                              |
| **Revoke**     | Terminal per version, survives reinstalling identical bytes.                                                                                                                                                                                                                                                                                     |

**Auto-update must not be a privileged path**, and under Local-First it barely
exists: there is no service to poll, no origin is contacted on the user's
behalf, and an update arrives the way an install does — a file the user chose.
If a fetching update mechanism is ever added it is an outbound request with a
declared destination, subject to the egress gate like every other one, and it
still cannot widen capability without a decision.

Reproducibility falls out of this: the hash identifies the bytes, the bytes are
local, and nothing rewrites a version in place.

---

## 8. Relationships, and the circularity rules

| From → To                 | Relationship         | Grants trust? |
| ------------------------- | -------------------- | ------------- |
| Plugin → skill            | **containment**      | no            |
| Plugin → connector        | **reference**        | **no**        |
| Plugin → tool             | **reference**        | no            |
| Plugin → MCP server       | reference (deferred) | no            |
| Skill → tool              | reference            | no            |
| Skill → skill             | composition (pinned) | no            |
| Connector → its tools     | containment          | **no**        |
| Skill → containing plugin | **none**             | no            |
| Task → any of the above   | runtime invocation   | no            |

Three rules stated as prohibitions, because each names a mistake that is easy
to make and hard to see afterwards:

- **A plugin must not make a connector trusted.** Containing a reference to a
  connector says the plugin needs it. Whether that connector is authorized is a
  separate fact the user established separately, and a plugin that arrives
  referencing an unauthorized connector simply cannot use it.
- **A connector must not make its tools trusted.** Its tools are registered in
  the one `ToolRegistry`, each with its own risk, scope and egress
  declaration, and each is adjudicated per call. This already holds and must
  keep holding.
- **A skill must not trust the plugin that contains it.** There is no back
  edge. A skill's authority is what its steps declare, which is why a skill
  extracted from a plugin and one that shipped in the build are adjudicated
  identically.

No edge in that table is bidirectional, so no cycle exists.

---

## 9. What this unblocks, and what it does not

### P-025 — plugins

**Decision: the trust model is sufficient to design against, and insufficient
to start implementing.** What remains is small, named, and mostly not code:

1. **A package format and manifest schema.** New, but a JSON document plus a
   validator with the same shape as `validateSkillDefinition`.
2. **A second accepted provenance.** `SkillRegistry.register` refuses anything
   but `provenance: 'bundled'`, and that one check is what makes a model-written
   definition inert. P-025 cannot proceed without deciding precisely what
   replaces "it shipped in the build" — and the answer this model gives is
   "nothing does": a plugin's skills must **not** enter the skill registry at
   all. They live in a plugin store and run the way a recorded workflow runs,
   through an explicit user action, so the registry's refusal stays absolute and
   the riskiest change is avoided entirely.
3. **An install surface, a review surface and a revocation store.**
4. **Audit events** for the six lifecycle transitions.

**The blocker that is not solved by any of the above:** there is no publisher
identity and no revocation feed, so a package's _authenticity_ cannot be
established — only its integrity. This is why §4 forbids executable content and
§3 rejects the git URL. If that constraint is ever lifted, the content model has
to be re-derived rather than extended.

### P-026 — MCP

Not unblocked, and the missing piece is transport rather than trust.

The benchmark shows both directions: Claude consumes MCP tools, and
`claude-in-chrome` is itself an MCP server. Taking them separately:

**As a client.** Local MCP servers are excluded by the locked constraints — no
native messaging, no local process execution — so only remote MCP over HTTPS is
possible. That is compatible with the existing architecture: an MCP server is a
declared egress destination, its calls go through the guarded transport and the
one egress gate, its tools get risk assigned locally, and its resources are
`NEVER_PERSISTED` page-class content that taints the task. Every object in §1's
MCP columns is expressible. What is genuinely undecided is **per-tool approval
granularity** — the benchmark's `requiresUserInteraction` prompts on every call,
and whether ABA matches that or maps MCP tools onto its own R0–R5 scale is a
product decision nobody has taken.

**As a server.** This is the hard blocker. Exposing browser capability over MCP
needs an inbound channel, and every inbound channel this manifest could offer is
forbidden: `externally_connectable` is prohibited, native messaging is
prohibited, and a local listening socket is not available to an extension.
There is therefore **no way to expose an MCP server from this build**, and no
amount of trust modelling changes that. If the capability is ever required it
needs a component outside the extension, which reopens "do not make the Mac a
server" and must be decided at product level first.

Caller authentication, session and workspace isolation for that direction are
downstream of a channel that does not exist, and designing them now would be
designing against nothing.

---

## 9a. Can the audit trail already carry all this?

Asked properly during the P-038 gap audit, because "we will add audit later" is
how a second audit system gets built. The answer is yes for the plugin
lifecycle, yes for MCP as a client, and no for MCP as a server — and the third
is a symptom of the transport problem rather than an audit problem.

### The plugin lifecycle fits without a second system

Every state transition in §2 maps onto the existing record shape. The trail
already carries a closed `type`, a five-value `outcome`, and a `code` drawn
from this build's own vocabulary, which is exactly a lifecycle triple:

| Transition             | Record                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| package discovered     | `{ type: 'plugin.lifecycle', outcome: 'info', code: 'DECLARED' }` |
| package validated      | `{ outcome: 'info', code: 'VALIDATED' }`                          |
| validation failed      | `{ outcome: 'failed', code: 'INVALID' }`                          |
| package enabled        | `{ outcome: 'allowed', code: 'ENABLED' }`                         |
| package disabled       | `{ outcome: 'denied', code: 'DISABLED' }`                         |
| package revoked        | `{ outcome: 'denied', code: 'REVOKED' }`                          |
| package updated        | `{ outcome: 'info', code: 'UPDATED' }`, new version and hash      |
| package rolled back    | `{ outcome: 'info', code: 'ROLLED_BACK' }`                        |
| package removed        | `{ outcome: 'info', code: 'REMOVED' }`                            |
| trust metadata changed | there is no such event — see below                                |

No new outcome is needed. What _is_ needed is an identity triple —
`pluginId`, `pluginVersion`, `packageHash` — and the schema already has that
shape twice over: `skillId`/`skillVersion`/`skillHash`, and
`workflowId`/`workflowVersion`/`definitionHash`. Adding a third is mechanical.

**It is deliberately not added now.** Three fields with no producer would be
the same defect the P-038 audit just removed two of, and a record whose
identity fields are always absent teaches a reader nothing. The fields land
with the code that writes them, and the census test added in this wave makes
that enforceable: a `plugin.*` type declared before it can be emitted fails.

"Trust metadata changed" has no row on purpose. Under §2 there is no metadata
whose change alters authority — every edge in the transition graph is a user
action or a validation result computed here, and an object cannot gain
authority by its metadata moving. An event for it would imply there is
something to watch.

### MCP as a client fits, with one addition

`tool` (verified against the registry), `destination` (the server's origin,
already the vocabulary the egress records use), `outcome`, `code`, `risk` and
`executed` cover tool discovery, invocation, denial, confirmation and result
without change. Resource consumption is a page-class read that taints its task,
which `taintKind` on the subsequent records already reflects.

The addition is a server identity — one opaque id, validated like every other,
so "which server offered this tool" is answerable. A resource **URI** must not
be a field: it is page-derived text, and putting it in a cross-task trail is
the browsing-history problem `taintKind` exists to avoid for taint sources.

### MCP as a server does not fit, and should not be made to

Inbound connection, caller authentication, caller authorization and caller
disconnect all need a **caller identity**, and this architecture has no notion
of one. Every identity in the trail is something this extension minted for
itself. Introducing an external principal is not an audit change; it is the
inbound channel §9 says is prohibited, arriving through the audit schema.

So the honest position is that server-side MCP audit is undesignable until the
transport question is answered, and designing it now would put a principal in
the record that nothing can authenticate.

## 10. Consistency with the existing invariants

Checked against the security architecture as it stands, item by item, so a
reviewer can see that nothing here quietly widens something:

| Invariant                                             | Effect of this model                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| One `evaluatePolicy` call site                        | unchanged — a plugin adds no call site                                                        |
| One `tool.execute()` path                             | unchanged — plugin content reaches tools only through `SkillRunner` → `ToolRegistry.dispatch` |
| `SkillRegistry` accepts only `bundled` provenance     | **unchanged, deliberately** — plugin skills do not enter the registry (§9)                    |
| No `eval`, no `new Function`, CSP `script-src 'self'` | unchanged — a package carries no code                                                         |
| No new Chrome permission                              | unchanged — install reuses user-mediated file selection                                       |
| Local-First                                           | strengthened if anything — no origin is contacted to install or update                        |
| K1                                                    | untouched — a plugin holds no `SECRET_LOCAL_ONLY` data and is not a credential store          |
| `SECRET_LOCAL_ONLY` never reaches a model             | unchanged — §5 forbids a plugin holding or requesting a credential                            |
| Route trust classes                                   | install/enable/revoke would be `CLASS_B_PANEL_CONTROL_PLANE`, like `skill.setEnabled`         |
| Audit completeness                                    | extended by six event types; no existing event changes meaning                                |
| Provider neutrality                                   | preserved — nothing in this model names a provider, and no trust decision reads one           |

---

## 11. What is deliberately absent

No PKI. No certificate chain, no publisher registry, no transparency log, no
signature verification. Each would be defensible in a product that distributes
plugins; this one does not distribute anything, and a mechanism whose threat
model is "a malicious publisher" is not worth building before there is a
publisher.

No marketplace, no git fetch, no auto-update poller, no sandbox, no plugin
runtime, no sub-agent object, no MCP client and no MCP server.

No claim that P-025 is ready to implement. This document is the gate, not the
permission.
