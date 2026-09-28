# MCP_GUIDE

Required by specification §81. This is the authoritative record of what P-026
is, what it is not, and the one decision it turned on.

It exists because the capability had accumulated two answers to questions
nobody had re-asked from the specification: a design for a direction the
specification never requested, and a risk model whose safe setting was the one
a user had least reason to choose. Both are corrected below, and both
corrections are recorded rather than quietly applied.

**Status: P-026 is NOT-STARTED.** Nothing in this document is an implementation
claim. The client is built end to end _inside the MCP layer_ — trust core,
guarded transport, discovery, schema compiler, tool factory, server store and
registrar — and **no person can reach any of it**: the service worker does not
call the registrar and no route lets a user add a server. A client nobody can
start is not a client. See §8.

---

## 1. The word "server" means two opposite things, and only one is in scope

Every earlier note in this repository about "MCP server risk" is ambiguous, and
the ambiguity mattered enough to stop work over. Separating them:

| Direction                  | What it means                                                                   | Status                                    |
| -------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| **This build as a client** | The extension calls out to an MCP endpoint somebody else runs, to use its tools | **In scope.** What §5.11 and §35 require. |
| **This build as a server** | Something outside drives the extension's browser capability over MCP            | **Out of scope, and locked shut.**        |

Everything this project has written about a malicious or untrustworthy MCP
server is about the **first** row: the risk that a third-party endpoint this
build talks to is hostile. That is an ordinary untrusted-input problem and it is
what §§4–7 below are about.

The second row is a different thing entirely and is not reopened here. It needs
an inbound channel, and every inbound channel this manifest could offer is on
the locked prohibition list: `externally_connectable` is prohibited, native
messaging is prohibited, arbitrary local process execution is prohibited, and an
extension cannot hold a listening socket. It is also not asked for — see §2.

---

## 2. What P-026 actually requires — classification **A, client only**

Re-derived from the specification rather than from the name "MCP". Every MCP
reference in `docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`, in order:

| §     | Text                                                                                                                                                                          | Direction it implies              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| §1    | the benchmark can "use skills, plugins, connectors, and MCP-based capabilities through the broader … environment"                                                             | Consumes                          |
| §5.10 | plugins may bundle "bundled MCP servers where supported"                                                                                                                      | A plugin names servers to consume |
| §5.11 | **"MCP client"**, "remote MCP", "local MCP where supported", "tool discovery", "resource discovery where applicable", "permission enforcement", "audit", "trust controls"     | **Client, explicitly**            |
| §35   | "Support MCP as an interoperability layer", with the diagram `Agent Runtime → MCP Client → Remote/Local MCP → Tools/Resources`, and "MCP must never become a security bypass" | **Client, explicitly**            |
| §36   | MCP as a Tier 3 connector                                                                                                                                                     | Consumes                          |
| §41   | MCP ranked second, above browser automation, in the tool-preference order                                                                                                     | Consumes                          |
| §66   | "local MCP" listed as a capability of the **deferred desktop-agent bridge**, "Do not make this a dependency for the first Chrome-only MVP"                                    | Consumes, and deferred            |
| §80   | an `mcp-core/` package                                                                                                                                                        | Neutral                           |
| §81   | an `MCP_GUIDE.md`                                                                                                                                                             | Neutral — this file               |
| §82   | "malicious MCP" as a mandatory threat                                                                                                                                         | A counterparty, i.e. consumed     |
| §83   | `P-026 \| MCP \| YES` — mandatory                                                                                                                                             | Neutral                           |
| §96   | Phase 9, with plugins and custom connectors                                                                                                                                   | Neutral                           |

**Classification: A — MCP client capability.** §5.11 enumerates the components
of this capability and "MCP client" is the first of them; no component of it is a
server. §35's diagram is strictly downstream of the agent runtime. The word
"server" appears once, at §5.10, describing servers a _plugin_ names — which the
client then connects to.

Nothing in the specification asks this project to expose an MCP server, so the
locked prohibition and the specification agree. There is no conflict to resolve
and no ambiguity to flag: this is not classification E.

### What "local MCP where supported" resolves to here

Not supported, and the specification is the one that says so. §5.11 qualifies it
"where supported"; §66 places local MCP behind the native-messaging desktop
bridge and instructs that the bridge not be an MVP dependency. A Chrome-only
MV3 extension cannot spawn a process, so stdio is unreachable, and the only
remaining shape — a server the user runs on loopback — is reachable but is not
what §66 describes. So: **remote MCP over HTTPS is the transport, loopback is
permitted for a test double, and local MCP is out of scope by the
specification's own qualifier**, not by preference.

