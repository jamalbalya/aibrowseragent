# Submission candidate — the facts for one decision

This document exists so that one decision can be made from facts rather than
from a summary: **whether to replace the artifact currently pending Chrome Web
Store review.**

It is deliberately not a recommendation. The decision needs the dashboard, and
this repository cannot see it.

Nothing here has been uploaded, replaced, withdrawn or resubmitted. No Chrome
Web Store account was accessed.

---

## 1. The two artifacts

|                 | Previously submitted                              | Current candidate                                                  |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Version         | `0.1.0`                                           | `0.1.0`                                                            |
| SHA-256         | **not recorded — see below**                      | `78e5cb0ce13a55f66ecdb1fd42b2b59d17fc03dd274ece941aeecc4dd958d6fa` |
| Bytes           | not recorded                                      | 282,474                                                            |
| Entries         | not recorded                                      | 13                                                                 |
| Source commit   | not recorded                                      | the commit this file was committed in                              |
| Submission date | not recorded; reported as on or before 2026-10-01 | not submitted                                                      |
| Store status    | reported `Pending Review`, owner-reported         | not submitted                                                      |

**The submitted digest is genuinely unknown to this repository, and that is a
decision rather than an oversight.** `docs/release/README.md` records why: the
item id, the submission date and the uploaded digest live in the owner's Chrome
Web Store account, this repository cannot verify any of them, and _"recording
an unverifiable value in prose is how the digest in this very document went
stale three times."_

So the two artifacts **cannot be compared by digest from here.** What can be
said is weaker and still useful: the current candidate is built from a tree
that has moved since any plausible submission date, so the bytes certainly
differ — the digest is a function of the source tree, and `src/` has changed.

Both are version `0.1.0`. **The Chrome Web Store will refuse an upload whose
version is not higher than the published one**, and this package has never been
published, so the pending item is the only thing `0.1.0` is spent on. If the
owner replaces the pending submission, `0.1.0` is reusable; if the pending one
is approved first, the next upload needs a higher version. That is a fact about
the Store's version rule, not about this queue.

---

## 2. What has not changed, which is what a reviewer looks at

Byte-identical between the submitted artifact and this candidate, because
neither has been touched since before the submission:

|                          |                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Permissions              | `sidePanel`, `storage`, `unlimitedStorage`, `tabs`, `tabGroups`, `scripting`, `debugger`, `notifications`, `activeTab`, `alarms` |
| Optional permissions     | `downloads`                                                                                                                      |
| Host access              | `http://*/*`, `https://*/*` — **not** `<all_urls>`                                                                               |
| Content scripts          | `all_frames: false`                                                                                                              |
| CSP                      | `script-src 'self'; object-src 'self'`                                                                                           |
| Web-accessible resources | `oauth/callback.html`, to `https://github.com/*` only                                                                            |
| Remote code              | none                                                                                                                             |

No permission has been added since the submission. That is the single thing a
reviewer scrutinises hardest, and a resubmission that widened it would be a
materially different review.

---

## 3. The sign-in defect, and why it is not in the submitted artifact

An earlier revision of `docs/release/README.md` told the owner that the pending
artifact contained a defect a reviewer would hit. **That was wrong**, and the
correction is the most important thing in this document.

### What the defect was

|            |                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introduced | `e7fbae3`, 2026-09-23 — the commit that added the local installation identity                                                                                                                                                                            |
| Fixed      | `ef66e4e`, 2026-10-02                                                                                                                                                                                                                                    |
| Code path  | `resolveOwner` failed closed when a local installation id and a signed-in profile id disagreed → `currentAbaUserId` reported persistence `RECOVERY_REQUIRED` → `TaskManager.requireHealthyPersistence` refused every `task.create` with `POLICY_BLOCKED` |
| Symptom    | "Stored state needs to be reviewed before work can continue", with nothing wrong with the stored state                                                                                                                                                   |

### Why it cannot be reached in a shipped build

The conflict needs **two** ids. The second is a _profile_ id, written only by
`recordSignIn`, which both `signInWithGoogle` and `verifyEmailSignIn` refuse to
reach when no backend origin is compiled in. The shipped build has none: the
origin is inlined by Vite at build time, there is no default, and nothing can
set one at run time.

So no profile is ever written, the two ids never disagree, and the conflict
never fires.

### How that was established — measured, not reasoned

