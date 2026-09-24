# Acceptance execution record

What has actually been executed. Nothing else in this directory records a
result, and no verdict elsewhere should be read as one.

An item marked `AUTOMATED` in a package is established by tests that ran — the
run is recorded below. An item marked `MANUAL` has a written procedure and is
`NOT YET EXECUTED` until somebody runs it and appends what happened here.

---

## Automated evidence

Every test cited in this directory ran, green, at the commit below. The
citations themselves are checked by `scripts/check-acceptance.mjs`, which runs
in `scripts/verify.sh` and in CI, so a citation cannot survive the test it
names being renamed or deleted.

**This is a dated execution record, like every other entry in this file. It is
not a current count and is not updated in place.**

|                                |                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Commit                         | `492a66e`, 2026-09-22 — the commit that introduced this directory                              |
| Unit, integration and security | 2119 tests in 79 files, all passing                                                            |
| Real Chromium (Playwright)     | 189 tests, all passing                                                                         |
| Chromium                       | the Playwright-managed build at `/opt/pw-browsers/chromium` locally, and the build CI installs |
| Command                        | `./scripts/verify.sh --e2e`                                                                    |

Later waves added tests, so the suite is larger now than the figures above.
Those figures are left exactly as recorded, because rewriting a result to
match a later run would destroy the thing that makes it evidence. For the
count at any given commit, run `npm run verify` there, or read the CI run for
it — that is the current number, and this table is not.

This table is a statement about the suite as a whole at that commit. It is
deliberately not a per-item result: an item is `AUTOMATED` because named tests
establish it, and those tests are part of the run above.

---

## Manual execution

**Three of the fifteen written procedures have been executed, plus two that
were not on the list. Twelve remain blocked.**

Executed on 2026-09-22 against the built extension in real Chromium: §89's
P-1 (popup), S-1 (SPA navigation) and M-1 (modal) from the list of fifteen,
and two further procedures that were not on it — the iframe exclusion, and
§90's malformed persisted state. Two of the five **failed**. That is the reason they were worth
executing: both failures were product defects, both are fixed, and both are
recorded below with what the failure actually was rather than only that it
happened.

Executing them turned each procedure into an automated test, so they now run
on every build instead of waiting for somebody to remember. That is a better
outcome than a manual pass, and it is why the verdicts read
`EXECUTED — MET (now automated)`.

### §89 P-1 — Popup — 2026-09-22 — EXECUTED — MET (now automated)

- Commit: 1036aea · real Chromium · `tests/e2e/browser-failures.spec.ts`
- Steps: served a page with a `target=_blank` link and a `window.open`
  button; clicked each; counted real tabs before and after through
  `chrome.tabs`; asked the new tab's content script for a page model.
- Expected: the second tab exists, the agent sees it, and it is automatable.
- Actual: a real second tab opened both ways, `chrome.tabs.query` listed it,
  and the content script answered `content.readPage` inside it.
- Evidence: 2 cases in `browser-failures.spec.ts`.

### §89 S-1 — SPA navigation — 2026-09-22 — EXECUTED — MET (now automated)

- Steps: read a page; changed route with `history.pushState` so the document
  never reloaded; clicked a handle issued before the change; read again.
- Expected: the stale handle is refused, not resolved against the new route.
- Actual: refused with `ELEMENT_NOT_FOUND` — "The element was removed from
  the page. Read the page again." A fresh read showed the new route's
  elements and none of the old ones.
- Evidence: 2 cases in `browser-failures.spec.ts`.

### §89 M-1 — Modal — 2026-09-22 — **EXECUTED — NOT MET**, defect fixed, re-executed MET

- Steps: served a page with a full-screen overlay covering a "Buy now"
  button; confirmed with `document.elementFromPoint` that the overlay is what
  a person's click would hit; asked the extension to click the button.
- Expected, unchanged from before execution: not met if it reports a
  successful click on an element a person could not have clicked.
- **Actual on first execution: FAIL.** The click was reported successful and
  the page recorded it. A synthetic click reaches the node whatever is
  painted over it, and nothing hit-tested. `isVisible` said yes correctly —
  the button was displayed, opaque, had a box and passed `checkVisibility` —
  because none of those notice what is on top.
