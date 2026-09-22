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

|                                |                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Commit                         | the commit that introduced this directory — see `git log` for this file                        |
| Unit, integration and security | 2061 tests in 77 files, all passing                                                            |
| Real Chromium (Playwright)     | 173 tests, all passing                                                                         |
| Chromium                       | the Playwright-managed build at `/opt/pw-browsers/chromium` locally, and the build CI installs |
| Command                        | `./scripts/verify.sh --e2e`                                                                    |

This table is a statement about the suite as a whole. It is deliberately not a
per-item result: an item is `AUTOMATED` because named tests establish it, and
those tests are part of the run above.

---

## Manual execution

**Nothing in this section has been executed.**

Every manual procedure in this directory is written and none has been run.
This is stated once, plainly, rather than repeated as a status column that
could be edited item by item without anyone noticing.

| Package | Item                 | Procedure              | Status                                          |
| ------- | -------------------- | ---------------------- | ----------------------------------------------- |
| §85     | A. Basic browser     | A-1 summary quality    | NOT YET EXECUTED                                |
| §85     | B. Multi-tab         | B-1 three tabs         | NOT YET EXECUTED                                |
| §85     | C. Debugging         | C-1 a real diagnosis   | NOT YET EXECUTED                                |
| §85     | F. Provider swap     | F-1 real endpoints     | NOT YET EXECUTED — needs vendor API keys        |
| §86     | Duplicate write      | against a real service | NOT YET EXECUTED — needs a registered OAuth app |
| §87     | all twelve           | against a real vendor  | NOT YET EXECUTED — needs vendor API keys        |
| §88     | Connect              | C-1 a real grant       | NOT YET EXECUTED — needs a registered OAuth app |
| §88     | Read                 | R-1                    | NOT YET EXECUTED — needs C-1 first              |
| §88     | Revocation           | V-1                    | NOT YET EXECUTED — needs C-1 first              |
| §89     | Popup                | P-1                    | NOT YET EXECUTED                                |
| §89     | SPA navigation       | S-1                    | NOT YET EXECUTED                                |
| §89     | Modal                | M-1                    | NOT YET EXECUTED                                |
| §90     | Browser restart      | B-1                    | NOT YET EXECUTED                                |
| §90     | Extension reload     | E-1                    | NOT YET EXECUTED                                |
| §90     | Network interruption | N-1                    | NOT YET EXECUTED                                |

Four of these need nothing but a person and a browser — §89's P-1, S-1 and
M-1, and §90's B-1 and E-1 — and they are the ones covering behaviour no
automated test in this repository exercises. They are the highest-value
manual work here, and they are not blocked on anything external.

The rest are blocked on an account owner: vendor API keys, and a registered
OAuth application. No credential is fabricated to make them appear runnable.

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
