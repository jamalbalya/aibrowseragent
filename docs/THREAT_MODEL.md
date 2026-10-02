# THREAT_MODEL

Required by specification §81. §82 names eighteen mandatory threats, and this
document is one item per threat: what the threat is here, what actually holds
it, what does not, and where to look.

It exists because §82's list was not written down anywhere. Pieces of it were
enforced and tested — most of it, as it turns out — but "enforced somewhere in
seventy security suites" is not a threat model, and nothing could tell a reader
which of the eighteen had been thought about and which had merely not come up.

## How to read a verdict

The three verdicts are the ones the acceptance packages use, and they mean the
same thing here:

- **`AUTOMATED`** — a test in this repository exercises the defence. Every
  `- EVIDENCE:` line below names a file and a test title, and
  `scripts/check-acceptance.mjs` fails if either stops resolving. That is the
  only reason to trust the citations: they are checked, not remembered.
- **`MANUAL`** — the defence is real but the evidence needs a person.
- **`NOT POSSIBLE HERE`** — the threat cannot be demonstrated against this build,
  with a stated reason. Twice below that reason is "the surface it attacks does
  not exist yet", which is an honest defence and a temporary one.

**No item awards a PASS.** A verdict says where evidence comes from. Whether
the product is acceptable is §84's question, and §84 condition 3 — manual
acceptance — has not been executed.

Two limits apply to the whole document and are not repeated in every item:

1. **A defence tested in isolation is not a defence proven in production.** Where
   an item is held by "the only call site", the invariant tests in
   `tests/security/security-invariants.test.ts` are what keep it the only one.
2. **Nothing here is an incident record.** No build has been published, so no
   threat below has been observed in the wild.

---

## T-1 — Prompt injection

A page, a tool result, a downloaded file or an MCP resource carries text that
reads as an instruction and the model obeys it.

Held by one mechanism rather than by the model's judgement: external content
never enters the instruction channel. It is wrapped in a data envelope carrying
its provenance, the markers that delimit the envelope are neutralised inside the
content so it cannot close the envelope early, and forged control tags are
neutralised whatever their case. Separately, content that arrives taints its
task, and taint is what the egress gate consults later — so injected text that
persuades the model to send something out meets T-2 as well.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/prompt-injection.test.ts :: a page cannot close the envelope early to escape into the instruction channel
- EVIDENCE: tests/security/prompt-injection.test.ts :: neutralises forged SYSTEM_POLICY and USER_INTENT tags
- EVIDENCE: tests/security/prompt-injection.test.ts :: is case-insensitive when neutralising markers
- EVIDENCE: tests/security/prompt-injection.test.ts :: labels wrapped content as data with its provenance
- EVIDENCE: tests/security/taint-state.test.ts :: starts a task as explicitly clean, not as an empty unknown

What this does **not** do is classify content for hostility. There is no
injection classifier in this build, which is a deliberate divergence from the
benchmark and is recorded in `docs/architecture/CLAUDE_BENCHMARK.md`. The
envelope is a containment boundary, not a detector.

---

## T-2 — Data exfiltration

Task data, page content or a secret leaves the browser to a destination the user
did not intend.

Held by the egress gate, at one of two call sites, and by failing closed on every
form of missing information rather than on a judgement about the payload: no
established provenance is a denial, an unidentifiable destination is a denial,
and an uncomputable taint signature is a denial. A credential in the payload is
denied whatever the destination — including the task's own provider, which is the
case that matters, because that is the destination the agent has a legitimate
reason to use.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/egress-gate.test.ts :: denies when provenance was never established
- EVIDENCE: tests/security/egress-gate.test.ts :: denies even when the destination is the task’s own provider
- EVIDENCE: tests/security/egress-gate.test.ts :: denies an unidentifiable destination rather than falling back to the raw string
- EVIDENCE: tests/security/egress-gate.test.ts :: denies when the taint signature could not be computed
- EVIDENCE: tests/security/exfiltration.test.ts :: blocks any payload containing a credential, whatever the destination
- EVIDENCE: tests/security/security-invariants.test.ts :: has exactly two callers of the egress gate

---

## T-3 — Credential theft

A user's provider key or connector token is read by something that should not
have it.

