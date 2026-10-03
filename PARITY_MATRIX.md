# Capability parity matrix

Tracks each mandatory capability (P-001 … P-040) from the specification
against what this repository actually contains.

**This project does not claim baseline capability parity.** This document
exists so the gap is visible rather than implied.

An earlier revision of this paragraph said "most capabilities are not
implemented", which was true when it was written and is not now: thirty rows
carry full automated evidence. What has not changed is the thing the sentence
was guarding — §84 condition 3 is unmet repository-wide, so no row here is
§84 PASS and the project still claims no parity.

## Parity is not the same measure as a stage

This file measures one thing: progress toward full capability parity across
P-001…P-040. It is deliberately unforgiving, and it will read as "a long way
from done" for as long as that is true.

It is **not** a measure of whether a delivery stage is complete. A stage has
its own defined scope, and a capability outside that scope does not hold the
stage open. The two are reported separately, and the expected state for some
time is:

| Measure                   | Status                                                           |
| ------------------------- | ---------------------------------------------------------------- |
| Stage 2 scope             | see `docs/stage-2-status.md`                                     |
| Overall capability parity | **PARTIAL** — the table below, and it is the only thing it means |

Reading a PARTIAL or NOT-STARTED row here as a stage blocker is a mistake that
has already been made once in this repository's history. A row's status
answers "is this capability finished and proven?", never "does this block the
current stage?". The second question is answered against the stage's scope,
not against this file.

## How to read a status

The authoritative specification is committed at
[`docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`](docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md).
Every section reference below points into it.

Specification §84 sets **six** conditions for PASS:

1. implementation exists;
2. automated test exists where technically possible;
3. **manual acceptance test exists;**
4. failure path is tested;
5. security path is tested;
6. evidence is recorded.

### What the PASS column in this file actually means

It means conditions 1, 2, 4, 5 and 6 — **automated** evidence. Condition 3 is
**not met by any row**, because the manual acceptance tests are the §85 A–F
scenarios and none has been executed or recorded. Those scenarios span
connectors and three providers, so they belong to Phase 10 (parity
certification) in §96, not to the automated suites.

An earlier revision of this file listed five conditions and omitted the manual
acceptance test entirely, which quietly lowered the bar it was measuring
against. The wording is corrected here rather than the column being relabelled,
because the column is genuinely useful — it just does not, on its own, satisfy
§84. **No row in this file should be read as §84 PASS**, and the project
cannot claim parity under §99 until the §85–§89 acceptance tests are run and
recorded.

The `Status` column below records **automated-evidence status**. It is not, and
must not be read as, **full parity certification** under §84 — that requires the
manual acceptance tests and is Phase 10 work.

| Status            | Meaning (automated-evidence status)                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `PASS`            | §84 conditions 1, 2, 4, 5 and 6 met. Condition 3, the manual acceptance test, is unmet repository-wide |
| `PARTIAL`         | Implemented and tested, but some condition is unmet — the gap is stated                                |
| `INTERFACES-ONLY` | Interfaces exist; no working implementation. Calls raise `NOT_IMPLEMENTED`                             |
| `NOT-STARTED`     | Nothing exists                                                                                         |
| `BLOCKED`         | Cannot proceed until something external changes; the blocker is named                                  |
| `DEFERRED`        | Deliberately postponed to a later phase, with the reason recorded                                      |

"Automated" counts unit, integration and end-to-end tests. The E2E column means
the capability was exercised against the built extension running in a real
Chromium — not simulated.

### Clause-level evidence, and how to add it

The yes/— columns say a test exists in a category. They cannot say whether the
capability does what its specification section asks, and twice that difference
has hidden a real defect. So `parity-evidence.json` also carries a **clause
inventory** for a growing subset of capabilities, and `scripts/check-parity.mjs`
refuses a PASS whose mandatory clauses are not evidenced.

A clause looks like this:

```json
{
  "id": "P-019-C1",
  "specRef": "§53",
  "requirement": "Notify when a task completes.",
  "mandatory": true,
  "status": "VERIFIED",
  "evidence": ["tests/e2e/notifications.spec.ts :: a task that finishes tells the user, once"]
}
```

**Evidence names a test, not a file.** That is the whole mechanism. Citing
`notifications.spec.ts` would let any test in it stand for any clause, which is
exactly how a capability came to read PASS while two thirds of its specification
section was unimplemented. The title must appear in that file as a complete
string literal, so renaming the test breaks the citation rather than silently
detaching it.

A clause carries one of six states:

| Status              | Means                                                 | Blocks PASS |
| ------------------- | ----------------------------------------------------- | ----------- |
| `VERIFIED`          | A named test establishes it                           | no          |
| `PARTIAL`           | Some of the clause is covered, some is not            | **yes**     |
| `EVIDENCE_MISSING`  | Nothing establishes it. The honest default            | **yes**     |
| `MANUAL_REQUIRED`   | Only a person can establish it — §84 condition 3      | no          |
| `EXTERNAL_REQUIRED` | Needs a credential or service nobody here holds       | no          |
| `AMBIGUOUS`         | The specification does not say plainly enough to test | no          |

Anything other than `VERIFIED` needs a `note` saying why; `MANUAL_REQUIRED` also
needs an `acceptance` reference and `EXTERNAL_REQUIRED` a named `blocker`.

**The three non-blocking states are not leniency.** They are the other gates.
§84 condition 3 is unmet repository-wide and is tracked in
`docs/testing/acceptance/` — where it is now answered **per capability** in
`84-capabilities.md`, because condition 3 is stated per capability and this file
had only ever answered it in the aggregate; a missing credential is tracked there too. Folding
either into this check would make them indistinguishable from an automated
gap, and the distinction is the reason the matrix can say what it does. An
`AMBIGUOUS` clause is a specification question to escalate: resolving it against
the implementation would be as much a guess as resolving it in the
implementation's favour, and this file's rule is not to guess either way.

To add a clause: read the specification section, write the requirement in one
faithful line, keep the real `§` reference, find the test that actually
establishes it, and cite it by title. If no such test exists, say
`EVIDENCE_MISSING` and let the build tell you. Do not widen an existing citation
to cover a clause it does not test — the gate is built to catch that, and
`tests/unit/clause-gate.test.ts` proves it does.

Six of the forty capabilities have an inventory today. `check-parity.mjs` prints
that count on every run, because a gate covering a sixth of the matrix and
saying nothing about the rest reads as a gate covering the matrix.

### Every claim in this table is checked

The yes/— columns are **not** assertions. Each one is derived from
`parity-evidence.json`, which names the test files backing it, and
`scripts/check-parity.mjs` fails the build when a column claims coverage that
is not cited, when a cited file does not exist or sits in the wrong category,
or when the matrix under-reports coverage that does exist.

This exists because a previous revision claimed integration coverage for three
capabilities (P-001, P-035, P-040) that had no integration test at all, and
simultaneously under-reported two (P-008, P-039) that did. The arithmetic was
self-consistent throughout, so a self-consistency check could never have caught
it. A security citation names the test exercising the control that guards the
capability, not necessarily a test of the capability itself.

---

## Summary

| Status          | Count  |
| --------------- | ------ |
| PASS            | 36     |
| PARTIAL         | 3      |
| INTERFACES-ONLY | 0      |
| NOT-STARTED     | 1      |
| **Total**       | **40** |

These counts are checked against the table below, and the table against
`parity-evidence.json`, by `scripts/check-parity.mjs`, which CI runs. Two
separate classes of error have actually occurred here: a revision that claimed
17 PASS while its own table said 23, and a revision whose per-column coverage
claims were not backed by any test. The check now covers both.

Movement in this revision: notifications (P-019) move **from PASS to
PARTIAL**, taking PASS from 30 to 29 and PARTIAL from 8 to 9. That direction is
unusual enough to say plainly why: the row was never PASS on the merits. It
gained security and real-Chromium coverage in the same revision, and it is
still not PASS, because the capability is measured against specification §53
and §53 names six things to notify for. Two were implemented. The reason is
below.

Movement since: multi-tab (P-012) moves **from PARTIAL back to PASS**, taking
PASS from 27 to 28 and PARTIAL from 11 to 10. Both §10 clauses the clause gate
reported are now built rather than argued away — `tabs.move` and `tabs.get` by
id — and the row also gains its integration column. What that PASS means is
unchanged: §84 condition 3 is still unmet repository-wide, here as everywhere.

Then notifications (P-019) moves **from PARTIAL back to PASS**, taking PASS from
28 to 29 and PARTIAL from 10 to 9. The clause that had no producer now has two,
both in the worker's task lifecycle layer. Building it turned up a second blank
record on the way, described below.

Then the capability doctor (P-035) moves **from PARTIAL to PASS**, taking PASS
from 29 to 30 and PARTIAL from 9 to 8 — §14's ninth minimum check now exists as
a real probe. And loop detection (P-037) keeps its PASS with its one AMBIGUOUS
clause resolved by an explicit decision rather than left open; the clause gate
now reports no ambiguous clause at all.

Then scheduled tasks (P-020) and the audit trail (P-038) move **from PARTIAL to
PASS**, taking PASS from 32 to 34 and PARTIAL from 6 to 4. Both were PARTIAL on
§84 condition 3 alone — P-020's entry said so in as many words — plus, for
P-038, three stated limits, the one of which §38 does not require now carried as
a non-mandatory clause. Shortcuts (P-021) stays PARTIAL, for a reason that is
now precise rather than general: two fields §50 names are deliberately not
implemented.

Then forms (P-006) and download (P-011) move **from PARTIAL to PASS**, taking
PASS from 30 to 32 and PARTIAL from 8 to 6. Neither moved because anything was
built. Both were PARTIAL on reasons that, written into a clause inventory,
turned out not to be unmet mandatory clauses: for P-006 a set of documented
design choices and one limit §5.2 does not require, and for P-011 a Chrome
dialog no automation can reach, which is the manual gate every other row here
also has open. Keeping them PARTIAL for that while thirty other rows read PASS
with the same manual gate outstanding was an inconsistency in this file, not a
stricter standard.

No status moves in this revision, and the reason is worth stating: the audit
census found twelve authority-changing actions that recorded nothing, and closing
them strengthens a row (P-038) that already read PASS rather than moving any row.
A count that only ever rises when a gap is found would be measuring the finding,
not the product. P-038 gains a mandatory clause — **P-038-C11** — taking the
inventory from 262 clauses to 263.

What it found: `AUDIT_EVENT_TYPES` was guarded in one direction only. Every
declared type must have a producer, which stops a capability announcing its
lifecycle events before it can emit them, and nothing asked the reverse — whether
every action that changes what the agent may later do has a type at all. Twelve
did not, each with an audited counterpart beside it. Switching the permission
mode to `skip` wrote nothing while revoking a single site rule wrote a record.
Creating, retargeting and removing a shortcut wrote nothing while all three
schedule lifecycle events existed. And K1 — enable, disable, unlock, lock,
passphrase change — wrote nothing at all, including a failed unlock, which is the
one observable sign of the scenario K1's own threat model names. `docs/audit.md`
carries the full table and the reasoning; the guard is a census over every
control-plane route, which now has to record or to be exempt with one of two
stated reasons.

The same census's failure-cleanup pass found a thirteenth, in a different
place: a debugger attachment outlived the task that made it. Nothing detached
when a task ended — the only two paths were the tab closing and the worker
shutting down — so a cancelled task left Chrome's debugging banner standing over
a page the person went on browsing. It was never an authorization hole, because
every `debugger.*` call is policy-evaluated on its own, but the banner is the
user's one signal that deep inspection is active and it was saying something
untrue. P-014 gains **P-014-C6**, taking the inventory to 264 clauses. Its row
does not move either: it already read PASS.

The Part 8 release audit then found a fifteenth, by reading the shipped bundle
rather than the source: four copies of the same loopback predicate. Six places in
source asked whether a host is the local machine, each in order to relax the
https rule that keeps an API key off a network in the clear. Five were
character-identical under three different names, and the sixth — in
`checkNavigable` — tested for `'::1'` where `URL.hostname` produces `'[::1]'`, so
its IPv6 case never matched and an IPv6 loopback page was treated as insecure. It
failed closed, which is why nothing caught it, and a duplicated security
predicate that has already diverged once will diverge again. There is one
`isLoopbackHostname` now, with a census asserting one definition and that the
body appears nowhere else under any name. P-005 gains **P-005-C8** and the
inventory reaches 266.

Part 10 found the same shape once more, in the acceptance packages: the script
checked that every item present owes a verdict and that every citation resolves,
and nothing checked that the items present are the items the specification asks
for. A scenario dropped from a package was invisible. All six packages did cover
their sections — measured, not assumed — so this is a guard rather than a repair,
and it is written because the two previous times a set went unchecked here it had
already drifted by the time anybody looked.

The same pass found the census table in `docs/security.md` had itself drifted:
two of its six rows disagreed with the suite they point at — nine manifest
permissions against ten asserted, three network-primitive files against four —
while the table's own text says a number changing there "is either a deliberate
architectural decision … or it is the thing this file exists to catch". Nothing
checked it. Every row is now read out of the document and compared against what
the suite asserts, and a seventh row was added for the assertion the table
omitted.