---

## 3. What the benchmark actually does — and the finding that changes the framing

Researched against vendor documentation. Evidence classes: **A** directly
documented, **B** directly observed, **C** reliable secondary, **D** inference,
**E** unknown. Nothing here is observed — this project holds no E0/B evidence,
which is recorded in `CLAUDE_BENCHMARK.md` and is unchanged.

### 3.1 The comparison extension is not an MCP client either — **A**

This is the finding, and it was not what the earlier notes assumed.

- The Chrome side panel "runs the same Claude Cowork session you use on desktop,
  web, and mobile", and because of that "your skills and connectors work in the
  browser". (A, product blog.)
- Custom connectors are **remote MCP reached from the vendor's cloud, not from
  the browser**: "your MCP server must be reachable over the public internet
  from Anthropic's IP ranges", with private-network servers needing to allowlist
  those addresses. (A, help centre.)
- Local MCP servers configured on the desktop "aren't available in Cowork or
  claude.ai". (A, help centre.)

So in the comparison product the MCP client lives in the cloud session; the
extension is the surface that session is displayed in. And in the other
direction, `claude-in-chrome` is a **reserved built-in server name inside the
coding agent**, which reaches the extension over a native messaging host — the
correction already recorded at `CLAUDE_BENCHMARK.md` §13. (A/C.)

**The comparison extension is therefore neither an MCP client nor an MCP
server.** MCP lives entirely in the runtime behind it, on both sides.

Two consequences, and they pull in opposite directions:

1. **There is no benchmark behaviour to copy.** Any argument of the form "the
   benchmark approves MCP tools this way, so we should" is unavailable for the
   extension surface. This removes the external support the rejected ceiling
   design was partly resting on.
2. **The client has to live in the extension or nowhere.** The benchmark gets
   MCP through a cloud session that holds the user's connectors. This project has
   no such thing by locked decision — the brain is an interchangeable provider
   API and normal browser-agent operation must not depend on the backend — so
   §5.11's client cannot be delegated the way the benchmark delegates it.

The parity floor is the comparison **extension**, which has no MCP client. So an
in-extension MCP client is _above_ the parity floor and is required by the
specification rather than by parity. Both still bind; the distinction is that
§5.11 is the authority for it, not §1.

### 3.2 The same vendor's own MCP client, which is usable as evidence — **A**

The coding agent is an MCP client and its behaviour is documented. It is not the
extension, so it sets no parity obligation, but it is the best available evidence
of what a careful MCP client does.

| Question                           | Documented behaviour                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default for an MCP tool call       | Prompts.                                                                                                                                                                                                                                                                  |
| Escaping the prompt                | The **user** writes a rule. Rules name `mcp__<server>` (any tool from it) or `mcp__<server>__<tool>` (one tool).                                                                                                                                                          |
| Breadth asymmetry                  | Deny and ask rules may use unanchored globs, including `mcp__*`. **Allow** globs must be anchored to a literal, glob-free server segment; `mcp__*` as an allow "is skipped with a warning and doesn't auto-approve anything".                                             |
| Argument-level policy              | Not available for allow rules — a settings rule containing parentheses is skipped and reported as invalid. Parameter matching exists only as a deny.                                                                                                                      |
| Server influence over its own risk | Only upward. A tool marked `requiresUserInteraction` prompts on every call and cannot be silenced by an allow rule, by a hook returning allow, or by the most permissive mode; in the never-prompt mode it is denied instead.                                             |
| Organization override              | Also only upward: a connector tool an org sets to `ask` prompts regardless of user rules or mode.                                                                                                                                                                         |
| Tool set changing after approval   | `list_changed` refreshes capabilities automatically, "without requiring you to disconnect and reconnect". A previously written `mcp__server__*` allow rule therefore covers tools that did not exist when it was written.                                                 |
| Revocation                         | Toggle off, remove (which deletes stored OAuth tokens and client registration), or clear authentication (which also discards the discovery cache).                                                                                                                        |
| Reconnect                          | Exponential backoff, five attempts, then marked failed or needs-authentication.                                                                                                                                                                                           |
| Trust posture stated to the user   | "Verify you trust each server before connecting it. Servers that fetch external content can expose you to prompt injection risk." And, for the cloud surface: "Malicious MCP servers may include hidden instructions that try to make Claude perform unintended actions." |

Two of those rows are the useful ones.

