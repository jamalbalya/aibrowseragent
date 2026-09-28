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

| #   | Blocked                                                                       | What is missing                                                           | Clause     |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------- |
| A-1 | A connector used against a real service                                       | A third-party OAuth application, registered by an account holder          | `P-023-C8` |
| A-2 | The Tier 1 connector roadmap — Jira, Confluence, Sheets, Drive, Figma, GitHub | Six services and their OAuth applications                                 | `P-023-C9` |
| A-3 | The §44 reference QA workflow                                                 | Jira, Confluence, Figma and Sheets, with a **write** to Jira              | `P-022-C8` |
| A-4 | The §44 reference QA skill                                                    | The same four services                                                    | `P-024-C9` |
| A-5 | Provider validation against live endpoints                                    | Paid credentials at OpenAI, Anthropic and Google                          | `P-033-C5` |
| A-6 | A **remote** MCP server                                                       | An origin somebody else operates                                          | `P-026-C2` |
| A-7 | Managed-plugin authenticity                                                   | An organization, for `chrome.storage.managed`                             | `P-025-C7` |
| A-8 | Chrome Web Store submission                                                   | A developer account, a payment, and an agreement a person can be bound by | Phases V–X |

**A-1 and A-2 are doubly blocked**, and the second lock matters more than the
first: supplying them from here would mean inventing OAuth credentials or
inventing production connectors, both of which are on this project's locked
prohibition list. Even with credentials in hand, a connector written against a
service nobody has exercised is not evidence.

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

| #   | What                                         | Why no automation reaches it                                                                                       |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| B-1 | §85 scenarios A–F, executed by hand          | §84 condition 3 requires human acceptance; it is unmet for **every** row, including the thirty-five that read PASS |
| B-2 | Granting the optional `downloads` permission | Chrome's own dialog is drawn by the browser and is not in any page's DOM (§91 procedure D-3-1, clause `P-011-C7`)  |

B-1 is the single largest thing standing between this repository and a claim of
parity, and it is worth being exact about what it does and does not mean. Every
PASS in the matrix is a statement that the automated evidence for that row is
complete. None of them is a statement that a person has used the product and
agreed it works.

---

## C. Owner-level product decisions

Nothing is missing and nothing is blocked. Somebody has to decide.

| #   | Decision                                                                            | Why it is not an engineering call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-1 | Whether P-025 Plugins ships at all, and in which of the six models                  | The audit compared all six against the eight clauses (`PLUGIN_TRUST_MODEL.md` §9b). Five of the six are buildable now; the recommendation is **against** the cheapest one, because it would move five clauses to VERIFIED while installing a plugin — the thing a person means by the word — still did not exist. **What the decision is about has since narrowed.** The parity adjudication (`CLAUDE_BENCHMARK.md` §4b) found that plugins are documented Claude-in-Chrome behaviour in **Cowork-session** mode only, delivered by a cloud session, and are absent from the classic-mode capability list this project reproduces. So C-1 is no longer "which model closes a parity gap" but "whether to build a capability the comparison extension is not documented to host, to satisfy specification §5.10" — a product decision with no parity deadline behind it |
| C-2 | Whether a user may delete their own audit records                                   | Currently no deletion, bounded retention, a `retention.compacted` marker. Defensible and deliberate; the alternative is a product question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| C-3 | Whether to widen the loopback predicate beyond `127.0.0.1`, `localhost` and `[::1]` | It now has one definition and one place to change. Widening it decides which local addresses a model server may listen on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C-4 | Whether the backend is operated at all                                              | Local-first is locked; the backend is optional by design. Running one is a decision about identity and sync, not about the browser agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| C-5 | Whether two people sharing one Chrome profile are isolated from each other          | Today only provider accounts and identity state are scoped to `abaUserId`; the task store, audit trail, workflows, shortcuts and evidence are not, so after a sign-out and a sign-in the Activity view shows the previous person's work. Isolating them is a storage migration touching K1 and sync, and it is the wrong work if the intended boundary is the Chrome profile — the operating system's own per-person boundary. See `THREAT_MODEL.md` T-19                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## D. Engineering work still possible now

The category this audit existed to populate, and the reason the rule at the top
was written. Everything listed here **has been done during the audit** — it is
recorded so that the table is a history rather than a promise.

| Found                                                                    | Was classified as     | Actually                                                                |
| ------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------- |
| Local MCP interop                                                        | External (`P-026-C3`) | An npm package. Done, and it found two handshake-breaking defects       |
| Twelve authority-changing actions recording nothing                      | Not classified at all | Nobody had asked the question in that direction                         |
| A debugger attachment outliving its task                                 | Not classified at all | Found by asking what a terminal state releases                          |
| An export/import widening a shortcut                                     | Not classified at all | Found by asking what crosses a boundary in the _safe_ direction         |
| Six copies of the loopback predicate, one already diverged               | Not classified at all | Found by reading the shipped bundle rather than the source              |
| Two stale rows in the security census table                              | Not classified at all | Found by checking prose against the suite it points at                  |
| `siteAuthorization: 'destination'` pinned by nothing                     | Not classified at all | Found by mutation                                                       |
| A clause citing `§91` for a permission dialog                            | Not classified at all | Found by reading project-level clauses rather than capability clauses   |
| A threat-model row claiming a control it did not have                    | Not classified at all | Found by asking what the audit trail does in a profile two people share |
| Acceptance packages unchecked against the specification's own item lists | Not classified at all | Found by asking whether §81's failure mode repeats one level down       |

The last of those is worth separating, because only half of it was mine to fix.
`IDENTITY_AND_SYNC.md` listed "Cross-user data access" against a control that only
ever covered provider accounts, so the document claimed more isolation than the
code has. Narrowing that claim to what it holds, and writing the rest down as
`THREAT_MODEL.md` T-19, is engineering work and is done. Building the isolation is
not: it is C-5 above, because the right answer depends on whether this product
means to be stricter than the browser it lives in.

**The remaining D row is empty.** That is a claim about this audit's reach, not
about the product being finished: it means the sweeps performed — every
control-plane route, every capability's citations, eighteen mutations, a clean
release build, a cross-capability pass and a project-level clause pass — turned
up nothing further that could be built without something from category A, B or C.

---

## How to read this table against the matrix

The matrix says 35 PASS, 4 PARTIAL, 1 NOT-STARTED. This table says why the last
five are not PASS, and the answers are not interchangeable:

- **P-022, P-023, P-024** — PARTIAL on A-1 through A-5. Services and credentials.
- **P-026** — PARTIAL on A-6 alone. An operator, not an implementation.
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
