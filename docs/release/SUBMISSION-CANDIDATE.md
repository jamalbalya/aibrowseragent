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
| SHA-256         | **not recorded — see below**                      | `098520e83f19edc34511cba5f23ae118820e79d129415e969cf58cfe45537e59` |
| Bytes           | not recorded                                      | 281,405                                                            |
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
| Unit / integration / security | 4,345 passed, 34 skipped, 177 files                                                                 |
| Real-Chromium E2E             | see the commit message for the count run against this tree                                          |
| `npm audit --omit=dev`        | 0 vulnerabilities                                                                                   |
| Reproducibility               | deterministic over repeated packing, digest verified with `sha256sum -c`                            |
| Parity                        | 36 PASS / 3 PARTIAL / 1 NOT-STARTED across 40 capabilities                                          |
| Acceptance                    | 12 documents, 342 citations, all resolving                                                          |
| Artifact scan                 | no `eval`, no `new Function`, no `Runtime.evaluate`, no remote script source, no key-shaped strings |

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
   in it a reviewer can reach (§3). The question is whether the three
   connectors, the web-component support and the proved account routing are
   worth restarting the review for.
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