The **asymmetry** rows — broad denies allowed, broad allows refused; server
metadata may only tighten — are a principle worth adopting outright, and §5
does.

The **`list_changed`** row is a hazard this project should not copy. A grant
written at server scope silently acquiring authority over tools the server adds
afterwards is server-controlled widening inside a user-granted scope. §5 is
built so that the situation cannot arise.

---

## 4. The locked architecture, restated because it constrains §5

Unchanged by this document, and none of it is reopened:

- This build never becomes an MCP server (§1).
- No native messaging, no `externally_connectable`, no arbitrary local process
  execution, no listening socket.
- Browser-agent operation does not depend on the backend, so the client is in
  the extension.
- One policy engine, one `evaluatePolicy` call site, one `tool.execute()` path.
  An MCP tool is an ordinary `AgentTool` or it does not exist.
- Provider credentials are `SECRET_LOCAL_ONLY` and reach no model and no server.

---

## 5. Where an MCP tool's risk comes from — the decision

### 5.1 The rejected answer, and why it is worse than it looks

An earlier draft asked the user, when adding a server, for a per-server **risk
ceiling**, clamped like a site grant, and ran every tool from that server at it.
It is recorded here because it reads as the conservative option and is not.

A ceiling is a number the user picks. The user who picks a **low** one — R0 or
R1, reasonably, for a server they believe only looks things up — has placed
every tool from that server below `AUTO_APPROVE_BELOW`, which is R2. Those calls
would never be shown to anybody. Combine that with §3.2's `list_changed` row and
the server can add a write tool afterwards that inherits the same silence.

So the ceiling's failure mode is: **the setting a user has the most natural
reason to choose is the one that auto-approves the server's entire present and
future tool set.** A safeguard whose safe position is the counter-intuitive one
is not a safeguard. It also handed a third party influence over authority by a
longer route, which the constraints in §7 forbid however it arrives.

It is not implemented, and it is not put to the account owner for approval,
because it is not a business question — it is wrong on the security merits.

### 5.2 The answer: R3, classified here, from what an MCP call is

An MCP tool call sends task data to a third-party endpoint and asks it to act.
`RISK_DESCRIPTIONS.R3` is _"Sensitive external side effect. Writes data outside
the browser."_ That is the same sentence. It holds for a tool that only reads on
the far side, because the arguments still left the browser.

So **every MCP tool is R3**, assigned by `MCP_TOOL_RISK` in
`src/mcp/core/mcp-model.ts`. This is a classification, not a preference, and
`mcpToolRisk()` takes no argument — there is no input in which a server, a
schema, a tool name or a stored setting could reach the answer. A test pins the
arity at zero, because a later parameter is the shape every "just let the server
hint at it" change would arrive in.

### 5.3 What that gets, entirely from thresholds that already ship

The point of choosing R3 is that the existing engine already does the right
thing with it. Nothing new was added to the authorization surface.

- `evaluatePolicy` stage 5 returns `ALLOW_WITH_CONFIRMATION` at or above
  `ALWAYS_CONFIRM_AT` (R3) **before** the mode switch. So an MCP call is
  confirmed in `manual`, in `auto`, and in `skip`.
- `MAX_GRANTABLE_RISK` is R2 and `GrantableRiskLevel` is `R0 | R1 | R2`. No site
  rule and no plan approval can reach R3. **There is no approval-granularity
  question left to answer.** It is per call, and it is per call as arithmetic:
  the grantable range stops below where MCP begins.
- Stage 7's plan clause and stage 8's grant clause are both downstream of
  stage 5, so neither is reached.
- Stage 6's unattended clause is downstream too, so a scheduled run turns an MCP
  call into a confirmation with nobody to answer it, and it fails closed.

Read against Message A's list of things a ceiling design would have had to
define, the adopted model answers most of them by not having the mechanism:

| Question                               | Answer                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How is the ceiling created?            | There is none. Nothing about risk is stored per server.                                                                                                                                                                                                                                                           |
| Per server or per server version?      | Neither. Risk is a property of the class of call.                                                                                                                                                                                                                                                                 |
| What happens when a tool is added?     | It is R3, like every other. No prior grant could have covered it, so nothing widens. No pinning or versioning needed.                                                                                                                                                                                             |
| What happens when a tool changes?      | Same. Admission re-runs; risk is unchanged because it never depended on the tool.                                                                                                                                                                                                                                 |
| What if the server's identity changes? | A different `id` is a different namespace and a different set of tool names; the old names stop resolving.                                                                                                                                                                                                        |
| How does revocation work?              | Removing the server removes its tools. There is no residual grant to revoke, which is the point.                                                                                                                                                                                                                  |
| How does R0–R5 map?                    | Fixed at R3. R4 and R5 are not assignable from anything a server supplies; R5 would be a denial and is not offered.                                                                                                                                                                                               |
| How does confirmation work?            | The existing prompt, on every call, in every mode.                                                                                                                                                                                                                                                                |
| How is the authority audited?          | `tool` (namespaced, so the server is legible), `destination` (the server origin, the vocabulary egress records use), `risk`, `outcome`, `code`, `executed`. Plus one server id. A resource **URI** is never a field — it is page-derived text.                                                                    |
| How is taint propagated?               | An MCP call sets `writeDestination` to the server origin and `writePayload` to its arguments, so stage 4's exfiltration gate sees it. A tainted task sending page-derived content to a server can be **denied**, not merely confirmed. Resources read back are page-class, `NEVER_PERSISTED`, and taint the task. |
| How can a malicious server not widen?  | It has no channel to. Risk takes no input; names are namespaced and cannot shadow a built-in; the listing is bounded; schemas are required; nothing it sends is stored as authority.                                                                                                                              |
| Restart and reconnect?                 | A transport concern with no authority attached, because no authority survives a connection.                                                                                                                                                                                                                       |

### 5.4 The cost, stated rather than discovered later

A read-only MCP tool is confirmed like a write. That was also true of the
ceiling, minus the setting that could be turned down.

The project has argued against prompt-on-everything three times, and this is not
that argument arriving again: those were about tools the agent calls constantly
while working a page — a confirmation in front of rearranging a tab, a prompt for
reading the DOM. An MCP call is not in that loop, and the comparison vendor's own
client prompts on MCP tools by default (§3.2). If the friction turns out to be
real in use, the answer is **not** a grant that lowers R3; it is to look again at
whether a particular server's tools belong in the tool set at all.

One consequence is sharp enough to state on its own: **a scheduled or otherwise
unattended task cannot use an MCP tool.** That follows from §5.3 and is accepted.
Whether it should change is a question for whoever builds the transport, and
changing it would mean changing this classification, not adding an exception.

---

## 6. Discovery is untrusted input

A discovered tool's name, description and schema were authored by the server.
`src/mcp/core/mcp-model.ts` treats them as adversarial input:

- Names are namespaced `mcp__<server>__<tool>`, so two servers offering `search`
  are two tools and neither can shadow a tool this build ships. No built-in
  family contains `__`.
- A name containing the separator is refused: it could otherwise forge a
  namespace and appear to come from a different server.
- A name outside `[A-Za-z0-9_.-]` is refused.
- A missing or non-object input schema is refused. §22 makes argument validation
  the contract, and a tool with no schema has no contract.
- A description over 400 characters is refused, and a non-text one is refused.
- A listing is bounded at 64 tools, with the overflow named rather than silently
  truncated: the count comes from the server too, and ten thousand tools is a
  context-exhaustion channel.
- A repeated name keeps the first and names the second as refused.
- Every refusal is reported, because a server that silently appears to offer
  nothing is worse than one that says why.

Descriptions and schemas that are admitted still reach the model as **data**,
in the envelope every other external content uses. They are not instructions.

---

## 7. The constraints, and how each is held

The external service must not be able to do any of the following. Stated with
the mechanism, not the intention:

| It must not…                          | What stops it                                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| define its own authoritative risk     | `mcpToolRisk()` takes no argument. There is no parameter to carry a declaration.                            |
| define its own permissions            | Risk is the only input to the engine an MCP tool contributes, and it is fixed. No rule is created.          |
| bypass ABA policy                     | An MCP tool is an `AgentTool`; dispatch goes through the one `evaluatePolicy` call site.                    |
| create a Chrome permission            | Permissions are declared in the manifest and requested by product code. Nothing reads a server for one.     |
| bypass route trust                    | It is not a message sender. There is no inbound channel (§1), so it has no route.                           |
| bypass taint                          | Its resources are page-class and taint the task; its calls carry `writeDestination`, so stage 4 sees them.  |
| reach `SECRET_LOCAL_ONLY` credentials | Provider credentials are never tool arguments and never leave the worker.                                   |
| create a browser capability           | It offers names and schemas. Browser capability is the built-in tool set, which it cannot add to or shadow. |
| override workspace security           | Workspace membership is resolved from Chrome at dispatch. An MCP tool takes no tab id from a server.        |
| create inbound control                | §1. There is no channel, and none is being designed.                                                        |