The Part 6 cross-capability pass then found a fourteenth, between shortcuts and
the local export boundary and going the other way from every other rule there.
Shortcuts export whole, including the two narrowings §50 names, and the importer
called `create(name, target)` with no options — so a shortcut restricted to one
read-only tool under `confirm-each-action` came back able to use every tool at
the ambient mode, under the name the person had learned to trust. The direction
is why it survived a suite full of boundary cases: every other rule there stops
something privileged travelling, and such a suite cannot see a _restriction_ that
fails to travel. Both fields are now carried and re-validated with the create
route's own checks, and the round-trip case is verified by mutation — restoring
the option-less `create` kills it. P-021 gains **P-021-C9**, taking the inventory
to 265. Its row does not move: it reached PASS in the previous revision.

Five of those twelve were missed by the manual sweep that found the first seven,
because that sweep matched route names with a pattern that excluded a digit and
`k1.*` never appeared in its results. The census imports the real route table
instead, which is the whole reason it imports rather than matches.

### The clause gate, and the two rows it moved

`parity-evidence.json` carries a **clause inventory for all forty capabilities** — 256 clauses — and
and `scripts/check-parity.mjs` refuses a PASS whose mandatory clauses are not
evidenced. Clause evidence names a _test_, not a file — `file :: exact title` —
because citing a whole file is exactly the move that let P-019 read PASS while
implementing two of §53's six notifications, and let P-017 and P-032 read PASS
while pausing a task destroyed it.

Running it for the first time moved two rows, both for reasons the Wave 11 audit
had already established and neither of which was fixed in this wave:

- **P-012 Multi-tab** → PARTIAL. §10 lists `tabs.move`, and no tool exposes it;
  `BrowserAdapter.moveTab` is implemented and called by nothing. §10's `tabs.get`
  has no get-by-id either. _(Both built in the following wave; see
  P-012 below. The finding is left as written because what the gate reported
  when it first ran is the thing worth keeping.)_
- **P-035 Capability doctor** → PARTIAL. §14 lists context capacity among the
  minimum checks and requires that every connected model be tested; the context
  window is copied from an advertised table and never measured.

Nothing was cited to make those rows keep their PASS, which was the point. Eight
of §14's nine checks and ten of §10's eleven tools are evidenced clause by
clause; the two that are not now say so in the matrix rather than only in an
audit report.

### The inventory is complete, and what that does and does not mean

Every one of the forty capabilities now has a clause inventory: 256 clauses,
each naming the specification section it comes from and, where it is VERIFIED, a
specific test by title. The check refuses a PASS whose mandatory clauses are not
evidenced, so from here a row cannot quietly drift into claiming more than it has.

What it changed, and what it did not. Thirteen rows moved as a direct result —
most of them because writing the clauses out showed the row was PARTIAL for §84
condition 3, which is unmet repository-wide and which every PASS row already
carries, rather than for an unmet mandatory clause. Two rows moved because
something was actually built. Nothing moved because a standard was relaxed, and
the two NOT-STARTED rows stayed exactly where they were at the time: P-025 and
P-026 carried fifteen `EVIDENCE_MISSING` clauses between them, which is the
honest reading of "not started" rather than a blank. P-026 has since been built
and moved to PARTIAL; P-025 has not moved.

It also caught five citations of mine that named a test which does not exist.
Every one was a title I half-remembered rather than a real gap in coverage —
which is the finding: the evidence was there and my recall of its wording was
not, and a broad file citation would have hidden that completely.

What it is **not** is parity certification. §84 condition 3 requires manual
acceptance, none of which has been executed, and the six clauses below are
waiting on a person, a credential or a service.

### §84 conditions 4 and 5, answered per capability

§84 defines PASS as six conditions, and three of them had no per-capability
answer anywhere in this repository. Condition 3 — "manual acceptance test
exists" — is now answered forty times in
[`84-capabilities.md`](docs/testing/acceptance/84-capabilities.md). Conditions 4
and 5 — "failure path is tested" and "security path is tested" — are answered in
`parity-evidence.json`, beside the clause inventory they point at, and
`check-parity.mjs` enforces the answers.

**The question that forced it is in the table below.** Eleven rows read PASS
with their Security column at `—`: P-001, P-007, P-013, P-017, P-018, P-031,
P-032, P-035, P-036, P-037 and P-040. A dash was carrying two opposite meanings
— "this capability has no security path" and "it has one and nothing tests it" —
and nothing distinguished them. Six of the eleven turn out to be the first, and
each now says so in a sentence somebody had to write. The other five had a
security clause all along and the dash was simply not where it was recorded.

Two shapes are allowed and only two. A condition **names clauses**, which must
exist and, on a PASS row, must be `VERIFIED` — a PASS resting on an unproven
clause is exactly what this gate refuses. Or it **states an exemption in prose**,
which no script can check and is not meant to be: it exists so a reviewer reads
a claim and can disagree with it. Fifteen capabilities carry one, ten for
condition 4 and six for condition 5, and they fall into recognisable kinds — a
setting rather than an operation (P-027, P-028), a wrapper whose failure belongs
to its target (P-020, P-021), a control that can only ever stop work and never
permit it (P-036, P-037), and a capability that adds no authority to the task it
runs inside (P-017, P-018, P-032).

Silence is the one answer that is not allowed. Five mutations confirm it: a
capability answering neither condition, a one-word exemption, a named clause
that does not exist, a PASS row resting on a `PARTIAL` clause, and an answer
given both ways at once.

What this does **not** do is move a row. Every one of these answers was already
true of the tests that already ran; what was missing was the mapping from §84's
words to them, and a mapping is not evidence. Conditions 1, 2 and 6 remain
answered by the table's own columns and by the clause inventory respectively.

### P-025 Plugins — an internal specification requirement, not a parity gap

The row stays **NOT-STARTED**, and nothing below moves it. What changed is what
the row is a gap _against_, which had never been adjudicated: specification §5.10
lists eight plugin clauses under "the mandatory parity baseline", and that word
had been carrying an assumption nobody checked.

The locked goal measures against **the Claude browser extension**. `CLAUDE_BENCHMARK.md`
§2 already established that a single "Claude Extension behaviour" does not exist —
the side panel runs in two modes — and §4a now states which mode each documented
capability belongs to. Plugins belong to the **Cowork-session** mode, where the
panel runs as a cloud session and the plugins are ones a person "already built"
elsewhere, "with nothing to set up in the browser". They are absent from the
documented **classic**-mode capability list. Classic is the mode this project
reproduces — workflow recording, shortcuts, scheduled tasks, console and network
inspection, multi-tab, background continuation — and the specification's own
baseline says so: "record workflows in the classic side panel" (§1). The two modes
are partly disjoint, not nested: recording is unavailable in Cowork mode.

So there are two routes to plugin parity and neither is a parity obligation.
Reproducing the **mechanism** means running the agent as a cloud session, which
the locks forbid — standalone, local-first, no cloud runtime dependency.
Reproducing the **capability** locally means a declarative plugin format over
already-registered tools, which is possible and is this project doing something
the comparison extension is not documented to do.

**The adjudication: P-025 is an internal specification requirement (§5.10) and is
not demonstrated as Claude-in-Chrome extension behaviour.** The specification
keeps the clauses; the Claude-Extension-parity critical path does not carry them.
`CLAUDE_BENCHMARK.md` §4b is the full record with each fact's evidence class, and
`parity-evidence.json` now classifies all eight clauses — seven
`INTERNAL_SPEC_ONLY`, and `P-025-C5` `CONFLICTS_WITH_LOCKED_ARCHITECTURE`, because
a plugin-bundled MCP server that "runs on your computer" needs native messaging or
local process execution, both prohibited here, which the clause's own "where
supported" qualifier resolves.

Three things this deliberately does **not** do. It does not delete P-025 from the
specification. It does not move any clause off `EVIDENCE_MISSING`, because none of
them acquired evidence — the finding is about which baseline they answer to, not
about whether they are built. And it does not convert documented silence into a
denial: no Claude-in-Chrome source describes a plugin registry, manifest,
permission model, trust metadata or lifecycle as extension behaviour, and that is
recorded as silence.

One further finding, recorded because it is about this repository rather than
about Claude. The specification's own §1 routes plugins "through the broader the
reference AI environment"; §2 names nine runtimes and **no plugin runtime**; §4's
"what we are actually reproducing" architecture diagram **omits plugins
entirely**. Three places in the specification treat plugins as environment rather
than as extension, and §5.10 is the one place that does not. Whether that
broadening from "the reference extension" to "the broader reference AI
environment" was ever explicitly decided is not recorded anywhere in this
repository — the evidence for such a decision is **absent**, which is stated here
as an absence rather than settled in either direction.

### P-026 MCP — why PASS

**P-026 MCP** — An MCP _client_ is built and reachable: a person adds a server in
Settings, the worker discovers it, and its tools and resources appear in the set
the model is offered, each confirmed on every call. All thirteen clauses are
VERIFIED.

It was PARTIAL for one reason only — **no MCP server that somebody else operates
had been reached** (`P-026-C2`) — and that is no longer true. The blocker read
_"a real remote MCP server, and any credential it requires. This repository holds
neither."_ The second half was an assumption. Public, documented,
credential-free remote MCP servers exist; one answered a conformant `initialize`
on the first attempt, and `tests/integration/mcp-remote-live.test.ts` drives the
production transport, discovery, admission and schema compiler against it over
the public internet. The suite is opt-in on `MCP_REMOTE_TEST_URL` and skips
without it, because a build whose green depends on a third party's uptime is the
reason `mcp-interop` runs a local reference server rather than a hosted one.

The consistency argument that previously held this row down now supports it
rather than blocking it. P-023 and P-033 are PARTIAL because nothing has met a
real third party; P-026 now has. The standard is unchanged — this row clears it
and those two still do not.

This paragraph previously gave two more reasons, and both were wrong by the time
the final audit re-read them. It said resource discovery was unbuilt; it was
built in a later wave, and `P-026-C5` has been VERIFIED since. And it said local
MCP "needs a bridge the specification defers", which is what kept `P-026-C3`
classified external. That was not true either:
`@modelcontextprotocol/server-everything` is the MCP project's own reference
server, it speaks Streamable HTTP with no bridge at all, and it needs no
credential, account or third party — so the classification was hiding work that
was possible from the start. It is now a pinned devDependency,
`tests/integration/mcp-interop.test.ts` runs it, and `P-026-C3` is VERIFIED
against it: twelve tools discovered, all twelve draft-07 schemas compiled with
none refused, seven resources listed, and a real `tools/call` answered.

Running it found two defects that made this client unable to complete a handshake
with any conformant server that chose the other framing — SSE-framed responses
were unparsed, and the session id the server issues was never echoed. Both are
described in `docs/MCP_GUIDE.md`; both fixes are load-bearing, in that reverting
either collapses the interop suite.

The distinction that keeps C2 external after all this is worth stating, because it
is the one the audit had to get right: the reference server is an independent
**implementation** and this repository is still its **operator**. What C2 asks for
is an origin somebody else runs, and no package can supply that.

The scope was re-audited from the specification, the design question it had been
stuck on turned out not to exist, and the capability was then built. Three
things happened in that order and each is worth separating.

