# Blocker certification

What is genuinely blocked, what is merely unfinished, and which is which.

This is the eleventh part of the final independent engineering audit, and its
governing rule was: **do not put an engineering task into the external-blocker
category merely because it is inconvenient.** That rule earned its place. The
audit began with six clauses classified `EXTERNAL_REQUIRED`; one of them was not
external at all, and the misclassification had been standing long enough to read
as settled.

Four categories, and the boundaries between them are the point.

---

## A. True external blockers

Work that cannot proceed without something no amount of engineering here
produces: a credential, an account, a third party, or an origin somebody else
operates.

| #   | Blocked                                                                       | What is missing                                                                    | Clause        |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| #   | Blocked                                                                       | What is missing                                                                    | Clause        |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------          | ----------    |
| A-1 | A connector used against a real service                                       | **A token from the owner's own account.** Not a registered application — see below | `P-023-C8`    |
| A-2 | The Tier 1 connector roadmap — Jira, Confluence, Sheets, Drive, Figma, GitHub | Four of the six are written; the other two are Google's and need a client id       | `P-023-C9`    |
| A-3 | The §44 reference QA workflow                                                 | Three of its four services exist; Sheets does not, plus a **write** to Jira        | `P-022-C8`    |
| A-4 | The §44 reference QA skill                                                    | The same four services, of which Sheets is now the only one missing                | `P-024-C9`    |
| A-5 | Provider validation against live endpoints                                    | Paid credentials at OpenAI, Anthropic and Google                                   | `P-033-C5`    |
| A-7 | Managed-plugin authenticity                                                   | An organization, for `chrome.storage.managed`                                      | `P-025-C7`    |
| A-8 | Chrome Web Store submission                                                   | A developer account, a payment, and an agreement a person can be bound by          | Phases V–X    |
| A-9 | A live Google sign-in                                                         | A deployed backend and a Google OAuth client registered to it                      | — (no clause) |

**A-6 is gone, because it was resolved.** It was _"a remote MCP server — an
origin somebody else operates"_, and the paragraphs below it argued at length
that the clause had to stay external. It did not: `P-026-C2` is **VERIFIED**. A
public, documented, credential-free remote MCP server answered a conformant
`initialize` through the production path, and the blocker's second half —
_"and any credential it requires"_ — had never been checked. The argument that
followed it is kept below as a record of the reasoning, because it was careful
and it was wrong, and the way it was wrong is the most useful thing in this
document.

**A-1 and A-2 were misdescribed, and the correction changes what the owner
should do.** Both said the missing thing was a registered OAuth application.
Checked against each vendor's own documentation, that is false: GitHub's web
application flow requires a `client_secret`, Atlassian 3LO requires one and
supports no PKCE at all, and Figma requires one even with PKCE — and this
extension must not carry a secret, so **no registration would have unblocked
any of them**. It went unnoticed because with no client id the flow is refused
before it starts, so nothing ever reached the step that needs the secret.

What actually unblocks A-1 is a token the owner creates in their own account,
which takes minutes and needs no registration at all. Four connectors now
accept one — GitHub, Figma, Jira and Confluence — and
`docs/release/OWNER-CHECKLIST.md` section D is the procedure. A-2 still needs
two more connectors written _and_ a credential for each, so it stays, but it
is no longer "doubly blocked" in the way this document claimed: writing them is
ordinary work and the second lock was never a lock. The two that remain are
Google's, and those are the ones where a client id genuinely is the blocker.

**A-9 is new and has no clause.** No specification section asks for a live
Google sign-in, so nothing in the parity matrix is waiting on it — but the
product promises a Google login, and it has only ever been exercised against a
controlled backend. It is listed here because an owner reading this table to
find out what is left should find it.

### The A-6 argument, kept as a record of being wrong

Everything from here to the end of this section was written when `P-026-C2` was
external, and it concluded that the clause had to stay that way. It is kept
rather than deleted because the reasoning is careful, specific and mistaken,
and a table of blockers is exactly the document that benefits from showing how
one of its own entries fell over. The clause is now VERIFIED; a public
credential-free server was reached through the production path.

**A-6 was re-examined for a public server, and it stays external.** The question
asked was whether a free, unauthenticated, publicly operated MCP endpoint would
satisfy `P-026-C2` — an origin somebody else runs. One candidate turned up,
`https://mcpplaygroundonline.com/mcp-complex-server`, described as four tools
with no authentication. It is recorded here as a **lead for the account owner,
not as evidence**, for three reasons that are worth separating:

1. **It could not be verified from here.** This environment's egress proxy
   refuses the host (`CONNECT tunnel failed, 403`), so nothing in this
   repository has seen it answer an `initialize`. An unverified URL is not a
   finding.
2. **It would be the wrong shape for a clause gate even if it worked.** Basing a
   mandatory clause on a third party's free endpoint means CI breaks when the
   endpoint goes away and, worse, the recorded evidence quietly becomes
   unreproducible. This project already rejected the same trade once, for an
   independent OpenAI-compatible server.
3. **Unauthenticated-by-default is what it is advertising**, which makes it a
   reasonable thing to point a client at once by hand and a poor thing to make a
   build depend on.

What it _is_ good for is the account owner's own execution of `84-P-026`: a
public endpoint turns "find a remote MCP server" into one paste into Settings.
That is a real shortening of the human list, and it is why the lead is written
down rather than discarded.

**A-6 is narrower than it was.** Until this audit, `P-026-C3` — _local_ MCP —
sat beside it in this category. It should not have: the MCP project's own
reference server is an npm package speaking Streamable HTTP over loopback, and
running it found two defects that made this client unable to complete a handshake
with any conformant server. What A-6 still needs is an **operator**, not an
**implementation**, and that distinction is the whole method of this table.

---

## B. Human manual acceptance

Not blocked by a missing thing. Blocked by needing a person at a browser, doing
something no harness can drive.

| #   | What                                          | Why no automation reaches it                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-1 | The manual acceptance tests, executed by hand | §84 condition 3; unmet for **every** row, including the thirty-five that read PASS. Two rounds of D-column work have since cut it: the procedures were written, and then sixteen of the twenty-two new ones were **executed** as real-Chromium tests. What is left needing a person is six §84 procedures, four §90/§91 environment procedures, and the credential-blocked and OAuth-blocked items in category A |
| B-2 | Granting the optional `downloads` permission  | Chrome's own dialog is drawn by the browser and is not in any page's DOM (§91 procedure D-3-1, clause `P-011-C7`)                                                                                                                                                                                                                                                                                                |

B-1 is the single largest thing standing between this repository and a claim of
parity, and it is worth being exact about what it does and does not mean. Every
PASS in the matrix is a statement that the automated evidence for that row is
complete. None of them is a statement that a person has used the product and
agreed it works.

Being exact about it turned up something else, and it is the reason the D table
below is no longer closed. §84's condition 3 is three words — "manual acceptance
test **exists**" — and it is stated **per capability**. This repository read it
throughout as "a person has executed it", which is the stricter reading and is
kept; what nobody had checked is the literal one. The acceptance directory is
organised by specification section, and of the forty capabilities exactly one
appeared in it. So condition 3 had been answered repository-wide and never row
by row, and for twenty-two capabilities the manual acceptance test did not
exist to be executed. They are written now. B-1 is unchanged in kind and larger
in stated size, which is what happens when a blocker is measured rather than
estimated.

---

## C. Owner-level product decisions

Nothing is missing and nothing is blocked. Somebody has to decide.

| #   | Decision                                                                                  | Why it is not an engineering call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | Whether P-025 Plugins ships at all, and in which of the six models                        | The audit compared all six against the eight clauses (`PLUGIN_TRUST_MODEL.md` §9b). Five of the six are buildable now; the recommendation is **against** the cheapest one, because it would move five clauses to VERIFIED while installing a plugin — the thing a person means by the word — still did not exist. **What the decision is about has since narrowed.** The parity adjudication (`CLAUDE_BENCHMARK.md` §4b) found that plugins are documented Claude-in-Chrome behaviour in **Cowork-session** mode only, delivered by a cloud session, and are absent from the classic-mode capability list this project reproduces. So C-1 is no longer "which model closes a parity gap" but "whether to build a capability the comparison extension is not documented to host, to satisfy specification §5.10" — a product decision with no parity deadline behind it                                                                                                                                                  |
| C-2 | Whether a user may delete their own audit records                                         | Currently no deletion, bounded retention, a `retention.compacted` marker. Defensible and deliberate; the alternative is a product question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C-3 | Whether to widen the loopback predicate beyond `127.0.0.1`, `localhost` and `[::1]`       | It now has one definition and one place to change. Widening it decides which local addresses a model server may listen on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C-4 | Whether the backend is operated at all                                                    | Local-first is locked; the backend is optional by design. Running one is a decision about identity and sync, not about the browser agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| C-5 | Whether two people sharing one Chrome profile are isolated from each other                | Today only provider accounts and identity state are scoped to `abaUserId`; the task store, audit trail, workflows, shortcuts and evidence are not, so after a sign-out and a sign-in the Activity view shows the previous person's work. Isolating them is a storage migration touching K1 and sync, and it is the wrong work if the intended boundary is the Chrome profile — the operating system's own per-person boundary. See `THREAT_MODEL.md` T-19                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C-6 | Whether to reach controls inside **cross-origin iframes**, which needs `all_frames: true` | Recorded as divergence 12 in `CLAUDE_BENCHMARK.md` — _"Claude reads every frame; this build reads the top frame only"_ — and left _"recorded, not closed"_ with no decision written down, which is why it is here now. It is the remaining half of `P-006-C10`: shadow roots are walked, cross-origin frames are not. **Option A, leave it:** the content script stays in the top frame, the clause stays PARTIAL, and a page whose form lives in an iframe is out of reach — including some payment and embedded-widget flows. **Option B, widen it:** `all_frames: true` injects into every frame of every page the user grants, so the script runs inside third-party embeds — ad frames, trackers, social widgets — which multiplies the untrusted surface the page model reads from and is the one permission change a reviewer is most likely to question. Neither is free; A costs reach, B costs surface. No parity deadline sits behind it: the clause is already PARTIAL and the row is PASS on other grounds |