**ABA remains authoritative for policy.** The one thing the server decides is
what its own tools do on its own side of the wire, which is what it is for.

---

## 8. What exists in code, and what does not

Three files, in the order they were written, which is also the order the
questions had to be answered in.

**`src/mcp/core/mcp-model.ts` — the trust core.** Pure functions over data: name
construction, server-descriptor validation (https or loopback, id charset), tool
admission, bounded listing admission, and `MCP_TOOL_RISK`.

Reassessed against §2 rather than assumed final. The result:

- **Retained** — namespacing and the anti-shadowing rules, admission, the
  bounded listing, the https/loopback rule. All of it is required by §5.11's
  `tool discovery` and `trust controls` and by §35's `schema` stage.
- **Removed** — `ceiling` from `McpServerDescriptor` and from
  `validateServerDescriptor`, and the server argument to `mcpToolRisk`. §5.1 is
  why.

**`src/mcp/transport/mcp-transport.ts` — the guarded transport.** It adds no HTTP
client of its own: it builds an `mcp` destination and calls `guardedSend`, the
same function the provider and connector transports call, so there are three
façades and one authorization model. Four rules are specific to talking to an
endpoint nobody vetted:

- `mcp` is **its own egress channel**, not a reuse of `connector`. A connector
  reaches origins a descriptor declared and runs operations this project named,
  and neither is true of a server the user added at run time. Folding them would
  let the connector's declared-origin reasoning read as though it applied where
  there is no descriptor to declare anything. The identity is
  `mcp:<serverId>@<origin>`, prefixed so it cannot collide with a connector's in
  a consent record — server ids are user-chosen, and somebody will name one
  `github`.
- **Redirects are refused, never re-checked.** The connector transport follows a
  hop that stays inside its declared origins; there is no such set here, so
  every hop is an address the user did not name. Both shapes are handled,
  because both occur: a browser returns an opaque redirect with status 0 and no
  headers, and outside one the 3xx arrives with its `Location`.
- **The body is bounded twice** — by `Content-Length` and by the decoded text —
  because the header comes from the server too, and a check that trusted it
  would hand an understating server an unbounded read.
- **An HTTP failure body is never surfaced.** It would reach a message and from
  there the model's context.

It carries no credential of this build's own, which is asserted rather than left
implicit.

**`src/mcp/core/mcp-discovery.ts` — the handshake and the listing.** It owns no
policy: risk comes from `MCP_TOOL_RISK` and admission from `admitListing`. What
it adds is a revision check and pagination that terminates. The revision is
**declined rather than negotiated**, because guessing compatibility from a string
the server chose is how a client parses a shape it does not understand.
Pagination is bounded three ways — a page cap, an end on a repeated cursor, and
admission applied to the **accumulated** set rather than per page, so a server
that splits a listing does not evade the tool cap.

**`src/mcp/core/mcp-schema.ts` — compiling an untrusted JSON Schema.** §22 makes
argument validation the contract. Every other tool in this build satisfies it
with a schema its author wrote; an MCP tool's schema came from the server, so
this is the only validator in the product built out of hostile input.

It compiles a **subset** and refuses the rest by name. Both available shortcuts
were rejected for stated reasons: `z.record(z.unknown())` would put an
unvalidated argument set on the wire, so a model that hallucinated a field would
reach the server with it; and a full JSON Schema implementation would put a large
parser over attacker-controlled input inside the service worker, with `$ref`
alone bringing cycles, remote references and resolution order. Refusing is a real
cost — some servers offer tools this build cannot use — and it is the right
direction, because the alternative to refusing a schema is guessing at it.

The bounds on property count, nesting, enum length and name length are each a
number the server would otherwise choose. `__proto__`, `constructor` and
`prototype` are refused as property names, and that was **found by a test rather
than by reading**: the compiler builds its shape with `shape[name] = …`, and
`shape['__proto__'] = x` sets the prototype instead of adding a key — so the
property vanished from the compiled schema and the argument was refused as
unrecognised. Fail-closed, and by accident, with the accumulator's prototype
replaced on the way.

**`src/mcp/tools/mcp-tool.ts` — the tool factory.** It produces an ordinary
`AgentTool`, so dispatch runs through the single `evaluatePolicy` call site and
the single `tool.execute` path. An MCP tool is a registry entry or it does not
exist. Four things are fixed here rather than taken from the server: the
namespaced name, the R3 risk, the site scope (`destination`, resolved to the
**descriptor's** URL closed over by the factory — `classify` receives the model's
arguments, so a target it could read out of them is a target the model could
choose), and the payload declaration that puts the arguments in front of the
exfiltration gate. What comes back is bounded, a non-text part is named rather
than decoded, `isError` is a failure rather than a success whose text says so,
and the result taints the task.