**The direction narrowed.** §5.11 names `MCP client` first and lists no server
component; §35's diagram runs `Agent Runtime → MCP Client → Remote/Local MCP →
Tools/Resources`, all downstream. So P-026 is a client capability only: this
build calls out to servers other people run and is never itself an MCP server.
That had been carried as a deferred transport question; it is not deferred, it is
not asked for. A related finding from the same audit: the comparison **extension**
is not an MCP client either — its connectors are remote MCP reached from the
vendor's cloud, and its side panel is a cloud session displayed in a browser. So
there is no benchmark behaviour to copy here, and §5.11 rather than parity is the
authority for building a client at all. `docs/MCP_GUIDE.md` is the full record,
and specification §81 required that file, which did not exist.

**The approval-granularity question turned out not to exist.** It had been
answered with a user-set per-server risk _ceiling_, every tool from the server
running at it. That is withdrawn. A ceiling is a number a user picks, and the
user who picks R0 or R1 — reasonably, for a server they believe only reads — has
put that server's entire present _and future_ tool set below
`AUTO_APPROVE_BELOW`. A safeguard whose safe setting is the counter-intuitive one
is not a safeguard.

An MCP tool is **R3** instead, classified from what the call is:
`RISK_DESCRIPTIONS.R3` is "Sensitive external side effect. Writes data outside
the browser", which is an MCP call exactly, including one that only reads on the
far side. Everything else then follows from thresholds that already ship —
`evaluatePolicy` stage 5 confirms at R3 before the mode switch, so `manual`,
`auto` and `skip` all confirm, and `MAX_GRANTABLE_RISK` is R2, so no site rule
and no plan approval can reach it. Approval is per call as arithmetic rather than
as a policy choice, no new authorization surface was added, a tool a server adds
later cannot be covered by a grant that was never able to exist, and an
unattended run fails closed — so a scheduled task cannot use an MCP tool at all.

**Then it was built, and it is reachable.** A person adds a server in Settings,
the worker discovers it, and its tools appear in the set the model is offered.
Verified in real Chromium against a local server speaking real JSON-RPC over real
sockets. Six clauses carry it: the trust core, the guarded transport, discovery,
tool construction, the store and registrar, and the wiring itself.

Two defects along the way were found by tests rather than by reading, which is
the part worth recording:

- `shape['__proto__'] = x` **sets the prototype** rather than adding a key, so a
  server declaring a `__proto__` argument had it silently vanish from the
  compiled schema — fail-closed by accident, with the accumulator's prototype
  replaced. The three names are refused now.
- `fromWireName` restored the first `_` in a wire name to a `.`, turning
  `mcp__example__search` into `mcp._example__search`, so **every MCP tool was
  undispatchable**. The earlier argument for `__` — that no built-in family
  contains it, so a discovered name cannot shadow one — is true and is about
  shadowing, not about the wire round trip. The dispatch suite found it because
  its cases drive a real `ToolRegistry` rather than calling `execute` directly.

Forty-one mutants across the seven clauses, each killed.

**Resources came next, and they are tools too.** A resource is data a server
offers rather than an action, and in the protocol it is attached as context. This
architecture has one way for a model to reach anything, so resources arrive as two
tools per server — one listing what is available, one reading a named entry.
Anything else would be a second path into the model's context that the policy
engine does not see, which is what §35 forbids.

Both are R3, **including the listing**, and the absence of a read-only exception
is the point rather than an oversight: the call itself tells the server this
browser is asking, and a read-only exception is exactly the shape the withdrawn
ceiling had. The read may only name a URI the server offered — otherwise the model
could ask the server to fetch anything, a request the user never saw offered and
that this build would have originated. Content is bounded, taints the task, and
binary is named rather than decoded; a URI never reaches an audit field or a
prompt summary, because it is page-derived text.

**And it is PARTIAL rather than PASS, for the reason P-023 and P-033 are.**

Every mandatory clause is VERIFIED except two, and both are `EXTERNAL_REQUIRED`:
remote MCP has never been exercised against a server somebody else operates,
because this repository holds no such server and no credential for one, and local
MCP needs §66's desktop bridge, which the specification itself defers and which
would need native messaging.

That combination would let the clause gate permit a PASS. It does not get one,
and the precedent is the point: P-023 Connector framework and P-033 Provider
switching are both PARTIAL on exactly this basis — everything is built and tested
against a local mock, and nothing has met a real third party. Holding P-026 to a
looser standard than the two rows beside it would make the matrix inconsistent in
the one direction that flatters it.

§84 condition 3 — manual acceptance — is also unmet repository-wide, which every
PASS row already carries.

### Each external clause, re-tested rather than re-asserted

The final audit's second part asked of every `EXTERNAL_REQUIRED` clause whether it
is genuinely external or whether the classification was hiding work. One was
hiding work, and the method that found it is worth keeping: ask whether an
_independent implementation_ of the thing exists as an obtainable artifact, which
is a different question from whether a _third-party operator_ is needed.

| Clause                                                      | Asks for                                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `P-026-C3` local MCP                                        | a local MCP server                                                                               | **Was wrong.** The MCP project's own reference server is an npm package speaking Streamable HTTP over loopback. Now VERIFIED, and running it found two defects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `P-026-C2` remote MCP                                       | an origin somebody else operates                                                                 | **Was wrong too.** The question was right and the answer assumed operators cost something. Public, credential-free hosted MCP servers exist; one was reached over the public internet and the clause is now VERIFIED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `P-023-C8` a connector used against a real service          | a real service and its OAuth application                                                         | Genuinely external, and doubly so: inventing OAuth credentials is on this project's locked prohibition list. Re-asked with the method above and it still holds — `ConnectorAuthKind` does admit `none`, so a credential-free public API could be connected, but C8's subject is the **authorization** that has never run against a real service, and a connector that authorizes nothing sidesteps the clause rather than satisfying it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `P-023-C9` the Tier 1 connector roadmap                     | six named services                                                                               | Genuinely external, and narrowing. **Four of the six are now written** — GitHub, Figma, Jira and Confluence — each connected with a credential the user creates in their own account. The two that remain are Google's. **Re-audited 2026-10-04 for the assumption inside the blocker**, the method that has twice been right: "both need a registered client id" is true but misleading, because it reads as two registrations. They need **the same one G-6 already requires** — a Chrome Extension OAuth client can carry any scopes its consent screen declares, so Sheets and Drive are scope configuration on an existing client rather than new registration work. One registration therefore unlocks three things, not one. What is _not_ purely mechanical is whether to bundle them: adding `spreadsheets.readonly` and `drive.readonly` beside `cloud-platform` widens a single consent from "run a model for me" to "read my documents", which is a product decision and not a checklist item. The alternative considered and rejected: an API-key Sheets connector can read only sheets published to the web, which sidesteps the clause the same way a credential-free connector sidesteps C8. |
| `P-022-C8` / `P-024-C9` the reference QA workflow and skill | §44's scenario names Jira, Confluence, Figma, Sheets, a Jira **write** and the permission system | Genuinely external. **Three of the four connectors now exist**; Google Sheets is the one that does not, and it is the one needing a registered client id. The clause requires executing against four services, not authoring a definition, so it still waits — on one connector and a credential each rather than on four connectors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `P-033-C5` live commercial provider endpoints               | the vendors' paid APIs                                                                           | **A live commercial endpoint has now been exercised end to end through a native adapter.** The gemini adapter against `generativelanguage.googleapis.com` with a real key: 44 models discovered, **AGENT_READY** with all twelve doctor checks passing, and the full two-turn tool round trip — the model called a tool, the result went back, and the answer carried a value that appears only in that result. The openai-compatible adapter reached AGENT_READY against `openrouter.ai`. Those runs found **four** defects no fixture could, two of which together meant the agent could not run on Gemini at all: a tool schema field Google rejects by name; streaming denied on an absent list entry the endpoint ignores; a retired-but-listed model told to "check the model list"; and an opaque `thoughtSignature` that Google requires back, dropped first by the adapter and then again by the runtime. Still EXTERNAL_REQUIRED, not PARTIAL: what remains is Anthropic through its own adapter and `api.openai.com` directly, and both need a credential this project does not own.                                                                                                              |

One option was considered and **rejected** rather than silently skipped: running an
independent OpenAI-compatible server to give the provider adapters the same
treatment the MCP client just got. The MCP case worked because the reference server
is the protocol's own conformance vehicle — an implementation written to define
correct behaviour. There is no equivalent for the OpenAI wire format; the npm
packages that look like one are test doubles, so driving the adapters against one
would produce evidence no stronger than the mock already in the suite while
reading as though it were stronger. A real inference server would be genuine, and
is out of proportion here. Recorded so the question is not reopened as though it
had never been asked.

### What is waiting on somebody else, and where to see it

The full certification is
[`docs/release/BLOCKER-CERTIFICATION.md`](docs/release/BLOCKER-CERTIFICATION.md),
which separates four things this file used to run together: a true external
blocker, a scenario needing a person at a browser, a decision nobody has taken,
and work that was merely unclassified. The last category is the one that
mattered — it held eight items when the audit started, including a clause filed
as external that turned out to be an npm install away.

Three clause statuses exist so that a blocker stays visible rather than being
absorbed into a verdict: `MANUAL_REQUIRED` needs a person, `EXTERNAL_REQUIRED`
needs something this repository cannot issue itself, and `AMBIGUOUS` marks a
clause that cannot be read. The check prints each one on every run.

It did not always. The loop that printed them sat after the check's own "is this
row PASS?" early return, so a capability still waiting on something reported
nothing — which hid these notes on precisely the rows where the blocker is the
reason for the wait. Four `EXTERNAL_REQUIRED` clauses naming this project's real
blocker were invisible for that reason. Fixed, with two cases that fail if the
notes go back behind the PASS gate.

What they now say, in full:

- **P-023-C8, P-023-C9, P-022-C8, P-024-C9 — no connector has been connected
  to a real service**, because no token from anybody's account is held here.
  Everything above that line — registry, adapter, PKCE, state, callback
  validation, token vault, scope discovery, policy, execution — runs against a
  local mock authorization server over real HTTP, and the credential check now
  runs against the live service: a measurement in real Chromium records
  GitHub's own refusal of a string that is not a credential for anything.
  §44's reference multi-service workflow is held with them.

  **This bullet used to say the blocker was a missing OAuth application, and
  that was wrong.** Checked against each vendor's own documentation rather than
  assumed: GitHub's web application flow requires a `client_secret` in the code
  exchange, PKCE or not; Atlassian 3LO requires one and supports no PKCE at
  all; Figma requires one even with PKCE. This extension must not carry a
  secret — one inside an extension is readable by anyone who unzips it — so for
  four of the six Tier 1 services a registration would have changed nothing.
  Only Google's Sheets and Drive could be built as sign-in connectors here, via
  the installed-app client types that use PKCE with no secret.

  The error went unnoticed for a reason worth naming: with no client id the
  flow is refused _before it starts_, so the refusal looked exactly like
  missing configuration. Nothing had ever attempted an authorization, so
  nothing had ever reached the step that needs the secret. `docs/connectors.md`
  carries the table and the sources.

  **What changed in response.** The build now authenticates GitHub with a token
  the user creates in their own account: no registration, no client id, no
  secret anywhere, and revocable by the user in the page they made it in. The
  path is implemented, in the panel, and exercised — including the three states
  a token's reach can be in, because GitHub reports a classic token's scopes
  and reports nothing at all for a fine-grained one, and a reach that was never
  established must refuse every write rather than claim the scopes the
  descriptor wanted. `docs/release/OWNER-CHECKLIST.md` section D is now a
  five-step procedure a person can actually perform, where before it asked for
  a registration that would not have worked.

  The clause stays `EXTERNAL_REQUIRED` and no status moved. What narrowed is the
  blocker: from "no mechanism exists" to "no token is held". The five unwritten
  Tier 1 connectors stay external rather than unimplemented, for a corrected
  reason — four of them wait on a decision about mechanism, not on a form.

- **P-011-C7 — Chrome's own optional-permission dialog**, which has no frame,
  no exposed accessibility tree and no CDP domain behind it. Everything
  downstream of the grant runs end to end.

Neither is an effort question, and neither is hidden in a verdict.

Three further clauses are declared and do **not** block a PASS, because they
belong to other gates: a clause needing a person (§84 condition 3), a clause
needing a credential nobody here holds, and a clause whose specification wording
cannot be tested against. §59's "stop and recover/ask" is the third kind and is
recorded `AMBIGUOUS` rather than resolved in favour of the implementation.

### A PASS that was not true, and now is

No status moved in this revision, and one nearly did. A clause-level audit of
the twenty-nine PASS rows found that **pause and resume did not work in the
browser at all**: `task.pause` returned `{ state: 'PAUSED' }` and the task was
`CANCELLED` about a second later, and a cancelled task cannot be resumed. So
pausing destroyed the task, under two rows — P-017 and P-032 — that both read
PASS.

The cause was that one `AbortController` carried two different meanings. Pause
and cancel both aborted it; the runtime saw an aborted signal, could not tell
which had happened, and terminated the task as `CANCELLED` after the manager
had written `PAUSED`. The abort now carries a reason, the runtime stops without
writing a terminal state when it was a pause, and a terminal outcome is refused
for a task that is paused.

What allowed a PASS to be wrong is worth as much as the defect. The integration
test asserted the stored state at the instant `pause()` returned — which was
`PAUSED`, truthfully — and never looked again. There was no real-Chromium
pause/resume coverage at all. Both are fixed: the integration suite now reads
the state again once the aborted runtime has unwound, and a ten-case
real-Chromium suite makes every assertion after a delay long enough for the old
defect to land.

The rows stay PASS because the clauses are now satisfied and evidenced, not
because the audit was overruled. §84 condition 3 remains unmet repository-wide.

### Earlier movement, kept for the record

Scheduled tasks (P-020) moved from NOT-STARTED to PARTIAL. It is **not** PASS,
and the reason is below rather than a missing test.

### Earlier movement, kept for the record

The audit trail (P-038) gained integration and security coverage and closed
both of the gaps its entry named — there is now one unified cross-task log,
and an export. The counts did not move: P-038 was already PARTIAL and stayed
PARTIAL, because §84 condition 3 is unmet repository-wide. An implementation
existing is not parity.

### Earlier movement, kept for the record

Shortcuts (P-021) moved from NOT-STARTED to PARTIAL, taking PARTIAL from 6 to
7 and NOT-STARTED from 4 to 3.

### Earlier movement, kept for the record

Workflow recording (P-022) moved from NOT-STARTED to PARTIAL, taking PARTIAL
from 5 to 6 and NOT-STARTED from 5 to 4.

### Earlier movement, kept for the record

Skills (P-024) moved from NOT-STARTED to PARTIAL, taking PARTIAL from 4 to 5
and NOT-STARTED from 6 to 5. **Not** PASS, for a reason stated below.

### Earlier movement, kept for the record

The connector framework (P-023) moved from INTERFACES-ONLY to PARTIAL, taking
PARTIAL from 3 to 4 and emptying the INTERFACES-ONLY category. It is **not**
PASS, for a reason stated below that is external rather than architectural.

### Earlier movement, kept for the record

PASS went from 28 to 30 and PARTIAL from 2 to 3, and NOT-STARTED from 9 to 6,
on evidence rather than on reassessment of the same evidence. Image upload
(P-009) and file upload (P-010) moved from NOT-STARTED to PASS; download
(P-011) moved from NOT-STARTED to PARTIAL, for a reason stated below rather
than a missing test.

### Earlier movement, kept for the record

Notifications (P-019) was PARTIAL for one stated reason — `chrome.notifications`
was called inline in the service worker, so nothing could test it. It now sits
behind `NotificationPort`, the same seam pattern the debugger and messaging
surfaces use, with tests covering what a notification may contain, the setting
being read live, and a Chrome refusal not failing the approval underneath it.
Headless Chromium surfaces no notifications, so the seam is the evidence and
an end-to-end test is not possible.

Long-running task (P-017) was PARTIAL because the longest tested trajectory was
a handful of turns. What exists now is **deterministic multi-turn lifecycle and
recovery validation**: an 18-turn run asserting exact usage accounting, step
ordering with no duplicates, and budget termination for a model that never
finishes, alongside a real service-worker kill and restart. It is not a
wall-clock endurance or soak test and is not described as one — duration is
enforced against an injected clock, because a test that slept would be slower,
flakier and prove less. The capability name below is the specification's
(§83); the evidence is what this paragraph says it is.

### P-009 / P-010 File and image upload — what PASS means here

Upload is implemented as four separate operations rather than one, because
that is what it is: the user selects a file, the extension reads it, the
extension puts it into a page input, and the site transmits it. Selection is
user-mediated through the side panel's own file picker — there is no tool that
takes a path, and no filesystem access to give one meaning. Reading a file
taints the task with a `local_file` source that carries no site, so sending it
anywhere needs consent rather than a same-origin pass. Putting it into the
input is the egress, gated like every other transfer, because a page can read
`input.files` the moment they are set.

Image upload (P-009) is the same path with an `accept` that names image types;
there is no separate image mechanism and none was added.

Real Chromium covers what jsdom cannot: a file input the page has hidden still
gets a handle while a hidden button still does not, and the `DataTransfer`
assignment actually populates `input.files` so the page's own `change`
listener fires.

**Stated limitation.** The `change` event an extension dispatches has
`isTrusted: false`. A site that requires a trusted event will ignore it. That
cannot be worked around, so the assignment is verified and a failure is
reported rather than assumed away. File inputs inside cross-origin iframes are
also out of reach, because `all_frames` is `false` and widening it is not
justified by this feature.

### P-011 Download — why PARTIAL

**P-011 Download** — The implementation is complete and tested: filename validation (traversal,
absolute paths, separators, control characters, reserved device names,
executables and browser extensions all refused), `conflictAction: 'uniquify'`
so nothing is ever overwritten, full lifecycle handling, and an audit record
for each outcome.

PARTIAL for one reason, and it is narrower than it used to be recorded as.

This section previously said the granted path could not be reached because a
headless profile cannot produce the gesture that grants the permission. That
was tested rather than assumed, and it was wrong in both halves. A Playwright
click does supply a real user activation and Chrome does accept the
`chrome.permissions.request` made from it; what cannot be answered is the
confirmation dialog Chrome raises next, which is browser chrome with no frame,
no exposed accessibility tree and no CDP domain behind it. And the granted path
needs no gesture at all — only a permission that is already present.

So the granted path now runs end to end in real Chromium, against
`dist-downloads/`: the shipped bundle with `downloads` declared required rather
than optional, which is a build-time difference the spec re-derives and asserts
before relying on it. Seven cases cover the R3 confirmation, a denial, the
filename gate with the permission present, a real `chrome.downloads` call whose
bytes are read back off disk, the audit record, the fact that the strongest
standing site grant still does not cover a download, and survival of worker
eviction. Nothing is mocked and no permission state is mutated at runtime.

What is left is the grant dialog itself, written up as §91 procedure D-3-1 and
classified `BLOCKED — HUMAN/ENVIRONMENT`.

That is now carried as a `MANUAL_REQUIRED` clause rather than as a PARTIAL row,
and the row reads PASS. The reasoning is the same one that applies to every
other row here: what cannot be reached is a Chrome dialog, not any code this
project owns, and a gate that needs a person is condition 3 — which is unmet
repository-wide and which a PASS on automated evidence has never claimed to
cover. Everything downstream of the grant runs end to end. The clause gate
prints the outstanding manual procedure on every run, so it stays visible rather
than being absorbed into a verdict.

### P-032 Task resume — the recovery rung that was missing

`P-032-C6` is the specification's worked recovery ladder, given as an
"Example:" rather than a requirement: refresh the page model, find the target,
retry, screenshot fallback, alternate locator, model recovery. Retry and the
page-model refresh were here. **The alternate locator was not**, and its
absence had a cost that did not look like a gap.

When a handle went stale, every path ended in the same sentence to the model:
_"Read the page again to get current handles."_ That is correct and it is a
model turn spent on a mechanical problem — and it only works if the model
obliges. One that retries the same handle loops; one that gives up strands a
task the page would have allowed. A page that re-renders between the read and
the click is the **ordinary** case on anything modern: a list settling, a
spinner resolving, a toast appearing.

So the element is now looked for again before the handle is reported unusable.

**The identity is role plus accessible name, and that is not a new invention.**
It is what `describeActedOn` produces and what a workflow binding is matched
on; a third identity scheme would be a third set of behaviours to reason about,
and the two that exist would not be the ones under test.

**An ambiguous match is refused, never resolved by position.** The descriptor
carries one and using it is tempting and wrong, for the reason the
parameteriser already settled: _"a recording that says 'the third Delete
button' is a recording that clicks the wrong thing the moment a row is
added."_ That holds with more force here, because this runs **after** the page
has demonstrably changed — if two elements now share the role and the name, the
page is not the page the model read, and guessing between them is how an agent
deletes the wrong row. Zero matches and two matches are both refusals, with
different sentences, because they ask the model for different things.

**It bypasses no gate.** Relocation produces an element; visibility, enabled
and field sensitivity all run on it afterwards, which is what makes this a rung
on the ladder rather than a shortcut around the rails. And it is **reported**:
the click result carries `relocated`, so acting on a node the model did not
literally name is distinguishable in the result and in the audit trail.

**The clause stays PARTIAL, deliberately.** The screenshot fallback is still
absent, and that is a product decision rather than outstanding work: the model
can already request a screenshot, and pushing an image into its context on
every failed click is a cost the user did not ask for. Three rungs exist, one
is a stated omission, and the row is not promoted on the strength of the three.

### P-033 Provider switching — what PASS means here

**Four** adapters ship and all four pass one shared 21-case conformance suite,
over real sockets against local servers. Switching between them is exercised in
integration; in **real Chromium** the socket round trips cover three of the four
— the Anthropic, Gemini and Chat Completions protocols — and the fourth,
`nine-router`, speaks Chat Completions through a gateway and is covered there by
registry and descriptor assertions rather than by a round trip of its own.
Every ordered pair is tested, and each switch is shown to carry nothing with it:
the egress consent pin binds a canonical provider destination and a model, so
changing either invalidates the authorization rather than inheriting it, and the
refusal is reported as blocked — never as a retryable network fault.

A request to a live commercial endpoint **has** now happened, which this
section previously said had not. `tests/integration/nine-router-live.test.ts`
drives the production pipeline — registry, guarded transport, adapter, egress
gate, consent store, audit log, capability doctor — against a 9Router gateway
the owner runs, fronting a real ChatGPT account: discovery, selection, the pin,
a completion that came back, and a capability measurement. The suite is opt-in
on two environment variables and skips without them, so it does not run in CI.

What still has **not** happened is a request through the **native** `anthropic`
or `gemini` adapters, or to `api.openai.com` directly rather than through a
gateway — those need vendor keys this project does not hold. The row is PASS on
the capability as specified — switch provider, keep the agent body — and both
the new evidence and the remaining limit are stated here rather than folded
into the verdict.

**An account can now be connected by authorization, not only by a pasted
key** — for exactly one provider, and the reason it is one is worth recording
because it was checked rather than assumed.

The product requirement is that a user connects the AI account they already
hold, and Google is the obvious lever: every vendor accepts a Google login.
What a vendor accepts on _its own site_ is not something this extension can
receive. Checked against each vendor's documentation:

- **Google Gemini — works.** Google issues a Chrome Extension OAuth client with
  **no client secret** ("not applicable to requests from clients registered as
  Android, iOS, or Chrome applications"), and `generativelanguage.googleapis.com`
  accepts a bearer token — measured, by asking it: it answers an unauthenticated
  request with _"Please use API Key or other form of API consumer identity"_ and
  a bearer request with _"Expected OAuth 2 access token…"_.
- **OpenAI — exists, needs no secret, and still does not fit.** Sign in with
  ChatGPT advertises `token_endpoint_auth_methods_supported` including `none`,
  and its plan-sharing guide says _"you don't need a client secret or an API
  key"_. The blocker is the **redirect URI**: the plan-sharing flow requires
  `http://127.0.0.1:{port}/callback`, loopback only, and an MV3 extension cannot
  listen on a port. The https variant is identity-only and needs a server.