- Fix: `isObscured` in `src/content/interaction-engine.ts` samples the centre
  and four inset corners after scrolling, and the six interaction functions
  go through `scrollIntoViewAndAssertReachable`. An element counts as
  reachable if the topmost thing at any sampled point is itself, a descendant
  (a button's own `<span>`) or an ancestor (a `<label>`). Where nothing can
  be measured it reports not-obscured, so an unmeasurable page does not
  become an unusable one.
- Actual after the fix: refused with `ELEMENT_NOT_INTERACTABLE` — "Something
  is covering this element… A dialog, cookie banner or overlay is usually the
  cause" — and the page confirmed the button was never activated. Dismissing
  the dialog first makes it clickable, which is the positive control.
- Evidence: 4 cases in `browser-failures.spec.ts`, 12 in
  `tests/unit/occlusion.test.ts`, 7 mutations all caught.

### §89 — Iframe — 2026-09-22 — EXECUTED — MET (limit confirmed, not cleared)

- Steps: served a host document embedding a **same-origin** child — the
  harder case to exclude, since a cross-origin frame the browser excludes
  anyway; confirmed the child really loaded; read the page model; tried to act
  inside the frame; asked Chrome which frames answered a content-script
  message.
- Actual: the model held `Outer button` and nothing from the child. Frame 0
  answered `content.readPage`; frame 1 did not. An invented handle was
  refused and the child's field was untouched.
- This confirms the limitation rather than clearing it: a form field inside an
  iframe is unreachable, and that is the price of `all_frames: false`.
- Evidence: 4 cases in `browser-failures.spec.ts`.

### §90 — Malformed persisted state — 2026-09-22 — **EXECUTED — NOT MET**, defect fixed, re-executed MET

- Steps: wrote real garbage into real `chrome.storage.local` under the keys
  the stores read — a truncated task index, an unparseable task record, a
  truncated health record, an edited audit record — killed the service
  worker, and asked the revived worker what it believed.
- Expected: a read that cannot be understood fails closed. In particular the
  health record must not read as HEALTHY.
- **Actual on first execution: FAIL for the health record.** It reported
  `HEALTHY` and did not block. The read was
  `(await get(KEY))?.records ?? []`, so a present-but-malformed value took the
  same path as an absent one — and an empty list means a clean profile. Those
  mean opposite things: nothing written is a new install, something
  unreadable is evidence that storage misbehaved.
- Fix: `isHealthIndex` in `src/storage/persistence-health.ts` checks the
  container shape. A value that is not an object holding a list of records
  marks `storage` IRRECOVERABLE, with the reason "the health record could not
  be understood" — deliberately distinct from "could not be read", because
  the two faults have different remedies. Narrowed to the container on
  purpose: individually malformed _records_ inside a well-formed container
  are still dropped rather than interpreted, which is a separate decision,
  already settled and tested, that this execution did not test.
- Actual after the fix: gating is not HEALTHY, work is blocked, and an absent
  record still reads as a clean profile so a first run is not blocked.
- The other three held on first execution: a corrupt task index did not
  present as an empty healthy profile, an unreadable task record was never
  resumable, and an edited audit record was caught by the integrity check.
- Evidence: 4 cases in `tests/e2e/persisted-state.spec.ts`, 10 in
  `tests/unit/persistence-health.test.ts`, 5 mutations all caught.

### §90 — Service worker restart — already covered, not re-run by hand

Executed on every build by `mv3-lifecycle.spec.ts`, `persistence-health.spec.ts`,
`egress.spec.ts`, `audit.spec.ts`, `skills.spec.ts` and `route-trust.spec.ts`,
each against a real Chrome service-worker termination. A person repeating what
nine automated cases already do in a real browser would add nothing.

---

## Still not executed

Each is blocked on something this repository does not hold and will not
invent. Stated per item rather than as one excuse.

| Package | Item                 | Procedure              | Status                | What unblocks it                             |
| ------- | -------------------- | ---------------------- | --------------------- | -------------------------------------------- |
| §85     | A. Basic browser     | A-1 summary quality    | BLOCKED               | a vendor API key                             |
| §85     | B. Multi-tab         | B-1 three tabs         | BLOCKED               | a vendor API key                             |
| §85     | C. Debugging         | C-1 a real diagnosis   | BLOCKED               | a vendor API key                             |
| §85     | F. Provider swap     | F-1 real endpoints     | BLOCKED               | keys for all three vendors                   |
| §86     | Duplicate write      | against a real service | BLOCKED               | a registered OAuth application               |
| §87     | all twelve           | against a real vendor  | BLOCKED               | a vendor API key per provider                |
| §88     | Connect              | C-1 a real grant       | BLOCKED               | a registered OAuth application               |
| §88     | Read                 | R-1                    | BLOCKED               | §88 C-1 first                                |
| §88     | Revocation           | V-1                    | BLOCKED               | §88 C-1 first                                |
| §90     | Browser restart      | B-1                    | BLOCKED — environment | a person able to quit and reopen Chrome      |
| §90     | Extension reload     | E-1                    | BLOCKED — environment | a person at `chrome://extensions`            |
| §90     | Network interruption | N-1                    | BLOCKED — environment | a person able to drop the interface mid-task |

The first nine need a credential. A session that fabricated one would produce
a green result describing nothing.

The last three need a person at a machine **and a provider key**: each starts
by running a task, so there is nothing to interrupt without one. Playwright drives the browser it
launched: it cannot quit that browser and reattach to the same profile, and it
cannot reload the extension out from under its own connection. Each is written
and each takes a few minutes.

**§85 D and E remain NOT POSSIBLE HERE** — they name Jira, Confluence, Figma
and Google Sheets, and this repository implements one connector. That is a
capability gap, not a credential gap, and no credential would unblock it.

---

## Items that cannot be executed here at all

| Package | Item           | Reason                                                     |
| ------- | -------------- | ---------------------------------------------------------- |
| §85     | D. Connector   | No Jira connector exists in this repository                |
| §85     | E. QA workflow | Four of its six services have no connector here            |
| §89     | Iframe         | `all_frames` is false; the extension does not enter frames |

§85 D and E are capability gaps tracked in `PARITY_MATRIX.md`; nothing
external prevents them being built. §89's iframe item is a deliberate
security position, asserted as a standing invariant so it cannot be widened
quietly.

---

## How to append a result

Add a section under **Manual execution** in this shape:

```markdown
### §89 M-1 — Modal — 2026-10-01

- Commit: abc1234
- Chrome: 141.0.7390.54 (Linux)
- Page: a consent banner on example.test
- Observed: the agent reported the element was not interactable and offered to
  dismiss the banner first.
- Verdict: EXECUTED — MET
```

Verdicts are `EXECUTED — MET`, `EXECUTED — NOT MET`, or `EXECUTED — BLOCKED`
with what blocked it. An item not attempted stays `NOT YET EXECUTED`; there is
no verdict for having read the procedure.

Record the observation even when the item was met. A result that says only
"met" cannot be re-examined later by somebody who was not there.