Building it also surfaced a collision the earlier `__` reasoning had missed. The
registry's `fromWireName` restores the first `_` in a wire name to a `.`, so
`mcp__example__search` became `mcp._example__search` — a name nothing is
registered under, making **every MCP tool undispatchable**. The earlier argument
for `__` was that no built-in family contains it, so a discovered name cannot
shadow one; that is true, and it is about shadowing rather than about the wire
round trip, which is where the two conventions actually met. The fix is a prefix
test in the registry, which a server cannot reach because
`admitDiscoveredTool` refuses a discovered name containing the separator. The
suite caught it because its cases drive a real `ToolRegistry` rather than calling
`execute` directly.

**`src/mcp/core/mcp-server-store.ts` — where a named server lives.** It owns two
properties. Identity is unique: a duplicate id is **refused** rather than renamed
or merged, because an id is part of every tool name the server contributes and
resolving a collision silently would point a task's existing tool at a different
endpoint. And a record has nowhere to put a credential — `validateServerDescriptor`
produces exactly three fields and `isStorableServer` drops a record that grew a
fourth, which is what makes `mcp-server` honestly `PLAINTEXT_BY_DESIGN` rather
than a claim the implementation fails to make.

Its three classifications, with the reasoning:

| Table                 | Value                    | Why                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_CLASSIFICATION` | `LOCAL_ONLY`             | Unlike a workflow, which sits there until somebody runs it, a **synced** server changes the tool surface the model is offered on a machine where nobody added it. Every call still confirms — and the person confirming is being asked about a third party they never chose. |
| `EXPORT_PORTABILITY`  | `NOT_PORTABLE_BY_DESIGN` | Same shape in a file somebody may have been mailed. Softer than `policy`, and softer is not safe.                                                                                                                                                                            |
| `K1_PROTECTION`       | `PLAINTEXT_BY_DESIGN`    | No credential to protect, and the panel has to list servers before anything is unlocked. Server authentication, if ever added, arrives as its own kind rather than a field on this one.                                                                                      |

Adding a server contacts nothing. A stored server has been **named**, not trusted.

**`src/mcp/core/mcp-registrar.ts` — the caller the layers beneath were missing.**
It reads the store, discovers per server, builds a tool per admitted entry and
registers it. Three properties belong here rather than further down:

- **A failing server does not take the others with it.** One unreachable endpoint
  must not cost the user the tools from the servers that answered, and must not
  stop the extension starting.
- **Registration is a fresh reading every time.** Nothing caches a tool list
  across a worker generation, which is what makes revocation _free_ rather than
  implemented: a tool exists only as a function of the record and the answer the
  server just gave, and nothing could have pre-approved one, so there is no
  residual grant to invalidate.
- **A server's tools are replaced, not merged.** A server that used to offer
  `delete_everything` and no longer does must not keep it.

`ToolRegistry.unregister` was added for this and is deliberately narrow. It names
a tool, so a caller that wanted to remove `browser.click` could; what stops that
is that there is **one** caller and it matches the `mcp__<server>__` prefix. That
is a property of the caller set rather than of the method, so an invariant test
counts it, the way the dispatch and egress call sites are counted.

**The wiring, which is what made it a capability.** The worker holds the store,
builds a transport per server, and registers on every worker start — on every
start, because a tool set is a fresh reading rather than stored state, which is
the same property that makes revocation free. It is deliberately not awaited and
not fatal: a worker that would not start because somebody's MCP server is down
would have made an optional capability load-bearing.

Four panel routes, classified in `route-trust.ts` like every other:

| Route         | Class     | Why                                                                                                                                                                                                                                                                                  |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp.list`    | `CLASS_E` | Discloses which servers the user added. Theirs and nobody else's, so panel-only like every other read.                                                                                                                                                                               |
| `mcp.add`     | `CLASS_B` | Control plane **twice**: it writes a durable record, and it puts a third party's tools in front of the model. A page that could reach it would extend the agent's tool surface with an endpoint it chose, and every later confirmation would be about a server the user never added. |
| `mcp.remove`  | `CLASS_B` | Mutates.                                                                                                                                                                                                                                                                             |
| `mcp.refresh` | `CLASS_B` | Makes outbound requests to every stored server.                                                                                                                                                                                                                                      |