- `tests/e2e/auth-google.spec.ts :: the sign-in ownership conflict is
unreachable in the shipped build` drives the shipped `dist` in real Chromium:
  both sign-in paths answer `NOT_CONFIGURED`, no `identity-profile:profile` key
  exists in storage, the health record does not say `RECOVERY_REQUIRED`, and
  `task.create` is not `POLICY_BLOCKED`.
- That **same case was run against a build with the old, defective resolution
  restored** and a shipped configuration. It still passed. That is what
  establishes unreachability rather than merely "fixed".
- `tests/security/local-identity.test.ts` pins the reachability argument
  without a browser: the `NOT_CONFIGURED` guard precedes any provider call,
  `recordSignIn` has exactly two call sites and both are behind it, and
  `loadIdentityConfig()` returns `null` when nothing was compiled in. Three
  mutations against those guards are killed.

### What it was reachable in

Exactly one build: `dist-auth`, the fixture built with an origin inlined for
`auth-google-protocol.spec.ts`. That is a test artifact and has never been
uploaded anywhere.

### The regression test is preserved

`auth-google-protocol.spec.ts :: 03b` reproduces the original failure and
proves the corrected behaviour, by signing in and then **running a task**.
Restoring the old behaviour fails five E2E cases and two unit cases.

**Consequence for the decision:** there is no correctness argument for
replacing the pending submission. The question is capability and queue position
only.

---

## 4. Checks the candidate passed

All run on the tree this candidate was built from, on Node 22.23.3.