Held by three separate things. The credential store is reachable only from the
service worker, so no panel, content script or tool has a path to it. The panel
can send a key it was typed and can never read one back, and no route response
type carries a credential field at all — a type-level guarantee rather than a
filter. At rest, K1 encryption fails closed against every way of moving,
relabelling or editing a ciphertext, so a stolen record is not a usable one.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/credential-boundary.test.ts :: 01 — only the service worker can reach the credential store at all
- EVIDENCE: tests/security/credential-boundary.test.ts :: 02 — the panel never reads a credential back, only sends one it was typed
- EVIDENCE: tests/security/credential-boundary.test.ts :: 03 — no route response type carries a credential field
- EVIDENCE: tests/security/k1-boundary.test.ts :: 01 — every way of moving or relabelling a ciphertext fails closed
- EVIDENCE: tests/security/k1-boundary.test.ts :: 02 — one connection’s ciphertext cannot be swapped in for another’s
- EVIDENCE: tests/security/external-tool-boundary.test.ts :: 06 — every credential kind stays local, and none of them is exportable

The residual is stated in `docs/architecture/K1_LOCAL_ENCRYPTION.md` and not
softened here: a local attacker holding the Chrome profile reads the API key if
K1 is off.

---

## T-4 — Malicious connector

A connector implementation, or the service behind it, tries to collect the token
it was given or to widen what it may do.

Held by keeping the token out of every surface a connector can influence: it
travels as an `Authorization` header and never in a URL, never in a tool result,
never in evidence, never in a log line, and never in the status a caller can
read. The audit trail refuses to record one even if a caller tries.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/connector-security.test.ts :: is sent as an Authorization header
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in a URL
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in a tool result
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in a log line
- EVIDENCE: tests/security/connector-security.test.ts :: is refused by the audit trail if a caller ever tries to record one

Scope limit: the only connector in this build is GitHub, and it has never been
run against the real service — `P-023-C8` is `EXTERNAL_REQUIRED` for that reason.
This item is about the framework's boundary, which is what a malicious connector
would have to cross.

---

## T-5 — Malicious MCP

An external MCP server this build connects to declares a harmless-looking tool,
names it to impersonate a built-in, floods the tool list, or offers a resource
whose content is an instruction.

This item said "there is no MCP transport, so the threat is not currently
reachable" and that is no longer true: a person can add a server and the agent can
call its tools, so the threat is live and this is now a claim about a working
surface rather than about a boundary waiting for one.

Held in six places, each of which closes one way a server could get more than it
should. Risk is fixed at R3 and `mcpToolRisk` takes no argument, so nothing a
server sends can declare it cheap — and R3 sits above `MAX_GRANTABLE_RISK`, so no
site rule and no plan can pre-approve one of its tools. Names are namespaced per
server, so a discovered name cannot shadow a built-in or forge another server's
namespace. The transport reaches the network only through the one egress gate,
refuses every redirect (there is no declared origin set to re-check a hop
against), and bounds the response twice. Discovery declines an unknown protocol
revision and bounds pagination three ways. Arguments are validated against a
schema compiled from a **subset** of the server's own JSON Schema, with `$ref`,
combinators and open `additionalProperties` refused by name. And removing a server
removes its tools with no residual grant, because nothing could have pre-approved
one. `docs/MCP_GUIDE.md` is the full record; forty-one mutants across those
clauses were each killed.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/mcp-trust-core.test.ts :: cannot be lowered by anything a server, a schema or a setting could supply
- EVIDENCE: tests/security/mcp-trust-core.test.ts :: sits above everything a grant can express, so approval is per call by construction
- EVIDENCE: tests/security/mcp-trust-core.test.ts :: cannot produce the name of a tool this project ships
- EVIDENCE: tests/security/mcp-trust-core.test.ts :: refuses a name carrying the separator, which could forge a namespace
- EVIDENCE: tests/security/mcp-trust-core.test.ts :: bounds the listing, because the count comes from the server too
- EVIDENCE: tests/security/mcp-transport-security.test.ts :: refuses a redirect rather than re-checking it, because nothing declared an origin
- EVIDENCE: tests/security/mcp-transport-security.test.ts :: does not surface an HTTP failure body, which the server wrote
- EVIDENCE: tests/security/mcp-discovery.test.ts :: bounds the total rather than each page, so splitting a listing does not evade the cap
- EVIDENCE: tests/security/mcp-schema.test.ts :: refuses every reference and combinator by name
- EVIDENCE: tests/security/mcp-tool-dispatch.test.ts :: is confirmed on every call, in manual, auto and skip alike
- EVIDENCE: tests/security/mcp-registration.test.ts :: removes its tools, and there is no residual grant to revoke
- EVIDENCE: tests/e2e/mcp.spec.ts :: a refused address never reaches the network