Two audit events, and only two: `mcp.server.added` and `mcp.server.removed`.
There is deliberately no "discovered" or "connected" event — a tool set is a
fresh reading on every registration rather than a state that changes, so such a
record would fire on every worker start and say nothing about a decision anybody
made. `added` carries the server's URL as its `destination`, the vocabulary the
egress records already use, and never a tool name: those come from the server.
Each request also writes the ordinary `egress.decided` record with its evidence.

The panel surface shows what a server contributed **and what it did not** — a
tool whose schema this build will not compile is named with the reason, because
the user's own MCP client may show that tool working. It says, next to the button,
that adding a server is not a grant and that every call is confirmed: a person who
thinks they have authorised something is a person who stops reading prompts. There
is no "connected" indicator, because a green dot would be describing the last time
somebody looked.

**`src/mcp/tools/mcp-resource-tools.ts` — resources, as tools.** A resource is
data a server offers rather than an action, and in the protocol it is attached as
context. This architecture has one way for a model to reach anything, so resources
arrive as two tools per server: one that lists what is available, one that reads a
named entry. Any other shape would be a second path into the model's context that
the policy engine does not see, which is what §35 forbids.

Both are R3, **including the listing**. The absence of a read-only exception is
the point: the call itself tells the server this browser is asking, when, and
inside which task — "less" is not "none" — and a read-only exception is exactly the
shape the withdrawn per-server ceiling had.

The read may only name a URI the server offered. Without that the model could name
any string; nothing here would fetch it, but the **server** would be asked to,
which is a request the user never saw offered and which this build would have
originated. Restricting it to the admitted set means the model can only ask for
what the person could also see in the panel.

A resource's content is page-class, bounded, `NEVER_PERSISTED`, and it taints the
task — the same treatment page text gets, because a resource is the injection
channel `PLUGIN_TRUST_MODEL.md` names. Binary is named rather than decoded. And a
resource **URI** reaches neither an audit field nor a prompt summary: it is
page-derived text, and a cross-task trail holding one is the browsing-history
problem `taintKind` exists to avoid. The read's confirmation quotes the server's
_label_ instead.

Discovery asks for resources only when the server declared the capability, which
is the opposite of how the tool listing behaves. The asymmetry is deliberate: a
server that omits the `tools` capability and offers tools anyway is inconsistent in
a way that would cost the user tools they can see in their own client, while asking
a server with no resources produces a `-32601` that has to be told apart from a
real refusal. A failing resource listing is likewise not an error — it is
supplementary, and losing it must not cost the user the server's tools.

**The MCP layer now ships**, which is the point of the wiring: the built service
worker contains `jsonrpc`, `tools/list` and the `mcp-servers` namespace. The
release artifact grew from 257,021 bytes to 264,427 — about 7.2 KB, which is what
P-026 costs.

For the record of how it got there, the three waves before the wiring added only
this much, in files that already shipped:

| What                            | Where                                 |
| ------------------------------- | ------------------------------------- |
| `'mcp'` as an egress channel    | `src/security/egress/destination.ts`  |
| `'MCP_ERROR'` in the taxonomy   | `src/types/result.ts`                 |
| `'mcp__'` in the wire guard     | `src/tools/registry/tool-registry.ts` |
| `'mcp-server'` in three tables  | `src/storage/data-classification.ts`  |
| `unregister`, a two-line method | `src/tools/registry/tool-registry.ts` |

Forty-two bytes in total. Four strings, a prefix test and a `Map.delete`. No MCP
behaviour, and a channel, an error code and a data kind that nothing yet
produces.

### The test suites

- `tests/security/mcp-trust-core.test.ts` (TEST-MCP-001). Its group 02 runs the
  real `evaluatePolicy` rather than the MCP model, because the claim is about
  what the shipped engine does with an R3 tool and asserting that against a
  fixture would prove the fixture.
- `tests/security/mcp-transport-security.test.ts` (TEST-MCP-002). The seam is
  `fetchImpl` and nothing above it: the real egress gate, destination model and
  consent store are in the path.
- `tests/security/mcp-discovery.test.ts` (TEST-MCP-003). Written as "what would
  a server that wants more than it should send here", not as a parser test.
- `tests/security/mcp-schema.test.ts` (TEST-MCP-004). The positive cases
  establish that the subset is usable at all, because a compiler that refused
  everything would be trivially safe and useless.
- `tests/security/mcp-tool-dispatch.test.ts` (TEST-MCP-005). Drives a real
  `ToolRegistry` with the real policy engine and prompter, which is how the
  wire-name collision was found.
