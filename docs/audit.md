# The audit trail (P-038)

One append-only stream, across every task, of what the agent was asked to do
and what was decided. It answers "what happened on this site last week" —
which three partial views with different shapes and lifetimes could not.

It is deliberately thin. Every field is an identifier, a closed vocabulary, a
flag or a reference. It records _that_ something happened and _what was
decided_; anything larger is evidence, which already solved the problem of
holding content safely.

## It observes; it never authorises

The trail is written after a decision, never before one. Nothing reads it to
decide anything: no policy, no permission, no egress check and no tool
consults it, and the audit layer imports none of them. A source scan asserts
the layer contains no `dispatch`, `execute`, `fetch`, `eval`, `new Function`
or `Runtime.evaluate`, and no gate call at all.

The consequence that matters is what happens when a write fails. **A gap in
the record of an execution is not a failed execution.** A write that could not
land is surfaced as a degraded trail the panel shows, and the tool call that
already completed stays completed.

A record that fails validation is refused, and the refusal is _not_ itself an
audit event — recording a failure to record is a recursion whose base case is
the thing that just failed. It goes to the redacted worker log.

## Where records come from

For tool execution there is one source: the observation hook on
`ToolRegistry.dispatch`, which is the one execution authority.

```
ToolRegistry.dispatch
  → validation → risk → policy → permission → egress → execution → result
  → onDispatched (frozen, derived, after the fact)
      → audit adapter        ← drops the arguments here
      → sanitisation
      → validation
      → atomic append
```

Two observers now share that hook: the workflow recorder (P-022) and this
adapter. Each runs in its own `try`/`catch`, so one broken bystander does not
silence the other, and neither can reach the call it is watching. Ordering is
not a contract.

Lifecycle and decision events — task state, permission, egress, connector,
file, skill, workflow, shortcut — keep their own writers, which now all go
through the same schema and the same storage.

## What a record holds

| Kind      | Fields                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity  | `id`, `eventVersion`, `seq`, `prevDigest`, `at`, `type`                                                                                         |
| Subject   | `taskId`, `sessionId`, `workflowId`, `workflowVersion`, `shortcutId`, `skillId`, `skillVersion`, `skillHash`, `connectorId`                     |
| Decision  | `outcome`, `code`, `risk`, `executed`, `cancelled`, `permissionMode`                                                                            |
| Context   | `tool`, `ran`, `step`, `stepIndex`, `stepCount`, `origin`, `site`, `destination`, `tabId`, `providerId`, `modelId`, `providerMode`, `taintKind` |
| Reference | `evidenceIds`, `scopes`, `fileName`, `mimeType`, `byteLength`                                                                                   |

And what it never holds: arguments, results, page or DOM text, form values,
selectors, element handles or bindings, prompts and completions, provider
request or response bodies, credentials of any kind, screenshots, file or
clipboard contents, taint **sources** (which name sites the user visited) and
the taint **signature** (a consent key).

`detail` holds one sentence, written by the extension, about what happened —
"Saved under a different name because a file of that name already existed."
Its contract is the extension's **own vocabulary only**: never page text, never
model output, never a tool result. A summary drawn from a page belongs in
evidence, which is separate, digested, and not exported with the trail.

It was previously described here as removed. It was not: `FileAuditEvent`
carried it and reached `record()` as a variable rather than an object literal,
so TypeScript's excess-property check never fired and the field was stored
without being declared. It is declared now, and bounded, because a field the
store keeps but the schema denies cannot be bounded or reviewed.

### The limits

`src/audit/boundaries.ts` holds every limit, and is the only place that does.
The numbers are not repeated here, because two copies of a limit is exactly how
the last two of these bugs happened: a download filename was validated against
200 and recorded into a field bounded at 128, and an MCP server descriptor
bounded nothing while the tool name derived from it met a 256. Both times the
operation succeeded and the record of it was refused.