Resources are the sharper half of this threat, because a resource is content
rather than an action — the injection channel `PLUGIN_TRUST_MODEL.md` names. They
are held by treating them exactly as page text: bounded, `NEVER_PERSISTED`,
tainting the task, wrapped in T-1's envelope, with binary named rather than
decoded. Two rules are specific to them. The model may only read a URI the server
**offered**, so it cannot induce the server to fetch something the user never saw
listed. And a URI reaches neither an audit field nor a confirmation prompt: it is
page-derived text, so the prompt quotes the server's label instead.

- EVIDENCE: tests/security/mcp-resources.test.ts :: refuses a URI the server never offered, before any request
- EVIDENCE: tests/security/mcp-resources.test.ts :: summarises a read by the label, never by the URI
- EVIDENCE: tests/security/mcp-resources.test.ts :: taints the task, so a later write meets the exfiltration gate
- EVIDENCE: tests/security/mcp-resources.test.ts :: names binary content rather than decoding it
- EVIDENCE: tests/security/mcp-resources.test.ts :: are both R3, with no read-only exception for the listing

**Covered since the remote audit.** A real third-party server has now been
used: `tests/integration/mcp-remote-live.test.ts` drives the production path
against a public, credential-free remote MCP server over the public internet, and
P-026 is PASS. What the local server still establishes separately is the
`tools/call` path at R3 — the remote suite discovers and admits but deliberately
calls nothing, because invoking a stranger's tool is a different act from
listing it.

The inverse threat — something outside driving this extension over MCP — is not
in this list because it is not possible: this build is not an MCP server and
cannot become one. See `docs/MCP_GUIDE.md` §1.

---

## T-6 — Malicious plugin

An installed package adds a tool, a permission or a policy of its own.

**Verdict: `NOT POSSIBLE HERE`**

- REASON: There is no plugin layer. No package format, no registry, no installer
  and no loader exist, so there is nothing to attack and no test could
  demonstrate the threat without first building the thing that carries it.
  `docs/architecture/PLUGIN_TRUST_MODEL.md` settles what a plugin may safely be
  when one exists — declarative, referencing only already-registered tools,
  creating no tool, permission, egress, credential or policy — and records the
  reason P-025 is not merely unstarted: a package's _authenticity_ cannot be
  established from inside an extension, because there is no publisher identity
  to verify against and no revocation channel. This item becomes live with the
  loader, not before.

---

## T-7 — Malicious webpage

The page the agent is working on lies about who it is, or tries to authorise
itself.

Held by resolving site identity in the worker rather than accepting it: the
authorization scope comes from `chrome.tabs`, never from the model's arguments,
so a scope the model was talked into supplying has no effect. Site comparison
reduces to the registrable site, so a lookalike subdomain is not the same site.
Non-automatable origins are refused outright. And page content reaches the model
inside T-1's envelope.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/site-scoped-authorization.test.ts :: 06 the resolver reads the tab URL, never the tool arguments
- EVIDENCE: tests/security/site-scoped-authorization.test.ts :: 07 a model-supplied site scope in the arguments has no effect
- EVIDENCE: tests/security/origin-validation.test.ts :: does not treat a lookalike subdomain as the same site
- EVIDENCE: tests/security/origin-validation.test.ts :: refuses file: and ftp: even when insecure origins are allowed

---

## T-8 — Malicious downloaded document

A file arriving through the browser carries hostile content, or is used to reach
the filesystem.

Held by there being no filesystem surface to reach. No tool takes a path, no
tool reads or lists the filesystem, and a file selection returns metadata and
never contents. A file contributes taint that is monotone — page taint plus file
taint keeps both, and an unknown state cannot be downgraded by adding a file — so
a document's content cannot launder a task into looking clean.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/file-transfer.test.ts :: offers no tool that takes a path
- EVIDENCE: tests/security/file-transfer.test.ts :: exposes no tool that reads or lists the filesystem
- EVIDENCE: tests/security/file-transfer.test.ts :: returns metadata and never contents
- EVIDENCE: tests/security/file-transfer.test.ts :: is monotone: page taint plus file taint keeps both
- EVIDENCE: tests/security/file-transfer.test.ts :: cannot be downgraded by adding a file to an unknown state