---

### Does any of C-1…C-5 block a public release?

Asked because a decision nobody has taken looks exactly like a blocker until
somebody checks, and four of these five turn out not to be one. Each row says
what a release does **today**, without the decision, and what the decision
would change.

| #   | Blocks a public release? | What ships without the decision                                                                                                                                                                                                                                      |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | **No**                   | P-025 stays NOT-STARTED and off the parity critical path, which the adjudication settled. A release without a plugin system is a release without a capability the comparison extension is not documented to host                                                     |
| C-2 | **No**                   | No in-product deletion, bounded retention, a compaction marker. The privacy policy now states the design and the reason — an append-only trail with an integrity check is what makes it answerable — so a user is told rather than left to discover it               |
| C-3 | **No**                   | The loopback predicate covers `127.0.0.1`, `localhost` and `[::1]`, has one definition and one place to change. A user whose local model server listens elsewhere is refused, which is the safe direction and a stated limit                                         |
| C-4 | **No**, and answered     | Local-first is locked and the backend must never be a runtime dependency, so **not** operating one is the default the locks already imply. There is no decision to take before a release; operating one later changes nothing about the browser agent                |
| C-5 | **No**, once disclosed   | The boundary is the Chrome profile, and that is now said plainly in `PRIVACY.md` under "Who your data belongs to". Building per-user isolation remains a decision; **disclosing the boundary that exists was not one**, and shipping without the disclosure would be |
| C-6 | **No**                   | `P-006-C10` stays PARTIAL either way, and the capability row is PASS on its other clauses. Widening is a permission change, so it would need a fresh review justification — doing it _after_ a first approval is cheaper than doing it before                        |

C-5 is the one that had a release obligation hiding inside it. Whether to build
the isolation is a product decision and stays open. Whether to _tell people what
the current boundary is_ never was: a person sharing a Chrome profile would
reasonably read "sign out" as "my work is now hidden", and it is not. That
sentence is engineering work, it is done, and it would have been wrong to ship
without it whichever way C-5 is eventually answered.

C-4 deserves separating for the opposite reason. It is listed as an owner
decision and the locked architecture already answers it: the backend is optional
by design and must not become a runtime dependency for normal operation, so the
release position is fixed regardless. It stays in this table as a record, not as
something anybody is waiting on.

## D. Engineering work still possible now

The category this audit existed to populate, and the reason the rule at the top
was written. Everything listed here **has been done during the audit** — it is
recorded so that the table is a history rather than a promise.