- **Anthropic — prohibited.** Anthropic states a third party may not offer
  Claude.ai login in its own application, nor route Free/Pro/Max credentials on
  a user's behalf, nor intermediate Claude.ai credentials or session tokens.
  Not a technical gap; building it would breach a term.
- **9Router — nothing to authorize.** It issues its own keys and runs no
  authorization server.

So the Google button sits against the one provider it works for, and every
other provider states what it needs instead with a link to the vendor's page.
`src/providers/accounts/authorization.ts` is the single table the panel, the
worker and `docs/account-integration.md` all read, so none of them can come to
describe a vendor differently.

**`identity` became an optional permission, and the objection to it was
answered rather than dropped.** `connectors/oauth/auth-flow-port.ts` refused it
for years, correctly: the same permission unlocks `getAuthToken`, which can mint
a token for the _browser profile's own_ Google account. Google registers one
redirect for an extension client, `https://<id>.chromiumapp.org/`, which only
`launchWebAuthFlow` intercepts — so the tab-watching flow cannot receive this
callback and the permission is unavoidable. It is taken optional (absent at
install, requested on the button, revocable), and the manifest ships **no
`oauth2` key**, which is where `getAuthToken` reads its client id. A real-
Chromium case calls `getAuthToken` and asserts no token comes out. Every
connector still uses the no-permission flow.

**One account's discovery was readable as another's answer, and that is now
fixed.** Found by auditing the requirement that account-specific model data
must not cross connections, rather than by a failing test.

The registry caches one adapter instance per provider id, and
`resolveBrainAccount` reconnects it on every request rather than disconnecting
first. The Gemini adapter is the only one that caches per-model capabilities —
it does so to keep a network round trip out of the pre-flight check on every
turn — and that cache was cleared on `disconnect` and not on `connect`. So
capabilities discovered under one account's credential were still in the map
when a different account's turn ran, and two Gemini accounts on different tiers
or in different regions can have different access to the same model id.

It is not a credential leak: no token crossed. It is an **answer** leak, and the
consequence is a request allowed a feature the account cannot use, failing at
the provider instead of being refused with a reason the user can act on.

The cache is now discarded when the credential, the endpoint **or the
credential scheme** changes, and not otherwise — clearing it unconditionally
would put a round trip in front of every request, which is the cost it exists
to avoid. The scheme is part of that identity because a key and an access token
are both opaque strings that could in principle be equal while authorising
different things. Three cases in
`tests/integration/google-account-journey.test.ts` cover the three changes, and
all three were verified to fail with the fix reverted.

**The credential's shape is now part of the account record.** A key and an
access token are both opaque strings, so `ProviderConfig.credentialScheme`
carries which header to use and `resolveBrainAccount` sets it from
`account.authKind` — an adapter that guessed would send one in the header the
endpoint ignores, which is an unauthenticated request carrying the user's
credential. An authorized connection also expires, so `credentialForConnection`
renews it before use, writes the new token back, and **does not retry a refused
renewal**: a revoked grant does not become valid by being asked again.

**The remaining uncertainty narrowed, and one earlier reading was too strong.**
The previous entry said Google's discovery document "declares no OAuth scope
for `generateContent`", implying OAuth might not cover it. The documents do
declare scopes — for seven methods in `v1` and thirteen in `v1beta`, all file,
cache or media operations, all naming only a vestigial
`devstorage.read_only` — so the document does not describe this API's OAuth
scoping at all and its silence is not evidence either way. The better evidence
is the endpoint: `POST …:generateContent` with a bearer literal answers `401
UNAUTHENTICATED` — _"Expected OAuth 2 access token, login cookie or other valid
authentication credential"_ — naming
`GenerativeService.GenerateContent`. A method that did not accept the scheme
would not say that.

**And it found a gap that would have bitten the owner immediately after G-6.**
Google documents that a user-credential call to a client-based API must name a
project for billing and quota, via `x-goog-user-project`, and its own Gemini
OAuth quickstart sends that header beside the bearer token. The adapter sent no
such header. It now does — only alongside a bearer credential, never with a
key, from a value configured by whoever registers the client and **never
guessed from the client id's digits**, because "usually a project number" is not
a documented mapping for a value that decides whose quota is spent. Google's own
quota-project refusal is turned into a sentence naming the setting, instead of
the shared message for that status, which mentions a key the user does not have
and tells them to change a model that is fine.

**Not verified live.** A real Google authorization needs an OAuth client
registered to this extension's id, which is owner action G-6, and the shipped
build carries none — so it reports the method unavailable _with a reason_ and
offers the key path instead. What remains **unverified** is one specific thing:
whether a validly issued `cloud-platform` token, with a quota project naming a
Cloud project that has the Generative Language API enabled, is accepted for
`generateContent`. `docs/account-integration.md` separates the four evidence
classes and names the minimal procedure that would settle it — G-6 step 4.4,
one task on a configured build.

**A clause was added, and it is the one the row was missing.** §17 requires
provider routing to be user-controlled and forbids silent switching. Four
clauses tested _components_ of that — the registry, the switch state, the
resume guard, the capability scope — and none tested the claim the product
actually makes to a user: **the account you selected is the account that serves
your request.** A build could pass all four and still send every turn with
whichever key was connected first, because the failure that matters is not the
wrong provider, it is the **right provider and the wrong account**: a personal
key and a work key at one endpoint, where one adapter instance per protocol is
shared and the previous account's credential is still in it.