No content inspection is performed. A downloaded document is treated as
untrusted rather than scanned, which is the same posture as T-1.

---

## T-9 — Model-hallucinated tool arguments

The model invents an argument that reaches something it should not — a selector,
a protocol method, a site, a tab.

Held by removing the argument shapes that would carry it, rather than by
validating them. The form tools take an element handle and never a selector or
an expression. No tool accepts a CDP method name, and the debugger allowlist
holds no script-execution method. Site scope is resolved, not supplied (T-7).
Every tool's arguments are schema-validated before dispatch, and a tool with no
schema cannot be registered.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/advanced-forms-security.test.ts :: takes an element handle, never a selector or an expression
- EVIDENCE: tests/security/debugger-allowlist.test.ts :: exposes no tool that accepts a CDP method name
- EVIDENCE: tests/security/debugger-allowlist.test.ts :: does not expose any script-execution method on the allowlist
- EVIDENCE: tests/security/prohibition-enforcement.test.ts :: 04 no tool evaluates model-supplied script
- EVIDENCE: tests/security/site-scoped-authorization.test.ts :: 03 the declaration is required, so a new tool cannot omit it

---

## T-10 — Origin redirect

The page moves between the moment the model was asked what to do and the moment
the action runs, so the action lands somewhere else.

Held by comparing two URLs the worker read from `chrome.tabs` — where the page
was when the model was asked, and where it is now — and confirming anything with
a side effect when they differ. Both sides come from the browser: a planned URL
appearing in the model's arguments is not the planned URL, which is the case that
would otherwise let the model paper over the drift it caused.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/origin-drift-producer.test.ts :: 01 the agent loop supplies a planned URL on every dispatch of a turn
- EVIDENCE: tests/security/origin-drift-producer.test.ts :: 02 the skill runner supplies a planned URL on every step
- EVIDENCE: tests/security/origin-drift-producer.test.ts :: 05 a planned URL in the model’s arguments is not the planned URL
- EVIDENCE: tests/security/origin-drift-producer.test.ts :: 04 a browser that cannot answer yields no planned URL rather than a guess

---

## T-11 — Tab confusion

A task acts on a tab that is not its own.

Held by resolving workspace membership from Chrome at dispatch rather than from
a stored list: every clause must be positively satisfied, and a detached
workspace, a deleted group, a tab that no longer exists, a binding belonging to
another workspace, or a tab the user has just dragged out are each a refusal.
A tool that takes an explicit tab id guards itself against the same rule, which
is a separate check from the one covering the run's ambient tab.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/workspace-membership.test.ts :: admits a tab only when every clause is positively satisfied
- EVIDENCE: tests/security/workspace-membership.test.ts :: refuses a binding that belongs to a different workspace
- EVIDENCE: tests/security/workspace-membership.test.ts :: refuses a tab the user dragged out, immediately
- EVIDENCE: tests/security/workspace-membership.test.ts :: refuses when Chrome has already deleted the group

---

## T-12 — Cross-task authorization leak

One task's approval, plan, file or provider binding is used by another.

Held by binding every authority to its task. A plan approval is bound to the task
it was given for, and an approval claiming any other provenance is refused rather
than downgraded. Staged files and pending picker requests are freed per task and
for no other. A provider pin belongs to an account, and a task bound to one
account treats another as a switch rather than a match.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/classic-plan-authorization.test.ts :: 05c — an approval is bound to the task it was given for
- EVIDENCE: tests/security/classic-plan-authorization.test.ts :: 06 — an approval claiming any other provenance is refused, not downgraded
- EVIDENCE: tests/security/file-lifecycle.test.ts :: frees staged files for that task and no other
- EVIDENCE: tests/security/file-lifecycle.test.ts :: cancels a pending request for that task and no other
- EVIDENCE: tests/security/multi-account-isolation.test.ts :: a task bound to one account treats the other as a switch, not a match

---

## T-13 — Duplicate writes

An action with an external effect runs twice — because a turn was retried, a
worker was evicted mid-step, or a migration re-ran.

Partly held, and the honest shape is worth stating. What is held: a write-capable
connector operation is declared non-idempotent and confirmed, so a repeat is a
decision rather than an accident; a migration re-run is a no-op rather than a
second write; a duplicate record id is refused rather than replacing what is
there; and the audit chain detects a duplicated sequence, so a repeat is at least
visible after the fact.