- `tests/security/mcp-registration.test.ts` (TEST-MCP-006). The properties that
  only exist once something calls the layers below.
- `tests/e2e/mcp.spec.ts` (TEST-E2E-048). **Real Chromium**, against a local
  server speaking real JSON-RPC over real sockets. What only a real browser
  settles: that the worker calls the registrar at all, that the routes are
  reachable from the panel, that a registered tool appears in the set the model
  is offered, and that a plain-http server is refused at call time by the policy
  engine's origin check — the https rule observed rather than asserted.

**Forty-one mutants** have been run against these invariants and all forty-one
were caught.

- _The risk model (5)._ `MCP_TOOL_RISK` lowered to R2; `mcpToolRisk` given a
  parameter; `ALWAYS_CONFIRM_AT` raised; `MAX_GRANTABLE_RISK` raised; a
  `ceiling` field restored.
- _Transport and discovery (9)._ Redirects followed; the use-time address
  re-check removed; the decoded-length check removed; the failure body surfaced;
  any protocol revision accepted; the repeated-cursor guard removed; admission
  applied per page; the `mcp:` identity prefix dropped; the `mcp` channel treated
  as internal.
- _The schema compiler (10)._ `.strict()` dropped; an object with no properties
  accepted; refused keywords ignored; the depth bound removed; open
  `additionalProperties` allowed; the forbidden names allowed; `required` not
  checked against `properties`; a tuple approximated by its first entry; a union
  of types taken as its first member; the property-count bound removed.
- _The tool and the wire guard (10)._ The wire guard removed; the wire guard
  widened to any `mcp` prefix; risk taken from the arguments; the destination read
  from the arguments; the namespaced name sent to the server; `isError` treated as
  success; the result left unbounded; the taint dropped; a non-text part decoded;
  the payload declaration dropped.

## 8b. A recorded MCP step, and the id that could point somewhere else

The Part 6 cross-capability pass asked whether recording an MCP call into a
workflow creates a confused deputy. It does not, and the reasoning is written
here so it is not re-derived as an open question.

`NOT_RECORDABLE` in the recorder is a denylist, so an MCP call **is** recordable.
A recorded step stores the wire name — `mcp__<serverId>__<tool>` — which is
stable across registrations. So in principle: record a step against server S,
remove S, register a different server under the same id, replay the workflow, and
the step reaches a different third party under the name that was recorded.

What makes that not an attack anybody else can mount:

- **Only the person can cause it.** `mcp.add` and `mcp.remove` are CLASS_B,
  reachable from the side panel and from nothing else. No page, no model, no
  server and no recorded workflow can register or replace a server. The
  substitution requires the person to type or paste the replacement URL
  themselves.
- **Every MCP call still asks.** `MCP_TOOL_RISK` is R3, the risk floor returns
  `ALLOW_WITH_CONFIRMATION` at R3 before the unattended, plan and mode-switch
  stages, and a replay does not change that — a replayed step at R3 confirms in
  `skip` as much as in `manual`. There is no "the workflow was approved once"
  that carries an MCP step past the prompt.
- **The prompt names where it is going.** An MCP tool declares
  `siteAuthorization: 'destination'` and its `classify` returns the server's URL
  from the closure, never the model's arguments, so the confirmation's `site` is
  the server's site rather than the page's. A replacement on a different host is
  visible in the prompt before anything runs.
- **The trail names it too.** `mcp.server.added` carries the URL as its
  `destination`, and every call's egress record carries
  `mcp:<serverId>@<origin>`. A substitution is reconstructable after the fact
  even if it was approved.

The one residual case the prompt cannot distinguish is two servers on the **same
site** at different paths, because `site` is a registrable domain and both
resolve to the same one. That is a limit of site-granularity rather than a
defect in this capability — it is the same granularity every site grant in the
product uses — and closing it would mean making MCP authorization path-scoped
while nothing else is. Recorded here as a known limit, not fixed.

## 9. What is still open, and who owns it

- **A real server.** Every mandatory clause is now VERIFIED except the two
  recorded as external. The row stays PARTIAL because nothing has met a real
  third party — the same standard P-023 and P-033 are held to.
- **Validation against a real server.** Needs a real remote MCP endpoint and its
  credentials, which this project does not hold. An owner or external
  prerequisite, recorded the way every other external blocker is.
- **Nothing for the account owner to decide about trust.** §5 is settled on
  security grounds from the specification, the existing thresholds and the
  documented behaviour of a comparable client. There is no business, legal or
  ownership question left in it.