`P-033-C6` is that claim, asserted on the credential the endpoint actually
received. Two accounts are connected at one origin differing only in their key;
a task runs; the `Authorization` header the local provider was presented is the
selected account's and not the other's; the brain is switched and the next
task's headers change. In real Chromium, and again in integration against the
real `AccountStore` and the real resolution with only the socket replaced.

Making it assertable needed the resolution to be callable. It was fifty-five
lines inside `service-worker.ts` holding five separate refusals — no model
chosen, a model the last discovery did not offer, no credential on this device,
a credential the provider rejected, a measurement scoped to a different pair —
none of which any test could reach without booting a browser. It is now
`src/providers/accounts/resolve-brain.ts`; eleven mutations against it are
killed, and **five source-text guards that previously matched strings in the
worker now call the code instead**, which is a stronger assertion than the one
they replaced. No status moved: the row was PASS and still is.

A smaller thing the same work found: with an account connected but none
selected, a task was refused with _"No AI provider is connected"_ — which sends
the user to connect a second account they do not need. The two situations are
now distinguished, and the message names the one-click fix.

**Connecting the account is also no longer a memory test.** Four adapters ship,
one per _protocol_, which is correct and deliberate — `openai-compatible`
carries Kimi, DeepSeek, Groq, OpenRouter, Mistral, xAI, Together and a local
runner, and an adapter per vendor is the architecture this project rejected.
The cost of that correctness fell on the user: somebody holding a Kimi key had
to know Moonshot speaks the OpenAI protocol and type its base URL from memory.
`known-endpoints.ts` is ten named defaults over the adapters that already
exist — no new adapter, no new permission, no credential, and the base URL
stays editable. Every entry is held to what the build will accept: the
registry must know its provider, and the adapter's own `connect` must take its
URL, so an entry this build would refuse fails a test rather than a user who
has just pasted a key.

---

## Matrix

| ID    | Capability                           | Impl | Unit | Integration | Security | E2E | Status      |
| ----- | ------------------------------------ | ---- | ---- | ----------- | -------- | --- | ----------- |
| P-001 | Side panel                           | yes  | —    | —           | —        | yes | PASS        |
| P-002 | Read page                            | yes  | yes  | yes         | yes      | yes | PASS        |
| P-003 | Click                                | yes  | yes  | yes         | yes      | yes | PASS        |
| P-004 | Type                                 | yes  | yes  | yes         | yes      | yes | PASS        |
| P-005 | Navigate                             | yes  | yes  | yes         | yes      | yes | PASS        |
| P-006 | Forms                                | yes  | yes  | yes         | yes      | yes | PASS        |
| P-007 | Scroll                               | yes  | yes  | yes         | —        | yes | PASS        |
| P-008 | Screenshot                           | yes  | yes  | yes         | yes      | yes | PASS        |
| P-009 | Image upload                         | yes  | yes  | yes         | yes      | yes | PASS        |
| P-010 | File upload                          | yes  | yes  | yes         | yes      | yes | PASS        |
| P-011 | Download                             | yes  | yes  | yes         | yes      | yes | PASS        |
| P-012 | Multi-tab                            | yes  | yes  | yes         | yes      | yes | PASS        |
| P-013 | Tab grouping                         | yes  | yes  | —           | —        | yes | PASS        |
| P-014 | DOM inspection                       | yes  | yes  | —           | yes      | yes | PASS        |
| P-015 | Console inspection                   | yes  | yes  | —           | yes      | yes | PASS        |
| P-016 | Network inspection                   | yes  | yes  | —           | yes      | yes | PASS        |
| P-017 | Long-running task                    | yes  | —    | yes         | —        | yes | PASS        |
| P-018 | Background task while Chrome is open | yes  | —    | yes         | —        | yes | PASS        |
| P-019 | Notifications                        | yes  | yes  | yes         | yes      | yes | PASS        |
| P-020 | Scheduled tasks                      | yes  | —    | —           | yes      | yes | PASS        |
| P-021 | Shortcuts                            | yes  | yes  | yes         | yes      | yes | PASS        |
| P-022 | Workflow recording                   | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-023 | Connector framework                  | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-024 | Skills                               | yes  | yes  | yes         | yes      | yes | PARTIAL     |
| P-025 | Plugins                              | no   | —    | —           | —        | —   | NOT-STARTED |
| P-026 | MCP                                  | yes  | —    | yes         | yes      | yes | PASS        |
| P-027 | Permission modes                     | yes  | yes  | yes         | yes      | yes | PASS        |
| P-028 | Site permissions                     | yes  | yes  | —           | yes      | yes | PASS        |
| P-029 | Permission history                   | yes  | yes  | —           | yes      | yes | PASS        |
| P-030 | Prompt injection defence             | yes  | yes  | yes         | yes      | yes | PASS        |
| P-031 | Session persistence                  | yes  | yes  | yes         | —        | yes | PASS        |
| P-032 | Task resume                          | yes  | yes  | yes         | yes      | yes | PASS        |
| P-033 | Provider switching                   | yes  | yes  | yes         | yes      | yes | PASS        |
| P-034 | Tool calling                         | yes  | yes  | yes         | yes      | yes | PASS        |
| P-035 | Capability doctor                    | yes  | yes  | —           | —        | yes | PASS        |
| P-036 | Error recovery                       | yes  | yes  | yes         | —        | yes | PASS        |
| P-037 | Loop detection                       | yes  | yes  | yes         | —        | —   | PASS        |
| P-038 | Audit trail                          | yes  | yes  | yes         | yes      | yes | PASS        |
| P-039 | Evidence model                       | yes  | yes  | yes         | yes      | yes | PASS        |
| P-040 | Provider/model capability detection  | yes  | yes  | —           | —        | yes | PASS        |

---

## Why each PARTIAL is partial

### §9's canonical browser tool list, audited name by name

Asked directly, because the clause inventory made it answerable: §9 lists
sixteen minimum browser tools, and twelve exist under exactly those names.
The other four, each checked rather than assumed:

| §9 name                          | State in this build                                                                        | Verdict                      |
| -------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| `browser.upload`                 | `files.select` + `browser.attach_file`                                                     | present, split and renamed   |
| `browser.get_accessibility_tree` | inside `browser.read_page`, which returns roles and accessible names by accname precedence | present, not a separate tool |
| `browser.get_dom`                | `debugger.dom`, where §11 and §5.4 also put it                                             | present, different namespace |
| `browser.execute_script`         | **not implemented, deliberately**                                                          | recorded divergence          |

The first three are naming differences over capabilities that exist, and the
first is a security split rather than a rename: choosing a file and sending it
are two decisions, and only the second is egress.

The fourth is a real divergence and is worth stating plainly rather than
leaving a reader to notice the gap. §9 names `browser.execute_script` and says
it "is a high-risk capability and must be policy-controlled". It is not
implemented, and nothing fakes it. Arbitrary script from model output would
make the whole tool gate bypassable — every risk classification, every
confirmation and every egress decision is enforced at the tool boundary, and a
tool that runs script in the page is a tool that goes around all of them. Two
facts decided it: §5, which declares the mandatory parity baseline, does **not**
list script execution among its browser-interaction capabilities, and §9's own
sentence concedes the capability is high-risk. So the narrower reading is taken
— the baseline is met without it — and the divergence is recorded here, in
`docs/architecture.md` and in `docs/tool-architecture.md`. If it is ever added
it needs its own threat model, not a policy flag.

**P-006 Forms** — Text input, textarea, contenteditable, select-by-value,
select-by-label, form submission and checkbox/radio all work and are tested.
`browser.set_checked` covers checkbox and radio directly, with radio buttons
settable but not clearable — a group is changed by selecting a different
option, which is what the control actually does. File inputs are handled — see
P-010 — through `files.select` and `browser.attach_file` rather than through a
form tool, because choosing a file and sending it are two separate decisions.

An earlier revision of this entry said checkbox and radio had no dedicated
tool and had to be clicked. That was written before `browser.set_checked`
shipped and was never updated; it is corrected here rather than left to
mislead a reader deciding what is left to build.

**Controls inside web components now work, and that was a real gap rather than
a theoretical one.** `querySelectorAll` does not cross a shadow boundary, so on
a page built from custom elements the page model saw an empty document — no
buttons, no fields — and the agent's honest answer was that the page had no
controls. A large and growing fraction of real sites are built that way. Open
shadow roots are now walked, bounded in depth, in one document order; a closed
root exposes no `shadowRoot` and is unreachable by construction.

It needed **no permission change**, and that is the whole reason it was
available: this is the same access any script on the page already has, and it
crosses no origin. What makes it safe is a rule that was already written —
`classifyField` has always returned the conservative class for
`isInShadowRoot`, so a field the model can now see is one it must confirm
before writing to. The comment beside that branch said it was honoured _"so
that the day either becomes reachable it arrives as a refusal rather than as a
silent ORDINARY"_. That day is this change, and the branch stopped being dead
code.

Driving it in a real browser found a second defect, on the action path rather
than the reading path. `document.elementFromPoint` **retargets at a shadow
boundary** — for a point over a button inside a component it returns the
component's host — and the reachability check compared with `Node.contains`,
which walks the light tree only. So every control inside every web component
reported as _"something is covering this element"_: visible in the model,
refused on click. The check now descends open shadow roots at the hit point and
compares along the composed path in both directions. The case that caught it is
`shadow-dom.spec.ts :: the agent can click a button inside a shadow root`, and
it reads the page's own `composedPath()` to confirm the click landed on the
inner button rather than the host.

`P-006-C10` stays **PARTIAL** rather than being promoted, because it names two
things and only one moved: the cross-origin subframe half needs
`all_frames: true` on `<all_urls>`, which this build refuses and which is
recorded as divergence 12 in `CLAUDE_BENCHMARK.md`. Half a clause met is not a
clause met.

That divergence was left _"recorded, not closed"_ with no decision written
anywhere, which is itself a gap — an owner reading the parity status could not
tell whether the half-clause was permanent or pending. It is now **owner
decision C-6** in `docs/release/BLOCKER-CERTIFICATION.md`, with both options
stated and neither recommended: leaving it costs reach into iframe-hosted
forms, and widening it runs the content script inside every third-party embed
on every granted page, which multiplies the untrusted surface the page model
reads from and is the permission change a reviewer is most likely to question.
It blocks no release either way.

Date, time, datetime-local, month, week, colour, range and number now have a
dedicated tool, `browser.set_value`, and a multi-select has
`browser.select_many`. They are separate from `browser.type` because these
controls are not typed into: a date field has segments and typing lands in
whichever one has focus, and a range has none at all. The page model reports
each control's `inputType` and the bounds it declares, so the choice between
the tools is read rather than guessed, and a multi-select reports its whole
selection rather than only its first option.

A value is checked against the format its type accepts and against the bounds
the page declared, then assigned, then read back — because a browser's way of
rejecting a value it cannot parse is to clear the field silently, and `2026-02-30`
is well-formed and is not a date. A rejected value is restored rather than left
cleared. Bounds are enforced rather than clamped: moving a date into the allowed
window would submit something nobody chose.

Field sensitivity now reaches the policy engine (Gate 1). A write into a
password or one-time-code field is refused outright in every permission mode; a
card, CVV or bank-detail field produces the `payment_instrument_entry`
prohibition, as does a Luhn-valid card number typed into a field the page
described as ordinary; a national-ID or API-secret field raises the action to
R3, which always confirms and can never be covered by a standing site grant. A
field the worker knows nothing about — an evicted service worker, a stale
handle — is R2 rather than R1, so uncertainty costs a confirmation instead of
running silently. A positively classified ordinary field keeps its R1 baseline,
so the usual case is unchanged.

The classification happens in the worker, from raw attributes the content
script reports without drawing any conclusion, and the write is re-checked
against the live element immediately before it lands — which is the only way to
catch a page that changes a field after it was read. See `docs/security.md`.

A P-006 audit found one defect, and it was in the oldest tool rather than the
new ones. `performType` had **no read-only guard**, while `performSetValue` and
`performSetChecked` both did — the rule was two-thirds written. `readonly`
constrains people, not the IDL setter: the native value setter writes straight
through it, and a read-only field is still submitted with its form. So the
agent could replace a locked reference number, a computed total or a quoted
price, the tool reported success, and the page would submit the replacement —
something no user of that page can do. Confirmed in real Chromium before it was
fixed, not reasoned about. The page model now reports `readOnly` as well, so a
model can avoid such a field rather than learn about it by being refused;
`enabled` does not cover it, because a read-only field is enabled, focusable
and submitted.

That fix is also the closest thing to benchmark behaviour available here. The
comparison product documents that it fills forms _"the way a person would"_ and
documents nothing at all about read-only, disabled or invalid fields — see
`CLAUDE_BENCHMARK.md` §8, where the per-control evidence is recorded as UNKNOWN
rather than guessed at. A person cannot type into a read-only field.

PASS now, and it moved without anything being built — which needs saying, or the
change looks like a relaxed standard. Writing §5.2's form clauses out one by one
showed that none of the three reasons this row was PARTIAL for is an unmet
mandatory clause.

The first was the §85 A–F manual acceptance scenarios, which are unexecuted for
**every** row in this file. That is §84 condition 3, and by this file's own
definition a PASS already means "conditions 1, 2, 4, 5 and 6 met, condition 3
unmet repository-wide". Holding one row to it while thirty others read PASS with
the same gap open was an inconsistency here, not a stricter bar.

The second was two controls without a dedicated tool. `<input type="file">` is
handled through `files.select` and `browser.attach_file` by design, because
choosing a file and sending it are two decisions and only the second is egress —
that is a documented split, not a missing capability. A `<datalist>`-backed
combobox is typed into like the text input it is, and §5.2 does not name one.