What is **not** held: there is no general de-duplication of browser actions. A
click that succeeded and whose result was lost to worker eviction can be clicked
again, and nothing in this build distinguishes that from an intended second
click. The recorder only keeps steps that executed and succeeded, which limits
the replay case but is not a guarantee about the live one.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/integration/connector-workflow.test.ts :: is declared as a confirmed, high-risk, non-idempotent operation
- EVIDENCE: tests/security/legacy-migration.test.ts :: 06 — re-running after a success is a no-op, not a duplicate
- EVIDENCE: tests/security/audit-trail-security.test.ts :: 3. detects a duplicated sequence
- EVIDENCE: tests/security/audit-trail-security.test.ts :: 4. detects a stale record written below the tail

---

## T-14 — Supply-chain attack

A dependency, or the packaging step, introduces code the author did not write.

Held by keeping the dependency surface small and the artifact reproducible. The
runtime dependency count is four, checked against installed licences on every CI
run; CI runs a dependency audit as its own job; and the release archive is
deterministic — fixed timestamps, path-ordered entries, no extra field and no
archive comment — so the same source produces the same bytes and a changed
artifact is visible.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/release-claims.test.ts :: fixes every timestamp rather than recording the build time
- EVIDENCE: tests/security/release-claims.test.ts :: orders entries by path rather than by whatever the filesystem returned
- EVIDENCE: tests/security/release-claims.test.ts :: writes no extra field and no archive comment

Two limits. Reproducibility proves the archive matches the source; it proves
nothing about the source. And no dependency is pinned by hash beyond the
lockfile, so this is defence by smallness and observability rather than by
verification.

---

## T-15 — Extension compromise

Something that is not the side panel sends a privileged message, or the
extension is made to execute code.

Held by classifying every sender and refusing every route to anything but the
panel: a content script, the worker itself, another extension-origin document and
another extension are each refused, as is a message with no sender or no origin.
The extension accepts no external connection of any kind — `externally_connectable`
is absent — and the source holds no code-execution primitive, with no `unsafe-eval`
in the CSP.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/route-trust-security.test.ts :: 1. refuses every route to a content script, and runs none of them
- EVIDENCE: tests/security/route-trust-security.test.ts :: 4. refuses every route to another extension
- EVIDENCE: tests/security/route-trust-security.test.ts :: 6. refuses a message with no sender at all
- EVIDENCE: tests/security/security-invariants.test.ts :: accepts no external connection of any kind
- EVIDENCE: tests/security/security-invariants.test.ts :: holds no code-execution primitive anywhere in the source
- EVIDENCE: tests/security/security-invariants.test.ts :: has exactly three message receivers, and every one checks its sender

---

## T-16 — API key leakage

A key reaches a log, an error body, an export, a tool result or the model's
context.

Held by redacting at the boundary and by never having the key in most of those
places to begin with. A provider error body cannot carry a credential into a
stored record. The export builder reads no credential and the import handler
writes none. Redaction is exercised against adversarial shapes — a secret
embedded in a sentence, a Luhn-valid number sitting next to an identifier — and,
importantly, against thousands of _non_-secrets it must leave alone, because a
redactor that corrupts ordinary ids is one that gets turned off.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/credential-boundary.test.ts :: 07 — a provider error body cannot carry a credential into a stored record
- EVIDENCE: tests/security/credential-boundary.test.ts :: 05 — the export builder reads no credential
- EVIDENCE: tests/security/secret-redaction.test.ts :: redacts a card number embedded in a sentence and keeps the sentence
- EVIDENCE: tests/security/secret-redaction.test.ts :: still redacts a card number sitting next to an identifier
- EVIDENCE: tests/security/secret-redaction.test.ts :: does not corrupt 5000 generated ids of every kind
- EVIDENCE: tests/security/connector-security.test.ts :: never appears in evidence

---

## T-17 — Excessive network egress

Code in this build reaches the network outside the guarded path.

Held by making the unguarded path fail. A bare `fetch` is refused, including one
given a `Request` object rather than a string; the guarded call is identified by a
token rather than by inspecting a stack, so it cannot be spoofed by a forged
string property; and no allowlist configured is a refusal rather than a
default-open. T-2's gate then governs what a permitted call may carry.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/network-interceptor.test.ts :: refuses a bare fetch
- EVIDENCE: tests/security/network-interceptor.test.ts :: refuses a fetch given a Request object rather than a string
- EVIDENCE: tests/security/network-interceptor.test.ts :: identifies the guarded call by a token, not by inspecting a stack
- EVIDENCE: tests/security/network-interceptor.test.ts :: does not treat a forged string property as the marker
- EVIDENCE: tests/security/network-interceptor.test.ts :: refuses when no allowlist is configured