What is worth stating here is the _principle_ the file follows. A limit on a
value with an authoritative external bound is **derived from that bound** — a
filename from the filesystem's maximum, an origin from the longest name DNS
permits — so an ordinary long value can still be recorded. A limit on a value
with no external standard is the trail's to set, and the producer is then
**refused at its boundary** rather than accepted and silently unrecordable: an
over-long MCP server id is rejected when the server is added, and a model whose
id will not fit is not offered.

A record is flat: no nested objects, and lists only in `scopes` and
`evidenceIds`.

`tests/security/boundary-census.test.ts` checks the relation by running each
producer at its maximum and requiring this log to accept the result, so a limit
edited on one side of a boundary fails a test rather than reaching a user as a
lost record.

Everything over a limit is **refused, not trimmed**. Silent trimming is the
failure worth avoiding: a reader cannot tell a truncated field from a short
one, so a record that was too big quietly says something else.

And a field the redactor would alter is **dropped, not marked**. A `[REDACTED]`
left in an exportable record still tells a reader that a secret was there.

### Tool names

A tool name has model-controlled reach: a model can propose any string, the
registry refuses it, and the refusal is exactly the event worth recording — so
the proposed name arrives at the trail. It is checked against what this build
registered. An unrecognised name is stored as `(unknown)` and the proposed
string is dropped, so the trail cannot become a model-writable text field.

The check is supplied by the caller, and a log built without one records every
name as `(unknown)`. That default used to point the other way: with no
validator the name was kept as handed over, which made this paragraph describe
a control that was not running. A caller that cannot verify a name must not
have the trail assert the name is real, so the absence of a check is treated
as the absence of verification rather than as permission to trust.

## Order and integrity

Each record carries a sequence number allocated from what is persisted, and a
digest of the previous record's canonical form.

Order is read from `seq` and never from `at`. Clocks are adjusted, they drift,
and two records in the same millisecond tie, so a timestamp cannot carry
ordering.

`verifyIntegrity()` reports `ok`, `empty`, `gap`, `reordered`, `chain-broken`,
`truncated`, `future-version` or `corrupt`, and the panel shows it.

**This is corruption and reordering detection. It is not tamper protection.**
The chain is an unkeyed digest, so anyone who can rewrite this extension's
storage can rewrite the chain along with it — there is no key here that they
would not also hold. Putting one in session storage would lose it on every
browser restart, which is exactly the interval the trail exists to cover. What
this catches is what actually goes wrong: a partial write, a dropped or
duplicated record, one out of order, and a record from a format this build
cannot read. Calling it anything stronger would be a claim the architecture
cannot support.

## Retention

At most 5000 records, 8 MiB, and 30 days — whichever is reached first.

**Eviction is never silent.** Every compaction writes a `retention.compacted`
record naming how many records left and the sequence range they occupied, and
it is written in the same storage transaction as the eviction that caused it.
There is no committed state in which records are gone and the marker
explaining them does not exist.

Compaction happens in batches rather than one record at a time, because a
trail at its limit would otherwise evict on every append, and a stream that is
half retention markers is a worse record than one with occasional, precisely
described gaps.

If a write fails, the log compacts and retries once. A second failure is
reported as a degraded trail rather than pretended away.

## Reading it

The Activity view in the side panel: 50 records a page, newest first,
filterable to the current task, with the integrity verdict shown and retention
markers rendered as the gaps they are.

There is **no delete**. A trail the audited thing can erase is not a trail,
and a privacy control for clearing history is a separate decision from making
the history trustworthy. The internal `clear()` is not reachable from the
panel or from anywhere a model can go.

## Export

Local only. The panel builds a blob of this extension's own origin and hands
it to the browser through an anchor the user's click activates.

That needs **no permission at all** — not `downloads`, which stays optional
and unrequested. There is no `chrome.downloads`, no clipboard, no `fetch`, no
network and no URL parameter anywhere, so there is nothing for a model or a
page to point somewhere else. The filename is built from a timestamp and a
fixed word.