| Check                         | Result                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run verify`              | pass — format, lint, typecheck, tests, build, package, parity, acceptance, notices                  |
| Unit / integration / security | 4,389 passed, 34 skipped, 180 files                                                                 |
| Real-Chromium E2E             | 506 passed, in 8.4 minutes, against this tree                                                       |
| `npm audit --omit=dev`        | 0 vulnerabilities                                                                                   |
| Reproducibility               | deterministic over repeated packing, digest verified with `sha256sum -c`                            |
| Parity                        | 36 PASS / 3 PARTIAL / 1 NOT-STARTED across 40 capabilities                                          |
| Acceptance                    | 12 documents, 342 citations, all resolving                                                          |
| Artifact scan                 | no `eval`, no `new Function`, no `Runtime.evaluate`, no remote script source, no key-shaped strings |

---

## 4a. The core journey, step by step

The product's claim is one sequence: sign in for product identity, connect an
AI provider account separately, choose which one is active, and have the agent
use **that** one. Each step below names the measurement that covers it in the
shipped build, so a reader can check a step rather than take a verdict. Every
citation is a real-Chromium case unless it says otherwise.

| #   | Step                                       | Shipped build                                                                           | Measured by                                                                                                  |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Install, and the panel opens beside a page | works                                                                                   | `extension-load.spec.ts :: the side panel mounts and reports no provider before one is configured`           |
| 2   | First launch offers work, not a sign-up    | works                                                                                   | `standalone-ux.spec.ts :: first launch offers work, not a sign-up`                                           |
| 3   | Sign in with Google                        | **absent, not broken** — no backend origin is compiled in, so the option is not offered | `auth-google.spec.ts :: sign-in refuses when no backend is configured, rather than reaching out`             |
| 4   | Connect an AI provider account             | works                                                                                   | `provider-connection.spec.ts :: connecting an account through Settings leaves something that can run a task` |
| 5   | A connection that was never checked        | usable, and marked unverified rather than assumed                                       | `provider-connection.spec.ts :: an account connected but never checked is still the one a task uses`         |
| 6   | Hold two accounts at once                  | works, with separate credentials                                                        | `multi-account.spec.ts :: two accounts on one endpoint coexist with separate credentials`                    |
| 7   | Choose which account is active             | works, and survives a worker restart                                                    | `multi-account.spec.ts :: accounts and the brain survive in real storage across a restart`                   |
| 8   | **The chosen one is the one that runs**    | works                                                                                   | `multi-account.spec.ts :: the selected account is the one that actually serves the agent’s request`          |
| 9   | Run a browser task                         | works                                                                                   | `agent-task.spec.ts :: reads a real page and reports a summary with evidence`                                |
| 10  | Connect a connector and use it             | four exist; a real token is owner-held                                                  | `connector.spec.ts` (25 cases); live use is §5 below                                                         |
| 11  | See what was done                          | works                                                                                   | `audit.spec.ts :: a genuine browser action leaves a record in the trail`                                     |
| 12  | All of it with no backend at all           | works                                                                                   | `local-first.spec.ts :: workflows, shortcuts and workspaces all work with no backend at all`                 |

Three things this review establishes that are worth stating plainly.

**Step 3 is the only step the shipped build does not perform, and it is absent
rather than half-working.** The panel reports the configured state instead of
offering a button that cannot work. The full journey _with_ sign-in — steps 3
through 8 in one run, ending in a task served by the selected account — is
measured in `auth-google-protocol.spec.ts :: 03b`, against `dist-auth`, the
fixture build with a backend origin inlined. That is a test artifact and has
never been uploaded anywhere. What has never been exercised is a real Google
OAuth client; see §5.

**Steps 4 and 8 are separate on purpose, and tested separately.** Signing in
with Google grants no access to anybody's AI subscription, and `03b` asserts
that directly: immediately after a successful sign-in the account list is empty
and no account is active. A build that quietly derived one from the other would
pass step 8 and be wrong about the product.

**Step 8 is asserted by observing which account served the request**, not by
reading the selector back. The negative half is also pinned: with the selected
account disconnected a task refuses rather than falling back to another one
(`multi-account.spec.ts :: a task refuses when the selected account is
disconnected, with no fallback`). A fallback would be the defect that makes
account selection meaningless, so its absence is measured rather than assumed.

---

## 5. Production behaviour that has **not** been verified

This is the honest limit of what the checks above establish. Each is blocked on
something the owner holds, and none is a known defect.

| Not verified                       | Why                                                    | Owner action                    |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------- |
| **Live Google OAuth**              | needs a deployed backend and a registered OAuth client | `OWNER-CHECKLIST.md` G-1 to G-5 |
| Live commercial AI providers       | needs paid vendor keys                                 | one API key                     |
| Connectors against real services   | needs a token from the owner's own account             | section D                       |
| Chrome Web Store policy compliance | not checked by any script here, by design              | the reviewer decides            |
| Store queue state                  | this repository cannot observe it                      | check the dashboard             |

The agent itself — tasks, browser interaction, provider routing, workflows,
skills, connectors — is exercised against local servers over real HTTP and in
real Chromium. What is unverified is other people's production endpoints, not
this build's behaviour against them.

---

## 6. Replacing a pending submission

**Everything in this section is subject to the actual dashboard state and to
the Chrome Web Store's current process, neither of which this repository can
see. Verify each point before acting on it.**

- Uploading a new package for an item that is pending review generally
  **replaces** what is in review and **restarts** the review from the
  beginning. A submission close to a verdict loses its queue position.
- Review duration is not predictable and is not something this repository can
  estimate.
- A rejection is not a penalty: it comes with a reason, and resubmitting after
  fixing it is ordinary.
- `0.1.0` is reusable while nothing is published. Once something is published,
  the next upload needs a higher version.

---

## 7. Owner decision checklist

Ten minutes, in this order.

1. **Open the dashboard.** Note the item's actual status — it may no longer be
   `Pending Review`.
2. **If it has been rejected**, read the reason. That reason is more
   informative than anything in this document, and it decides the next step.
3. **If it has been published**, stop and say so: several documents in this
   repository state that nothing is published, and they would all need
   correcting.
4. **If it is still pending**, decide on capability alone — there is no defect
   in it a reviewer can reach (§3). The question is whether the four
   connectors, the web-component support and the proved account routing (§4a)
   are worth restarting the review for.
5. **If you choose to replace it**, run `npm run release` yourself and upload
   `release/ai-browser-agent-0.1.0.zip`. Verify the digest with
   `cd release && sha256sum -c ai-browser-agent-0.1.0.zip.sha256` before
   uploading, and compare it against §1.
6. **Either way, record the digest you uploaded** somewhere you can check it —
   not in this repository, which cannot verify it, which is the whole reason §1
   has a gap in it.
7. **Do not** treat this document as the dashboard. It is one commit old the
   moment it is written.

---

## 8. What this document does not claim

- That the submitted artifact's digest is known. It is not.
- That the Store queue status is current. It is the owner's last report.
- That the candidate has been submitted, approved or published. None has
  happened.
- That live Google sign-in, live provider endpoints or live connectors have
  been exercised. None has.