The third was field classification inside a shadow root or a cross-origin
subframe, which remains true and is carried as a **non-mandatory** clause with
the limit stated: §5.2 does not require it, neither tree is walked by the page
model, and the limit bounds what the agent can do as much as what it can see —
an element it cannot find is an element it cannot write to. The classifier fails
closed there, reporting `UNKNOWN`, which costs a confirmation rather than
running silently.

**P-019 Notifications** — Specification §53 lists six things to notify for:
a completed task, a required permission, a failed task, a disconnected
provider, an expired connector authorization, and a scheduled task starting or
failing. This row read PASS while **two** of those existed — the permission
prompt and the scheduled-run lifecycle. A user who started a task and went to
do something else was never told it had finished, which is the one case the
feature is for.

Four were added. A task reaching a terminal state now notifies, and so does a
connector authorization that expired while nobody was looking. What a
notification may say is a security rule rather than a presentation choice,
because it is drawn by the operating system, outside every boundary this
extension controls, and can outlive the task in a notification centre: the
function is handed a task id and a state and **nothing else**, so an
objective, a summary, a model reply, a site or page text has no path to the
screen. Not even the task id is shown. A cancelled task says nothing, because
the person who cancelled it was standing there.

Writing the notification found a defect underneath it, and a real-Chromium run
established it rather than an argument. `TaskManager.onComplete` — the path
**every** model-driven task actually ends on — wrote the terminal state
straight to the store and never told the lifecycle observer, while
`transition()` did. So "the task reached a terminal state" was observable only
when a task was cancelled or failed around the runtime rather than by it. Two
things depended on that observation: a finished task's staged files are
released there, and the audit trail's `task.completed` record is written
there. An ordinary completing task produced **no** `task.completed` record at
all, and the user's file stayed in memory until the worker happened to be
evicted — which is precisely what the comment at that hook says it exists to
prevent. Both now happen, and the mutant that restores the gap fails the audit
test and the notification test together.

The setting that gates every notification was readable by the notifier from
the first wave and writable by nothing, so notifications were on for everyone,
permanently. That was tolerable while the only one was an approval the user
was being asked for. It is not now, so the panel has a switch, and turning it
off is proved to silence the worker rather than only the checkbox.

The sixth was the last to arrive, and the reason it waited is worth keeping:
nothing in this build ever reported that a provider had become disconnected.
The only place an account's status became `disconnected` was cloud-metadata
restore, a backend path, and a provider failing mid-task surfaced as a task
error. A notification for an event nothing emits is an orphan declaration, so
the row stayed PARTIAL until there was something real to hang it on rather than
a message with no fact behind it.

There are now two producers, and both sit in the worker's task lifecycle layer
rather than in any adapter — the same structural rule the other notifications
follow, for the same reason: an adapter reports what one HTTP call did, and
whether the brain is connected is a fact about the installation. At resolve
time, which runs at the start of every task, every resume and every scheduled
run, a provider that rejects its stored credentials has its account marked
`disconnected` and the user is told. That status write is what makes this more
than a toast: a notification saying "disconnected" over a Settings page still
reading "connected" would be worse than neither. Mid-run, a key revoked during
a task arrives at the lifecycle observer as a terminal `AUTH_EXPIRED` — the code
the provider layer reports for `authentication_failed`, which it treats as
terminal because a rejected key is rejected on every retry. A rate limit or a
503 is the provider being busy rather than gone, and is deliberately not
announced as a disconnect; treating them alike would train the user to ignore
the notice.

**And writing it found the same defect a second time.** Wave 10 fixed the
runtime's terminal path, which told the lifecycle observer nothing.
`TaskManager.fail` — the manager's _own_ ending, which three paths reach: a
provider that cannot be resolved, a resume whose provider no longer matches,
and a planning turn that failed — still told it nothing. So a task failing any
of those three ways raised no "task failed" notification, wrote no
`task.completed` audit record, and left its staged files in memory. Wave 10's
fix had been applied to one of the two places a task can end. Underneath that
sat a smaller one with a direct cost to users: `execute`'s catch flattened
every thrown error to "the task stopped because of an internal error",
including `ProviderUnavailable`, which carries an `AUTH_REQUIRED` and the
words "open Settings and connect a provider". Somebody whose API key had been
rejected was being sent to look for a bug in the extension. A thrown error that
already names a reason now keeps it.

Six mutants, each killed: `fail` reporting nothing again, the carried reason
thrown away, the observer no longer told which failure it was, the provider id
no longer travelling with it, and the disconnect notice losing first its
idempotency and then its separate key space from task ids.

§84 condition 3 is unmet repository-wide, here as everywhere else.

**P-012 Multi-tab** — All eleven of §10's tools now exist, are registered by
`createTabTools`, and are evidenced clause by clause. The workspace model that
binds tabs to a task remains the closest behavioural match in this project to
the benchmark's own tab group.

The two clauses that made this row PARTIAL were closed by building them, which
is worth a paragraph because of what the gap turned out to be. `tabs.move` was
not missing an implementation: `BrowserAdapter.moveTab` was declared on the
interface and implemented against `chrome.tabs.move`. It was missing a _tool_ —
and in this architecture the tool is where a capability is declared, because
that is what carries the schema, the risk level, the site-authorization scope
and the registry entry the model's catalogue is built from. An adapter method
with no tool is unreachable by the agent no matter how correct it is. `tabs.get`
was the same shape over the existing `adapter.getTab`.

Two things were settled rather than assumed while building them. **Scope:**
`chrome.tabs.move` accepts a `windowId` and can move a tab between windows; the
adapter passes none, and §10 says only `tabs.move`. The narrower same-window
reading is implemented and stated in the tool's own description, rather than the
wider one being invented. **The reported position:** `chrome.tabs.move` clamps
an index past the end instead of failing, so the tool reads the tab back and
reports where it actually landed, with the requested index alongside it. Echoing
the request would have been the fake success §76 forbids — and the test fake had
the same hole, a `moveTab` that ignored both its arguments, so it was rewritten
to reorder and clamp before anything was tested against it.

**P-035 Capability doctor** — Eight of §14's nine minimum checks are real probes
against the connected model: authentication, reachability, model availability,
text, streaming, tool calling, structured output and vision. The verdict logic
honours the clause that matters most — a model that did not call the probe
function is `CHAT_ONLY`, never `AGENT_READY` — and no report carries credential
material.

The ninth was the problem, and the problem was worse than the note said. Context
capacity was not merely unmeasured — it was **absent from the report**. The
doctor performed eight checks and showed eight, while `contextWindow` was copied
out of the advertised model table into the result beside them. A figure nobody
measured, presented next to eight that were, is exactly the quiet over-claim
this component exists to prevent.

There is a real probe now, and it is precise about what it settles. The model
must carry a substantial prompt and the provider must report its own token count
for it. That is a measured **floor, not the window**, and the check's own text
says so: the window is still this build's advertised figure and is labelled as
not measured. Finding the ceiling would mean billing the user for a diagnostic —
a 200,000-token prompt to learn a number — and reading it out of provider model
metadata is not uniformly available, so it is not claimed. What the floor buys is
the case the table cannot catch: an account tier whose usable context is far
below the number published for the model, which fails the check with the
provider's own refusal as the detail.

It deliberately does not decide readiness. §14 states one readiness rule —
never claim Agent Ready if tool calling is unavailable — and a context probe
that downgraded an otherwise working agent would be this project inventing a
requirement the specification does not contain.

**P-037 Loop detection** — §59's three clauses: the same action on the same
target with the same result, repeated cycles, and "stop and recover/ask". The
first two were evidenced already. The third was recorded AMBIGUOUS, and refusing
to resolve it in the implementation's favour was the right call at the time.

It is resolved now by an explicit decision rather than by reinterpretation. The
sentence is a disjunction, and this product answers it by **asking**: the run
halts, the reason is separately identifiable as `LOOP_DETECTED` rather than a
generic failure, the user-facing message says the task stopped and names the
choice, the error is marked recoverable, the panel offers Retry for any finished
task, and §53's task-failed notification fires. The detector's own wording says
what repeated — which the model needs — and on its own it left the person
reading it with nothing to do; that is what changed.

Automatic recovery is deliberately not attempted, and that is a recorded
divergence rather than a gap. §58's recovery ladder is given as an "Example:",
and retrying a call the detector has just proved unproductive would re-enter the
loop the check exists to break.

**P-038 Audit trail** — One append-only stream across every task, recording
what was proposed and what was decided. Tool executions now reach it through
the single observation hook on `ToolRegistry.dispatch`, alongside task
lifecycle, permission, egress, connector, file, skill, workflow and shortcut
events — nine event types were declared from the start and never written,
which is why the trail could say what was _decided_ but not what was _done_.

**`P-038-C10` moves from PARTIAL to VERIFIED.** The read route filtered on task
and site while a record also carried workflow, skill, shortcut, schedule, run
and connector correlations — so "what did this connector do" was a question
answerable only by exporting the trail and grepping it, which is not a trail
the product can show anybody. It now filters on all of them. Each is an exact
match on an identifier this extension minted, `site` stays case-insensitive
because a host is, and nothing is a pattern or a range: a query language over
the audit trail would be a second thing to get right, and the questions people
actually ask are "what did this connector do" and "what happened in that
scheduled run".

The case worth reading is the permissive reading it avoids. A record that does
**not** carry the field does not match a query for it — because returning every
connector-less event in answer to a connector query looks like an answer and is
not one. That is the mutation that is killed, along with two others.

The trail observes and never authorises: nothing reads it to decide anything,
and a write that fails is a gap in the record of an execution that already
happened rather than a failed execution. Records are flat and bounded, hold
identifiers, closed vocabularies, flags and references only, and are refused
rather than trimmed when they exceed a limit. A persisted sequence and a
digest chain give corruption and reordering detection — explicitly not tamper
protection, since anyone who can rewrite extension storage can rewrite the
chain with it. Eviction writes a marker in the same transaction that removes
the records. Export is local only, needs no permission and has no network
carrier, and its scope is required rather than inferred: an omitted or
unrecognised scope is refused before any document is built, because one task
and every task are different things to be handed. The audit routes, like
every other panel route, are reachable only from the side panel — checked at
the receiver rather than inferred from the absence of another caller.

A gap audit against every authority-bearing action found one that had no
record at all: **a standing site grant**. It is the thing that stops the agent
asking again on a site, and neither end of its life reached the trail —
`permission.decided` reports that a prompt was approved and flattens
`approve_once` and `approve_site` into the same `approved` code, so it could
not say a standing grant had been made, and revoking one wrote nothing. "What
was this allowed to do, and when did that change" was therefore unanswerable
from the record, while the audit model's own comment already asserted that a
grant being given or revoked was recorded. Both ends now write
`policy.site_rule`, at the point the rule is written and at the point it is
removed; a removal that removed nothing records nothing.

The same audit found two event types that had been **declared and never
written** since the first audit wave — `provider.state` and `recovery` — and
that had survived a full rewrite of the module in between. A declared type
with no producer is a promise the trail makes and does not keep: a reader
filtering for it cannot tell "it never happened" from "nothing writes it".
Both are removed, since `provider.selected` and `persistence.health` already
carry what they would have said, and a test now counts every declared type
against the producers in `src/` so a future capability cannot declare its
lifecycle events before it can emit them.

Covered by a unit suite, an integration suite, a forty-one-case security
suite and a nine-test real-Chromium suite, with the mutations proved to fail;
the export scope contract and the route boundary add a forty-one-case security
suite and a fourteen-test real-Chromium suite of their own.

It **stays PARTIAL**, for the reason every row in this file does: §84
condition 3, the manual acceptance test, is unmet repository-wide. An
implementation existing is not parity certification. Three smaller limits are
stated rather than implied: deletion is deliberately not exposed, so a user
cannot yet clear their own history from the panel and no decision has been
taken about whether such a deletion would itself be recorded; the query
surface filters on task and site while the record supports correlation by
workflow, shortcut, schedule, run, connector and skill, which a reader of the
export can use and a route caller cannot; and the read surface scans the
retained trail rather than a secondary index — bounded, but it would not stay
so if the cap were raised much further.

**P-024 Skills** — The skill system is implemented: a structured definition
with no scripting engine, a validator that refuses anything that would
describe a privilege into being, a trusted registry that takes only
definitions shipped in the build, a step runner where every step dispatches
through the one `ToolRegistry` so policy, permission, egress and evidence
apply per step, composition with pinned versions and a depth limit, a
definition hash for audit, and run persistence that deliberately stores no
step data. Covered by two unit suites, an integration suite, a security suite
covering the wave's twenty threat cases, and a real-Chromium E2E suite that
measures the per-step approval property rather than asserting it.

**Audited again this pass rather than rebuilt.** Eight of this capability's
nine clauses are VERIFIED and the ninth is `EXTERNAL_REQUIRED` for the four
services §44's reference skill spans; the 271 cases across its six suites were
re-run and the engine was not touched. The one change is to what the user is
told, not to what the engine does: the skills list now says when a connector a
skill requires is not connected, instead of leaving that to be discovered by
approving a run and watching step one fail. It is display only and reports no
state as connected but `READY` — the decision about whether a connector call
may happen stays in the connector's own preflight, because two places deciding
it would be two answers that could drift. `src/sidepanel/connector-readiness.ts`
is its own module for the same reason `step-digest.ts` is: a few branches
inside a surface are branches no test can call.

This matters more than it would have a week ago. `github.find_issue` has
always declared `requiredConnectors: ['github']` and until now no user could
satisfy it, because the connector could not be connected at all — see P-023.
A bundled skill reaching a real service is now something a person can do.