---

## T-18 — Unauthorized file access

The agent reads or writes a file the user did not choose.

Held by construction: no tool writes to the filesystem, none reads or lists it,
none takes a path, and a selection request has nowhere to put a path even if one
were supplied. Files enter only through the user's own picker, and downloads need
an optional permission the user grants through Chrome's dialog.

**Verdict: `AUTOMATED`**

- EVIDENCE: tests/security/prohibition-enforcement.test.ts :: 03 no tool writes to the filesystem
- EVIDENCE: tests/security/file-transfer.test.ts :: offers no tool that takes a path
- EVIDENCE: tests/security/file-lifecycle.test.ts :: never carries a path, because the request has nowhere to put one
- EVIDENCE: tests/security/file-transfer.test.ts :: treats a request nobody answered as "no file", never as a selection
- EVIDENCE: tests/security/file-transfer.test.ts :: treats an explicit refusal as a refusal

---

## T-19 — A second person on the same Chrome profile

Two people share one Chrome profile, signing in and out of this extension. One
reads what the other did.

**Not held, and the threat is real rather than hypothetical, because this product
contemplates it in as many words.** `visibleTo()` hides another user's provider
accounts — "hidden, never deleted, and still there when that user signs back in"
— and the sync protocol contemplates "a second user signing in on the same
installation" registering a separate device row. So the product's own model has
two people at one installation.

What is actually scoped to `abaUserId` is provider accounts and identity state,
and nothing else. The task store, the audit trail, workflows, shortcuts and
evidence are namespaced per _kind_ and not per user, so after a sign-out and a
sign-in the Activity view shows the previous person's sites, tools and task
history, and `audit.export` writes them to a file.

The found error was in the record rather than in the code:
`IDENTITY_AND_SYNC.md` listed the threat as "Cross-user data access" against a
control that only ever covered accounts, so the document claimed more isolation
than exists. That row now says what it actually holds, and this item is the
honest statement of the rest.

**What it is not.** No boundary is broken to get at this. Both people have the
Chrome profile, and a Chrome profile is the operating system's own per-person
boundary — two people sharing one already share cookies, history and saved
passwords. This is a product asking whether it wants to be stricter than the
browser it lives in, which is why the answer is not obvious and not an
engineering call: scoping five stores by user means a storage migration that
touches K1 and sync, and it would be the wrong work if the intended boundary is
the profile.

**Verdict: `NOT POSSIBLE HERE`**

- REASON: There is no control to evidence. Isolating two people on one Chrome
  profile means scoping the task store, the audit trail, workflows, shortcuts and
  evidence by `abaUserId`, which is a storage migration touching K1 and sync — and
  it is the wrong work if the intended boundary is the Chrome profile, which is
  the operating system's own per-person boundary. That is a product decision, and
  it is recorded as C-5 in `docs/release/BLOCKER-CERTIFICATION.md`. Claiming any
  stronger verdict here would repeat the overstatement this item exists to
  correct.

---

## What this document does not cover

Four things, named so their absence is not read as coverage:

1. **The five undetected prohibitions.** §29 names nine prohibited categories.
   The policy engine refuses any call carrying one, in every mode — but five of
   them have no producer, because buying something, creating an account, deleting
   permanently and placing a trade are all ordinary clicks and this build infers
   no intent from a control. `PROHIBITION_ENFORCEMENT` in
   `src/policy/risk-classifier.ts` is the authoritative table and says which is
   which.
2. **Threats to the optional backend.** Identity, sync and the server's own
   surface have their own suites and their own documents; §82's list is about the
   browser agent, and a build with the backend switched off — the default — does
   not carry them.
3. **One unbuilt capability.** T-6 names a surface that does not exist, so its
   verdict is about the boundary that will meet the threat rather than about the
   threat having been met. T-5 was in this list and no longer is: MCP became
   reachable, so that item is now a claim about a working surface. Its own
   residuals are stated with it.
4. **Execution.** Every `AUTOMATED` verdict means a test exists and runs in CI.
   It does not mean a person has sat down with the product and tried to break it.
   §85 is where that lives and it has not been executed.