| Found                                                                     | Was classified as             | Actually                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Local MCP interop                                                         | External (`P-026-C3`)         | An npm package. Done, and it found two handshake-breaking defects                                 |
| Twelve authority-changing actions recording nothing                       | Not classified at all         | Nobody had asked the question in that direction                                                   |
| A debugger attachment outliving its task                                  | Not classified at all         | Found by asking what a terminal state releases                                                    |
| An export/import widening a shortcut                                      | Not classified at all         | Found by asking what crosses a boundary in the _safe_ direction                                   |
| Six copies of the loopback predicate, one already diverged                | Not classified at all         | Found by reading the shipped bundle rather than the source                                        |
| Two stale rows in the security census table                               | Not classified at all         | Found by checking prose against the suite it points at                                            |
| `siteAuthorization: 'destination'` pinned by nothing                      | Not classified at all         | Found by mutation                                                                                 |
| A clause citing `§91` for a permission dialog                             | Not classified at all         | Found by reading project-level clauses rather than capability clauses                             |
| A threat-model row claiming a control it did not have                     | Not classified at all         | Found by asking what the audit trail does in a profile two people share                           |
| Acceptance packages unchecked against the specification's own item lists  | Not classified at all         | Found by asking whether §81's failure mode repeats one level down                                 |
| §84 condition 3 never answered per capability, for thirty-nine of forty   | Not classified at all         | Found by reading the specification's own three words rather than the repository's gloss on them   |
| §84 conditions 4 and 5 never answered per capability either               | Not classified at all         | Found by running the same question over the other five conditions once condition 3 had fallen     |
| Sixteen of the twenty-two new §84 procedures were executable all along    | `BLOCKED — HUMAN/ENVIRONMENT` | Found by asking, of each written procedure, whether a real-Chromium test could meet its criterion |
| **A looping task never finished**, and two fail-closed stops did the same | Not classified at all         | Found by _executing_ a procedure rather than writing one — 84-P-037, on its first run             |

The last of those is worth separating, because only half of it was mine to fix.
`IDENTITY_AND_SYNC.md` listed "Cross-user data access" against a control that only
ever covered provider accounts, so the document claimed more isolation than the
code has. Narrowing that claim to what it holds, and writing the rest down as
`THREAT_MODEL.md` T-19, is engineering work and is done. Building the isolation is
not: it is C-5 above, because the right answer depends on whether this product
means to be stricter than the browser it lives in.

**Three rows have now been added after this table declared itself closed**, and the
sentence they replace said "the remaining D row is empty". It was not empty, and
the reason is worth more than the correction: every sweep this audit ran took
the repository's own framing as given, and condition 3 had been glossed as
execution so consistently that nothing ever read the three words. The finding
came from the P-025 parity adjudication, which forced the question "what
exactly does this condition require?" one level up from where it was being
asked.

So the honest version of the old claim is narrower. The sweeps performed — every
control-plane route, every capability's citations, eighteen mutations, a clean
release build, a cross-capability pass and a project-level clause pass — turned
up nothing further **within the framings they used**. A sweep that re-derives a
requirement from the specification instead of from this repository's summary of
it is a different sweep, and it has now found three things. Whether it would
find more is an open question, and this table no longer claims otherwise.

The third of them came from a different kind of sweep again, and is the one
worth generalising from. Writing a manual acceptance procedure and executing it
are not the same act, and only the second one can find a bug: 84-P-037 was
written, looked correct, cited a clause reading `VERIFIED`, and failed the first
time anybody ran it — the loop detector stopped the task and the task then never
finished. No automated evidence here could have caught it, because every
existing test asserted on what the detector decided rather than on what the task
did next. **A procedure that has not been executed is not evidence, and the rows
below that still need a person should be read as though any of them might do the
same.**

---

## How to read this table against the matrix

The matrix says 36 PASS, 3 PARTIAL, 1 NOT-STARTED. This table says why the last
four are not PASS, and the answers are not interchangeable:

- **P-022, P-023, P-024** — PARTIAL on A-1 through A-5. Services and credentials.
- ~~**P-026** — PARTIAL on A-6 alone. An operator, not an implementation.~~
  **Now PASS.** A-6 assumed an operator was unobtainable without checking;
  public credential-free remote MCP servers exist and one was reached.
- **P-025** — NOT-STARTED on C-1, which is a decision, plus A-7 for one clause of
  the six models. It is the only row whose status turns on a decision nobody has
  taken rather than on a thing nobody has — and, since the parity adjudication,
  the only row that is **not on the Claude-Extension-parity critical path** at
  all. It remains a specification §5.10 requirement. A-7 therefore blocks a
  clause of an internal requirement rather than a clause of parity, which does
  not make it less blocked; it makes it blocked in a category that no longer
  gates the locked product goal.

C-5 sits outside the matrix entirely, and that is itself worth noticing: no
capability row covers "two people share a Chrome profile", so nothing in the
forty could have surfaced it. It came from asking what the audit trail does when
the signed-in user changes — a question about the seam between two capabilities
rather than about either one.

And every one of the 35 PASS rows still carries B-1.