The scope is **required and never inferred**. One task and every task are
different things to be handed, and the worker has no way to know which one a
caller is looking at, so an omitted scope is an incomplete request rather than
a default — it is refused, in either direction. So is a scope this build does
not recognise exactly: an unknown kind, a task id that is not an identifier,
or extra fields. A refused scope produces **no document at all**, because
building one and discarding it would run the export sanitiser over records
that were never authorised to leave.

The two buttons in the panel are a usability choice, not the boundary. What
makes an all-task export explicit is the scope in the request and the class of
the sender, both checked in the worker — a caller that never rendered a button
meets exactly the same two checks.

The artefact states its format, its scope, the sequence window it covers, the
integrity verdict and a notice of what it does not contain — and sanitisation
runs again on the way out, against a record that might have been edited
underneath the store.

## Not reachable by a model

There is no `audit.*` tool, and none appears in the schemas a model is
offered. `audit.list`, `audit.integrity` and `audit.export` are panel
messages, and panel messages and model tool calls are disjoint surfaces: a
model's calls go through `AgentRuntime` to `ToolRegistry.dispatch`, which
never touches the message router.

Panel messages are themselves restricted to the panel. Every route is
classified and the router refuses a sender it has not positively identified,
so the audit routes are unreachable from a content script as well as from a
model — and unreachable because they are checked, not because nothing
currently sends them. See [security.md](security.md#route-trust).

A refused message is itself recorded, as a `route.refused` record carrying the
route name and a closed sender class. Never the sender's URL: a URL is
page-derived, and page-derived text does not enter this trail.

## Every declared type is one something writes

`AUDIT_EVENT_TYPES` is a closed union, and a type in it with no producer is a
promise the trail makes about itself and does not keep: a reader filtering for
it finds nothing and cannot tell "it never happened" from "nothing ever writes
it". Two types were in exactly that position from the first audit wave until
the P-038 gap audit went looking — `provider.state` and `recovery`, declared,
never written, and surviving a full rewrite of the module in between. Both are
gone; `provider.selected` already covers which brain is in use, and
`persistence.health` already covers the recovery acknowledgement.

A test now counts it. Every declared type must appear somewhere in `src/`
outside the audit module, with comments stripped so a mention in prose cannot
satisfy it. `retention.compacted` is the one exception, written by the log
itself, and it is named in the test rather than pattern-matched away.

This matters beyond tidiness: it is what stops a future capability declaring
its lifecycle events before it can emit them.

## Every authority-changing action is one something records

The section above guards one direction: a declared type must have a producer.
Nothing asked the other way round, and the other way round is the one that
matters more — does every action which changes what the agent may later do have
a type at all?

Twelve did not, and the census that found them is
`tests/security/audit-coverage-census.test.ts`. What makes each an omission
rather than a scope decision is that each had an audited counterpart sitting
beside it:

| Action                                                           | Recorded nothing      | Its counterpart, already recorded          |
| ---------------------------------------------------------------- | --------------------- | ------------------------------------------ |
| `session.setPermissionMode`                                      | the mode change       | `policy.site_rule`, for one site           |
| `shortcut.create` / `retarget` / `remove`                        | the configuration     | `schedule.created` / `updated` / `deleted` |
| `storage.setPreference`                                          | where records live    | —                                          |
| `data.export` / `data.import`                                    | the boundary crossing | —                                          |
| `workflow.remove`                                                | the deletion          | `workflow.recorded`                        |
| `audit.export`                                                   | the trail leaving     | —                                          |
| `k1.enable` / `disable` / `unlock` / `lock` / `changePassphrase` | all of it             | —                                          |

Two of these are worth stating plainly.

**Switching to `skip`** removes the confirmation step from every subsequent
action for as long as it stands. It is a broader grant than any single site rule
by a wide margin, and revoking one site rule wrote a record while this wrote
nothing. `session.permission_mode` now carries the new mode and the one it came
from, and its `outcome` is the _direction_ — `allowed` for a tightening,
`denied` for a loosening, the same sense `policy.site_rule` uses for a grant and
a revocation. A reader should not have to find the previous record, which
retention may already have evicted, to learn which way the authority went.

**K1** is the larger one. Local encryption is what protects the provider API
keys and connector credentials in this profile, and none of switching it on,
switching it off, changing its passphrase, locking or unlocking wrote anything.
`k1.disable` is the action `k1.protection` most exists for: it takes the
protection off the only `SECRET_LOCAL_ONLY` material here, and without a record
a profile found later with plaintext keys cannot be distinguished from one where
protection was never switched on. A _failed_ unlock is recorded too, with the
closed `UnlockFailure` reason as its code, because repeated `WRONG_PASSPHRASE`
records are the one observable sign of somebody working through passphrases —
which is precisely the scenario [K1's own threat
model](architecture/K1_LOCAL_ENCRYPTION.md) names. Never the passphrase, never
its length and never a digest of it: a record that narrowed the guessing space
would weaken the thing it reports on.

### How the census stays honest

Every `CLASS_B_PANEL_CONTROL_PLANE` route either records in its own handler or
is named in the census's `EXEMPT` table with one of exactly two reasons: **a
downstream producer**, which the test then checks is a declared type, or
**nothing to record**. A third test rejects a stale entry, so a route that
starts recording has to leave the table. The next control-plane route added
therefore has to choose, in review rather than in a later audit.

The table also holds two _settled_ decisions rather than gaps, so that a future
reader does not reopen them: `provider.connect` records nothing because
`provider.state` was declared-and-never-written and was deleted on the stated
grounds that `provider.selected` covers which brain is in use; and `mcp.refresh`
records nothing because a tool set is a fresh reading on every registration
rather than a state that changes.

Three details of the census are worth keeping, because each cost a cycle:

- It **imports `PANEL_ROUTE_CLASSES`** rather than matching route names out of
  the source. The manual sweep that preceded it used `[a-zA-Z.]` for a route
  name, and every `k1.*` route — five of the twelve, and the most consequential
  of them — was silently absent from its results.
- It splits handlers **by brace balance**, not by a line window, so a record
  belonging to the following route cannot satisfy this one.
- It matches **whitespace-collapsed**, because asserting the literal text of a
  call the formatter may reflow is a test that fails on formatting.

The Activity view renders the record's `code` for the same reason the code is
recorded: locking and switching protection off are both `k1.protection` with a
`denied` outcome, and a row showing only the type and the outcome could not tell
a safety action from the removal of the safety.

## What is still missing for P-038

Stated so the PARTIAL is a description rather than a shrug:

- **The §85 A–F manual acceptance scenarios** have not been run, for this
  capability as for every other.
- **Query is narrower than the record.** `AuditQuery` filters on `taskId` and
  `site`. Every other correlation the record supports — by workflow, shortcut,
  schedule, run, connector, skill — is available to a reader of the export or
  the page, but not as a server-side filter. That is a UI and route change, not
  a model change, and nothing is blocked by it.
- **Deletion is not offered at all.** The trail compacts on its own bounds and
  the panel has no delete. Whether a user may delete their own audit records,
  and whether such a deletion is itself recorded, is a product decision nobody
  has taken. The current position — no deletion, bounded retention, a
  `retention.compacted` marker where records were dropped — is defensible and
  is what ships.

## Scope

P-038 added no Chrome permission, no host permission and no execution
primitive. The manifest is unchanged.

P-038 being implemented is a statement about P-038. It is **not** parity
certification — see [`PARITY_MATRIX.md`](../PARITY_MATRIX.md), where the §85
manual acceptance scenarios remain unexecuted for every capability.