Skills can now be **switched off**, which is the half of the benchmark's
enabled-by-default behaviour that was missing. The switch is the user's, it is
durable, and it survives a worker eviction. What makes it a control rather
than a filter is where it is enforced: `SkillRegistry.get`, `latest` and
`list` all answer as though a disabled skill were not registered, so it is
gone from the model's listing, from `skills.run`, from the panel's launcher
and from a shortcut resolving its target at once — a build that filtered only
the listing would leave a model able to run a skill it was never shown. The
settings surface has its own read that does include disabled skills, because
offering to turn one back on requires showing it, and the number of callers of
that read is asserted from source. Nothing here installs, obtains or changes a
skill: the only decision is whether one the build already shipped, validated
and hashed is available.

A write workflow now ships, and it is the smallest honest one: fill a field
and submit it, built from `browser.type` alone. It needed no new tool and no
connector — `browser.type` escalates itself to R2 when asked to submit — which
is the point. A skill-level approval is not an authorization for its steps:
each child call is dispatched separately and reaches its own policy decision,
so an R3 child still confirms in the mode that asks for nothing, an R5 child is
denied without ever being offered, and understating a skill's declared risk
cannot lower the ceiling its steps meet. Declining the write stops the write
and nothing else.

Five ways a skill run can begin — the model's `skills.run`, the panel's
launcher, a shortcut, a schedule, and a step inside another skill — and all
five obtain their definition from `SkillRegistry.get` or `latest`, which is
where the enablement switch is enforced. That is now counted from source rather
than asserted, together with the fact that nothing reads the unfiltered `all()`
from outside the registry. A recorded workflow is the sixth way and the one
exception: it carries its own definition, validated against its own hash, and
never consults the registry — so switching every skill off does not switch a
replay off, which is stated as a test rather than left to be inferred.

When a shortcut or a launch names a skill the user switched off, it now says so
instead of reporting the target missing. Two different facts, and only one is
actionable; the distinct message is chosen after the enforcing read has already
refused, so knowing why is never a way in.

PARTIAL for two reasons, both about reach rather than architecture. Four
workflows ship and only one writes, to the page's own origin at R2: a
connector-writing workflow is a reasonable thing to want and a bad thing to
make the easiest path through a young feature, so writes to a service stay
individually requested. And specification §44
names a reference QA workflow spanning Jira, Confluence, Figma and Google
Sheets as "the primary reference integration workflow for validating the
multi-tool architecture" — none of those connectors exists (see P-023), so
that workflow cannot be built and the multi-connector case is untested against
anything real.

Installing a skill stays **deferred**, and deliberately: an install surface is
a trust decision about code that did not ship in the build, which is the
plugin trust model (P-025) and is not being invented here. The lifecycle
implemented is the part that needs no such decision.

Nothing here is blocked externally. Both reasons resolve by building more, not
by obtaining anything.

**P-020 Scheduled tasks** — Schedules are implemented: create, edit, pause,
resume, delete and Run now; daily, weekly, monthly and annual cadences;
shortcut, workflow and skill targets; persisted state that survives a service
worker eviction; a deterministic execution identity so a duplicate alarm
cannot run an occurrence twice; missed-run recording; run history;
cancellation; four notifications; and eleven audit event types. Execution goes
through the existing replay and launch routes and the existing task lifecycle
— there is no second task engine, no scheduled dispatch, and no policy
evaluation inside the scheduler.

Two columns show "—" rather than "yes" and are accurate: there is no
`tests/unit/` or `tests/integration/` file for scheduling. The coverage is in
`tests/security/scheduled-execution.test.ts` (87 cases, including the cadence
arithmetic, the store and the clock, which would otherwise have been unit
tests) and `tests/e2e/schedules.spec.ts` (7 cases in real Chromium). Citing
those files under columns they do not sit in is exactly what this matrix's
evidence check exists to prevent.

It is **not** PASS for two reasons, neither of which is a missing test.

The first is the §84 condition 3 that holds every other PARTIAL below PASS
repository-wide. An implementation existing is not parity.

The second is specific to this capability and is worth stating plainly.
Parity is measured against a benchmark, and at the two points that matter most
here — what a scheduled run does when it reaches an action needing approval,
and what happens to an occurrence that was missed — **nothing published
settles the benchmark's behaviour**. An evidence exercise went looking and
found none for the Claude in Chrome extension specifically. So AI Browser
Agent made its own decision, which is documented as its own decision in
`docs/architecture/SCHEDULED_EXECUTION.md`: a run that reaches the
confirmation boundary stops, and a missed occurrence is recorded and never
replayed. Marking this PASS would be claiming a match with behaviour nobody
has established. Calling the chosen behaviour "Claude behaviour" would be the
same claim in different words, and the documentation says so explicitly.

Nothing here is blocked externally.

**P-021 Shortcuts** — A shortcut is a name for something that already exists
and has already been reviewed: a stored workflow (P-022) or a bundled skill
(P-024). It holds a name and a reference and nothing else — no steps, no tool
arguments, no prompt, no code — and it adds no execution path. Resolving one
is a read that runs nothing; what it points at then runs through the route
that already existed for that kind of target, with risk, policy, permission,
egress and evidence all re-applied per step. A confirmation shows what a name
means before anything starts, and is deliberately not an authorization.

Names are identifiers, not patterns: normalisation is fixed and idempotent,
lookup is exact equality with no nearest match, and a name that collides with
an existing one — identically, or only under a confusability key that folds
digit and letter lookalikes — is refused rather than merged or renamed.
Targets are re-checked at every resolution, so a deleted workflow, an
incomplete recording or an unregistered skill fails closed and never falls
through to something else. No `shortcut.*` tool exists and no model can
create, choose or invoke one.

Covered by a unit suite, an integration suite, a twenty-seven-case security
suite and an eight-test real-Chromium suite, with twelve mutations proved to
fail. No new permission and no new host access.

A shortcut may now also name a **saved prompt**: an objective the user stored,
which starts an ordinary task through the ordinary route. That is content
rather than a reference, and it is allowed for one reason — an objective is
the same string the composer already accepts, it reaches only `task.create`,
and it names no tool, argument, element or step. Typing it and recalling it
are the same act, so it grants what typing would grant, which is a task that
must still ask for everything it does. The fields that would make a shortcut
executable — steps, arguments, selectors, code, `prompt`, `instructions` —
stay refused at any depth, a prompt target is refused unless it carries the
objective and nothing else, and the confirmation shows the objective rather
than a risk level it cannot know before the run exists.

§50's `allowedTools` and `permissionProfile` are now implemented, and how they
came to be implemented is the part worth recording, because this row was
PARTIAL on a reading of them that turned out to be under-derived.

The note here said a permission profile is "a stored permission with a name on
it", and the workflow and shortcut design turns on the opposite rule — a
recording never becomes a standing grant. That is true of exactly one reading
of the field, the _authority_ reading, and three others were never evaluated.
Re-derived, both fields have a reading that grants nothing:

- **`allowedTools` is a narrowing.** It names already-registered tools and
  removes everything else from the set the model is offered _and_ from the set
  the registry will dispatch. Both halves matter: narrowing the offer alone is
  not a constraint, because a model that saw a name in an earlier turn or simply
  guessed it arrives at the registry anyway. It cannot admit a tool, cannot
  raise what one may do, and does not pre-approve what it admits — a narrowed-to
  tool meets exactly the confirmation it would have met without any narrowing.
  The mechanism it needed already existed and had no caller:
  `toCanonicalSchemas(allowed)` was written with the comment "a skill or
  shortcut can narrow the surface", and the one production call site passed
  nothing.
- **`permissionProfile` is a tightening.** It resolves to a permission mode, and
  the effective mode for a dispatch is `strictestMode(ambient, floor)` — so it
  can make a run stricter than the current setting and can never make one
  looser, whichever way the setting later moves. One profile exists because
  `manual` is the strictest mode there is, so there is exactly one tightening to
  express; a user-defined profile store was rejected as a second authorization
  surface with nothing to add. An unrecognised name, §50's own `"qa-default"`
  example included, is refused rather than ignored, because ignoring one would
  leave a shortcut that reads as stricter than it is.

Ten mutants killed, including the two that matter most: removing the dispatch
refusal, which turns the narrowing into advice, and inverting `strictestMode`,
which turns the tightening into a loosening.

Two reach limits remain and are not blockers. A shortcut names a whole target
and takes no per-run inputs, so a workflow with runtime slots is reached through
the review surface rather than by name; extending shortcuts to carry input
values would mean storing values, which is a different security question and
deliberately out of P-021's scope. And a shortcut **can** be scheduled — the
claim that it could not was never true, and is corrected here rather than left
to mislead somebody deciding what to build.

§84 condition 3 manual acceptance is unmet repository-wide, which every PASS row
in this file carries.
`ScheduleTarget` has carried a `shortcut` kind all along, and two cases
exercise it, including the one that matters: the name is resolved at the moment
the schedule fires rather than when it was created, so retargeting the shortcut
changes what the schedule does.

What P-021 **is** PARTIAL for is narrower and was not stated before. §50 gives a
shortcut shape carrying `allowedTools` and `permissionProfile`, and neither
exists. Both omissions are deliberate, and they are different in kind. A
shortcut here is an **alias, not an execution path** — there is no
`shortcut.run`; the panel resolves the name, shows the user what it means, and
then calls `workflow.replay` or `skill.run`. So a shortcut carries no execution
authority for an `allowedTools` list to narrow, and the tool set is already
bounded where it is determined: a skill's reachable tools are derived from its
steps at registration, composition included, and a workflow's are fixed by its
recording. Putting a second allow-list on the name would add an authorization
input to an object that does not execute.

`permissionProfile` is a security position rather than a scoping one. A named
profile attached to a shortcut is a stored permission with a name on it, and the
whole workflow-and-shortcut design turns on the opposite rule: a recording never
becomes a standing grant, and replay re-earns every approval at the risk the
action actually carries. A profile would make the easiest path through the
product the one that pre-approves.

Both are carried as mandatory clauses so this row cannot read as fully
satisfying §50, which is the honest outcome: the capability works, and two named
fields of the specified shape are refused on architectural grounds.

**P-022 Workflow recording** — Recording and replay are implemented, on top
of the skill definition, validator, runner and dispatch path rather than
beside them: P-022 added no execution code. The recorder observes completed
dispatches through a hook that hands it a deep-cloned, frozen record carrying
no result and no authorization state; a store owns each definition's canonical
form, hash and version; and replay revalidates and then runs every step
through the one `ToolRegistry.dispatch`, so each is re-adjudicated by the same
policy, permission and egress gates that adjudicated it when it was recorded.
A recording is never registered, never appears in `skills.list` and is never
model-selectable — replay is an explicit user action.

A running recording now reports its steps rather than only a count of them.
`workflow.recordStatus` carries the ordered steps and the gaps between them,
described by the same mapping the saved review list uses, and the panel shows
them under a collapsible control. The reason is in `CLAUDE_BENCHMARK.md` §0.3
and it is not a specification clause: §49 describes recording as _record,
perform, stop, save_ and says nothing about live feedback, so **no clause
status changed for this** and none was invented. What changed is that the
shipping comparison extension's own interface strings were read for the first
time, and they describe a step list with a position indicator — while this
build's panel carried a comment admitting that _"the step count is the only
feedback that anything is being captured."_ A count is worse than neutral in
this recorder, because a step it cannot write down is dropped while the count
keeps rising. A drop now reaches the user while the step could still be taken
again, instead of only in the result of stopping.

Element interactions are recorded as specification §49 asks: a click stores a
role and an accessible name, not a handle and not a selector. That data is
tagged `PAGE_DERIVED` permanently — passing ARIA validation, secret detection
or a uniqueness check gates whether it may be stored, never where it came from
— and may only ever be compared for equality against a fresh page read or
shown in the review surface. A recording the recorder could not complete keeps
its gaps, shows them in position, and cannot be replayed at all.

Every interaction the build ships is now recorded and replayed in a real
browser, not only the click the first E2E suite covered: a checkbox, a radio
group, a single-select dropdown and a text field that submits. An earlier
revision of this row said checkbox and radio bindings "ride the same path" as
a click; that was wrong, and writing the test is what found it. One tool —
`browser.set_checked` — did not report the element it acted on, so the
recorder had no description to build a binding from, every checkbox or radio
step was silently left out, and the recording then refused to replay as
incomplete. The tool now reports it, like the five interaction tools that
always did, and the mutant that removes the report again fails both cases.

Because classification is recomputed at replay rather than read from the
record, a step's risk is judged against the page as it is then: a field that
has become a national-identifier field confirms at R3 even in the mode that
asks for nothing, and one that has become a one-time-code field is denied
outright without a prompt. A replay is judged against the site the tab is on,
so a standing grant earned while recording does not travel to another origin —
demonstrated on the same markup served under a second hostname, so the page
cannot be what makes the difference.

A second recorder defect closed the same way, and it was larger: a recorded
**list** argument could never be replayed. Under a tainted task — which is
every recording, because recording reads the page first — a list became a
runtime slot, and `SkillInputType` is `string | number | boolean` with nothing
that coerces a scalar into a list, so the replayed call failed the tool's own
schema every time. A multi-select or tab-group recording looked complete in the
review surface, reported no gaps, and could not run. A list of short structural
values is stored as written now, and a list that cannot be stored drops its
step rather than becoming a slot nothing can fill — because that third outcome
is the one that produced a silently unreplayable recording.

Every interaction tool this build ships is now recorded and replayed against a
real browser, and what a replay has to earn again is settled case by case
against the world as it is then: a site grant revoked after the recording
brings the confirmation back, a site blocked afterwards refuses the replay
without asking, a workflow recorded in the mode that asks for nothing still
confirms when replayed in the mode that asks for everything, and a refusal at
one step leaves the page as it was with nothing after it run. There is no
resume — a failed replay leaves no run record, and replaying again starts from
the first step and re-asks, because carrying an earlier attempt's decisions
into a later moment is exactly what a resume would do.

Covered by a unit suite, an integration suite, two security suites totalling
thirty-six cases and three real-Chromium E2E suites totalling twenty-nine
tests, with each source-scan and real-browser claim proved to fail when its
mechanism is removed.

PARTIAL for two reasons. The §85 A–F manual acceptance scenarios have not been
run for this capability, as for every other row in this file (see "What the
PASS column actually means"). And the multi-connector reference workflow of §44
cannot be recorded, because none of the connectors it names exists — which is
blocked externally, in P-023, rather than by effort here.

One limit is a stated position rather than a gap: the risk a review surface
shows for a stored recording is the maximum of its tools' _declared_ risks — a
floor, not a prediction, because an escalation that depends on the arguments (a
form submit, a sensitive field) can only be computed against a live page. The
prompt raised when the step actually runs carries the escalated risk, so the
floor understates a review screen and never an authorization.

**P-023 Connector framework** — The framework is implemented and one adapter
exists, for GitHub: a token vault whose only exit is an `Authorization` header,
a guarded transport that shares the one egress gate rather than duplicating it,
least-privilege scopes with a stated rationale for each, duplicate-write
protection, and four tools in the same registry as every other tool. Covered by
five unit suites, an integration suite against a mock service, a security suite
and a real-Chromium E2E suite. The parts that are the same for every service —
the preflight that refuses an operation the grant does not cover, the call that
carries the task's own taint, the write claim, and the status mapping — are one
module rather than something a second adapter would copy; the duplicate-write
protection in particular must not exist twice, because two answers to "has this
write already happened" is a question with two answers.

**Two authentication mechanisms, and a correction.** The build authenticates
GitHub with a token the user creates in their own account. That is not a
convenience: the authorization-code flow it also supports **cannot be completed
against any of the six Tier 1 services**, because every one of them requires a
`client_secret` in the code exchange — GitHub for the web flow, Atlassian with
no PKCE at all, Figma even with PKCE — and this extension must not carry one.
An earlier revision of this row and of the clause blockers said the obstacle
was a missing registered application; that was wrong, and it stayed wrong
because no authorization had ever been attempted, so nothing had ever reached
the step that needs the secret. The external-blocker note above has the full
correction and the sources.

The token path is checked before anything is stored, which is the order that
matters: writing first would mean a worker evicted in between leaves an
unverified credential in the vault that `reconcile` reads back as a connection
and never re-examines. And a token's reach has three states, not two — GitHub
reports a classic token's scopes and reports nothing at all for a fine-grained
one, so "the service said none" and "the service would not say" are different
facts, and the second records no scopes and refuses every write rather than
claiming what the descriptor wanted.

PARTIAL for one reason, and it is external rather than architectural: **no
token from anybody's account is held here**, so no connector has been connected
to a real service. What has happened is that the credential check reaches the
live service — GitHub's own refusal of a non-credential string, over the
network, in real Chromium, is recorded — so the transport, the egress gate and
the failure classification are exercised against a live third party. A
successful connection and a real read or write still need a person with an
account, and `docs/release/OWNER-CHECKLIST.md` section D is now a procedure
that person can perform.

PARTIAL also because four connectors are not a connector ecosystem. **Figma is
the second**, and it is the second that needs nothing from the owner: no
registered application, no client id, no deployed anything. A personal access
token the user creates is the whole of it.

Figma is worth having for what it establishes rather than for what it reads. It
differs from GitHub in the three ways that make a framework a framework: its
credential goes in `X-Figma-Token` and **not** `Authorization`, which Figma
ignores; that header's value _is_ the token, with no scheme; and Figma reports
nothing about what a token may do. The first two moved the credential header
onto the descriptor — applied last, with every spelling of it _and_ of
`Authorization` stripped from caller headers first, so a caller still cannot
displace it or smuggle a second credential alongside it. A mutation removing
that stripping **survived the first battery**, because the mock service
lowercases header names as it records them and the credential, written last,
overwrote a differently-cased caller key; a browser's `Headers` does not
normalise before it appends, so the case now asserts on the raw header object
and counts the keys.

The third is why the adapter is read-only, and that is not caution. With no
reported scopes a write would declare `file_comments:write`, never satisfy it,
and be refused every time — an operation that can only fail reads as a broken
feature rather than an absent one. If Figma ever reports a token's scopes, a
write becomes implementable on evidence.

**Confluence is the fourth**, and it is the only one so far that was cheap. It
shares Atlassian's API, its credential shape and its site binding with Jira, so
what it needed was an adapter and nothing in the framework — which is the first
direct evidence that the site-bound connector built for Jira is a mechanism
rather than one adapter with a general-sounding name.

It is worth having for the question it answers that three could not: **two
connectors wanting the same site**. A user connecting both types the same email
and token twice, which looks like an oversight and is the opposite of one. A
credential record holds one token and one bound origin, and `connectorId` is
what the consent pin, the audit trail and the write guard key on; one record
shared between two connectors would make "which connector may reach where" a
question with two answers. So connecting Jira authorises nothing for
Confluence, each binds its own origin and the two may differ, and disconnecting
one leaves the other connected — measured in the real extension through the real
routes and real storage, which is where a shared record would have shown up.
The binding's host suffix is **imported** from the Jira adapter rather than
retyped, because two constants that must agree are one constant; a mutation
retyping it is killed.

It differs from Jira in two ways, both the service's shape rather than a
preference. Confluence's v1 search has **no POST form**, so its CQL travels in
a query string where Jira's JQL travels in a body — worth a case of its own,
because a query string is the part of a request that things nobody here
controls will log. And its page bodies are **markup**: Confluence storage
format is XHTML with macro elements in it, reduced to text by removing tags and
decoding the five XML entities rather than by parsing a stranger's document.
Handing markup to a model is handing it something to interpret.

Twenty mutations against the adapter are killed, with a passing baseline and a
positive control on the run. Two of them had to be killed by building a state
no ordinary test reaches: the adapter's own refusal when nothing is connected
and the shared runtime's are **byte-identical** — same code, same message, same
user message — so a test with nothing connected is satisfied by whichever fires
first and the adapter's guard is never exercised. A credential stored with no
binding makes the session READY while the origin is absent, which is the only
state where the adapter is the sole thing between a user's credential and a
host they never named. The same mutation survived for the same reason on Jira,
which is why it was looked for here.

**Jira is the third, and it is the framework change that was named and then
made.** This row used to say its API base is the user's own `*.atlassian.net`
site, that the reachable origin would have to come from the credential, and
that `apiOrigins` being fixed at registration made it a framework change rather
than an adapter. All of that was accurate. `site-binding.ts` is that change,
and it is a **tightening** rather than a loosening.

Two obvious fixes were both wrong. A wildcard origin would let one credential
authorise any host. An origin resolved from the request would let the caller
choose where the credential goes — the single decision the transport exists to
keep. What it does instead is bind the origin **to the credential**: parsed at
connect time against a suffix the descriptor states, stored in the same record
as the token, and the single entry in the transport's allowlist on every
request, read fresh. A fixed descriptor may declare several origins; a bound
one permits exactly one.

The adversarial cases are the reason it is allowed to exist, and they are in
`tests/security/site-binding.test.ts`: look-alike hosts with the suffix in the
middle, at the end of a longer name, in a path and in a query; the bare apex,
which is shared by everybody; a scheme change, a port, userinfo; a redirect to
another tenant; a credential whose binding has gone, which must permit
**nothing** rather than everything. Nineteen mutations against the boundary are
killed — and four survived the first battery, each because a later check was
standing in for the one under test, so the cases now pin **which** check fires.
One of those four was a real gap: the adapter's own refusal was never
exercised, because the session's `AUTH_REQUIRED` arrived first, and a mutation
replacing it with a hard-coded origin would have sent a user's Basic credential
to a host they never named.

Jira is read-only for the same reason Figma is: Basic auth reports no scopes,
so a write would declare one it could never establish and be refused every
time. That is also the conservative answer to a real asymmetry — a Jira write
is a comment on somebody's actual tracker, attributed to the user.

Confluence shares Atlassian's API and is now reachable by the same mechanism;
Google Sheets and Drive would need a registered client id. None is implemented,
and nothing returns a fake response for any of them.

What _was_ closed is narrower and worth naming precisely: the framework is now
shown to hold more than one connector rather than assumed to. A second,
test-only descriptor registers alongside the shipped one, and the suite proves
what keeps them apart — per-connector scopes, a vault keyed by connector, no
pooling of API origins, per-descriptor validation, and a duplicate id refused
rather than silently replacing an authorised one. The worker's registration
helper was typed to the single shipped adapter class and is now typed to the
`Connector` interface, so the framework is extensible at the point where a
connector is actually added and not merely everywhere else.

---

## Platform limitations

Per specification §99, capabilities unavailable for platform reasons:

| Reference capability                 | This project          | Limitation                                                                                          | Impact                                                                                          | Workaround                                                                                                                                                       | Accepted       |
| ------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Continue while the browser is closed | Not available         | A Chrome extension cannot run without Chrome                                                        | Tasks stop when Chrome closes                                                                   | Would require a cloud runtime (specification §94)                                                                                                                | Yes, for v1    |
| Automate `chrome://` pages           | Refused               | Chrome forbids content scripts there                                                                | Browser settings cannot be automated                                                            | None; this is also a deliberate safety boundary                                                                                                                  | Yes            |
| Automate the extension gallery       | Refused               | Chrome forbids it                                                                                   | Extensions cannot be installed by the agent                                                     | None; also a privilege-escalation boundary                                                                                                                       | Yes            |
| Encrypted credential storage         | **Available, opt-in** | `chrome.storage.local` is not encrypted at rest, so the extension encrypts what matters itself (K1) | Off by default: until the user sets a passphrase, a stored API key is readable from the profile | Turn K1 on. Provider credentials and the durable refresh token are then encrypted at rest and unreadable while locked; connector tokens are never on disk at all | Yes, see below |

**On that last row, precisely.** This read "Not available" until the claim was
checked against `src/storage/data-classification.ts`, where the answer is a
total table rather than a sentence. What K1 encrypts is exactly the two durable
credentials — the provider credential and the ABA refresh token. What it does
not encrypt is not an oversight in each case but a recorded decision:

- **Never on disk, so nothing to encrypt** — connector tokens, the ABA access
  token, OAuth transients and page content are `MEMORY_ONLY`. An earlier draft
  of that table called connector tokens encrypted, which would have claimed
  something the implementation does not do.
- **Plaintext by design** — the identity profile, device id and persistence
  health must be readable _before_ a passphrase can be asked for, or the unlock
  screen would depend on the unlock. Policy, schedules and workspaces must be
  readable while locked or a locked profile silently stops enforcing and
  scheduling. Tasks, workflows, shortcuts, preferences, **the audit trail** and
  evidence are the user's own work: disclosure is bounded by the profile that
  already holds them, and protecting them would cost a passphrase prompt before
  the panel could list anything.

So a local attacker with the Chrome profile reads the audit trail, the tasks
and the workflows whether or not K1 is on, and reads the API key only if it is
off. That is the honest statement, and it is narrower than either "encrypted
credential storage is unavailable" or "the profile is encrypted".

---

## Before claiming parity

Not claimable until every P-001…P-040 row reaches PASS, which requires at
minimum:

1. Playwright E2E coverage, so no row reads `E2E: no`.
2. The remaining NOT-STARTED capabilities implemented and tested — **two**
   today, P-025 Plugins and P-026 MCP. This line read "nine" until the count
   was checked against the table beneath it. Both now have a design gate rather
   than a blank: [`PLUGIN_TRUST_MODEL.md`](./docs/architecture/PLUGIN_TRUST_MODEL.md)
   records what a plugin can safely be under this architecture, and
   [`MCP_GUIDE.md`](./docs/MCP_GUIDE.md) records what P-026 is. Neither is
   implemented, and the gate is deliberately not permission to start: P-025 is
   waiting on a package format and the fact that a package's _authenticity_
   cannot be established here at all. P-025 is also the one row now adjudicated
   as **not on the Claude-Extension-parity critical path** — it is an internal
   specification requirement, and the section above says on what evidence. The
   sentence at the head of this list is therefore a statement of the internal
   specification's standard, not of the locked product goal's. P-026 is waiting on build alone — this
   line previously said "a transport decision", conflating two directions. The
   specification asks only for an MCP **client**, which has no unresolved design
   question left; exposing an MCP **server** needs an inbound channel every one
   of which is prohibited, and is not asked for.
3. ~~At least three provider adapters passing the same suite, proving P-033
   rather than asserting it.~~ **Done.** **Four** adapters —
   `openai-compatible`, `anthropic`, `gemini`, `nine-router` — pass one 21-case
   conformance suite, and switching between them runs in real Chromium against
   servers speaking each provider's real protocol. One live commercial endpoint
   has since been exercised through the owner's own gateway; the native vendor
   endpoints remain unexercised (see P-033 below).
4. The acceptance tests from specification §85–89 executed and recorded.

Progress against this list belongs in this file, updated in the same commit as
the code that changes it.
