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

|                 | Previously submitted                              | Current candidate                                                   |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| Version         | `0.1.0`                                           | `0.1.0`                                                             |
| SHA-256         | **not recorded — see below**                      | `6ff19db1f83f132139c9d542ea8a21a0c5e4c74a0a1a507752001c7f8c3c59bf`  |
| Bytes           | not recorded                                      | 290,175                                                             |
| Entries         | not recorded                                      | 13                                                                  |
| Source commit   | not recorded                                      | the commit this file was committed in                               |
| Submission date | not recorded; reported as on or before 2026-10-01 | not submitted                                                       |
| Store status    | reported `Pending Review`, owner-reported         | not submitted                                                       |
| Google OAuth    | not applicable — the feature did not exist        | **no client id compiled in**; the option reports itself unavailable |

**Two builds can now share this version, this digest-less table and this
permission set and still behave differently**, because a Google OAuth client id
is compiled in or it is not. So `npm run release` prints which, read from the
built bundle rather than from the environment:
`google oauth: no client id — the panel reports the Google option unavailable,
with a reason`. That is the line to check before uploading anything.

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

Unchanged between the submitted artifact and this candidate, with one
exception called out beneath the table:

|                          |                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Permissions              | `sidePanel`, `storage`, `unlimitedStorage`, `tabs`, `tabGroups`, `scripting`, `debugger`, `notifications`, `activeTab`, `alarms` |
| Optional permissions     | `downloads`, **and `identity` — see below**                                                                                      |
| Host access              | `http://*/*`, `https://*/*` — **not** `<all_urls>`                                                                               |
| Content scripts          | `all_frames: false`                                                                                                              |
| CSP                      | `script-src 'self'; object-src 'self'`                                                                                           |
| Web-accessible resources | `oauth/callback.html`, to `https://github.com/*` only                                                                            |
| Remote code              | none                                                                                                                             |

**One optional permission has been added, and this is the only row in this
table that changed.** `identity` is now listed under `optional_permissions`.
A reviewer scrutinises the permission set hardest, so what it means is stated
precisely rather than summarised:

- It is **not granted at install.** Chrome asks for it only when the user
  presses _Connect with Google_ to authorize a Google account for the Gemini
  API, and it can be declined and revoked. A user who connects every provider
  with a pasted key never grants it.
- It is needed because Google registers exactly one redirect for a Chrome
  Extension OAuth client, `https://<id>.chromiumapp.org/`, which only
  `chrome.identity.launchWebAuthFlow` can receive. `chrome-extension://` is not
  an accepted Google redirect, and the loopback alternative belongs to desktop
  clients, which Google pairs with a client secret this extension must not hold.
- The capability it would otherwise unlock — `getAuthToken`, which can mint a
  token for the **browser profile's own** Google account — stays shut, because
  that method reads its client id from the manifest's `oauth2` key and this
  manifest declares none. Measured in real Chromium:
  `tests/e2e/google-provider-auth.spec.ts :: identity is not granted until
asked for, and getAuthToken cannot work` grants nothing, calls it, and
  asserts no token comes out.
- **This build cannot complete that flow at all**, because it carries no Google
  OAuth client id. The panel reports the method unavailable with a reason and
  offers the Gemini API key path instead.

No **required** permission has been added, and no host access has changed.
`docs/account-integration.md` is the full account of what a Google connection
does and does not do.

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
| Unit / integration / security | 4,519 passed, 34 skipped, 185 files                                                                 |
| Real-Chromium E2E             | 525 passed, in 9.4 minutes, against this tree                                                       |
| `npm audit --omit=dev`        | 0 vulnerabilities                                                                                   |
| Reproducibility               | deterministic over repeated packing, digest verified with `sha256sum -c`                            |
| Parity                        | 36 PASS / 3 PARTIAL / 1 NOT-STARTED across 40 capabilities                                          |
| Acceptance                    | 12 documents, 342 citations, all resolving                                                          |
| Artifact scan                 | no `eval`, no `new Function`, no `Runtime.evaluate`, no remote script source, no key-shaped strings |
| Build configuration           | checked by the build itself; a value set and unusable fails it rather than being ignored            |
| Secret scan                   | clean over 257 tracked files                                                                        |

---

## 4a. The core journey, step by step

**The product requirement was clarified, and this section was rewritten to
match it.** The earlier version opened with _"sign in for product identity,
connect an AI provider account separately"_ and listed the Google sign-in as
step 3 of the core journey. That is not the requirement: a product sign-in is
optional, is not part of connecting an AI account, and must not gate exploring
or using the extension. Google's role is to **authorize an AI account** where a
vendor genuinely supports it — which is Google's own Gemini API and no other
provider.

So the journey below has no sign-in step. Each step names the measurement that
covers it in the shipped build, so a reader can check a step rather than take a
verdict. Every citation is a real-Chromium case unless it says otherwise.

| #   | Step                                       | Shipped build                                                            | Measured by                                                                                                  |
| --- | ------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 1   | Install, and the panel opens beside a page | works                                                                    | `extension-load.spec.ts :: the side panel mounts and reports no provider before one is configured`           |
| 2   | First launch offers work, not a sign-up    | works                                                                    | `standalone-ux.spec.ts :: first launch offers work, not a sign-up`                                           |
| 3   | Explore before connecting anything         | works, and asks for nothing                                              | `standalone-ux.spec.ts :: nothing on the normal path asks the user to sign in`                               |
| 4   | Connect an AI provider account             | works                                                                    | `provider-connection.spec.ts :: connecting an account through Settings leaves something that can run a task` |
| 5   | A connection that was never checked        | usable, and marked unverified rather than assumed                        | `provider-connection.spec.ts :: an account connected but never checked is still the one a task uses`         |
| 6   | Hold two accounts at once                  | works, with separate credentials                                         | `multi-account.spec.ts :: two accounts on one endpoint coexist with separate credentials`                    |
| 7   | Choose which account is active             | works, and survives a worker restart                                     | `multi-account.spec.ts :: accounts and the brain survive in real storage across a restart`                   |
| 8   | **The chosen one is the one that runs**    | works                                                                    | `multi-account.spec.ts :: the selected account is the one that actually serves the agent’s request`          |
| 9   | Run a browser task                         | works                                                                    | `agent-task.spec.ts :: reads a real page and reports a summary with evidence`                                |
| 10  | Connect a connector and use it             | four exist; a real token is owner-held                                   | `connector.spec.ts` (25 cases); live use is §5 below                                                         |
| 11  | See what was done                          | works                                                                    | `audit.spec.ts :: a genuine browser action leaves a record in the trail`                                     |
| 12  | All of it with no backend at all           | works                                                                    | `local-first.spec.ts :: workflows, shortcuts and workspaces all work with no backend at all`                 |
| 13  | **None of it needs a product sign-in**     | works, signed out from start to finish                                   | `google-provider-auth.spec.ts :: the whole journey runs with no product sign-in at any point`                |
| 14  | Authorize a Google account for Gemini      | **unavailable in this build** — no Google OAuth client id is compiled in | `google-provider-auth.spec.ts :: connecting a Google account is refused honestly in this build`              |

Three things this review establishes that are worth stating plainly.

**Step 14 is the only step the shipped build does not perform, and it is
unavailable with a reason rather than half-working.** The panel says the build
carries no Google OAuth client id and points at the Gemini API key path, which
does work. Registering a client is owner step G-6; the protocol itself — PKCE,
the callback checks, the scope refusal, the renewal — is driven by 41 unit cases
and 15 integration cases, with 25 of 25 mutations killed.

**Step 13 is the clarified requirement, and it is measured as one run**: signed
out, explore, connect, discover, select, verify, run a task, assert the request
carried that account's credential, switch, assert again, disconnect — with
`auth.status` asserted signed-out at the start and the end.

**The product sign-in is still absent from this build, and that is now beside
the point rather than a gap in the journey.** The panel reports the configured state instead of
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
6. **Before uploading anything, republish the privacy policy** and **decide one
   form answer.**

   The hosted policy at <https://about.jamal-balya.workers.dev/en/privacy> was
   read on 2026-10-03 and does not mention the optional `identity` permission,
   the Google authorization, or the Cloud project a Google-authorized request
   names. It is produced by a different repository and nothing here can change
   it; the exact procedure, including how to verify the deploy landed, is in
   [`privacy-policy-outline.md`](privacy-policy-outline.md).

   And in the dashboard's data-use form, **"Collects authentication
   information" is currently answered "No"** and has never been reasoned about.
   The extension stores an API key, or a Google access and refresh token, and
   sends each only to the service it belongs to. `store-listing.md` sets out
   Chrome's definition and the two defensible readings; the answer is the
   owner's, and the policy and the form must agree because a mismatch between
   them is a common rejection.

7. **Either way, record the digest you uploaded** somewhere you can check it —
   not in this repository, which cannot verify it, which is the whole reason §1
   has a gap in it.
8. **Do not** treat this document as the dashboard. It is one commit old the
   moment it is written.

---

## 7b. The ordered path to a public release

Everything above is about one decision. This is the whole remaining sequence,
because "what is left" had been spread across four documents and the honest
answer to _"why isn't it live?"_ is a short list rather than a status.

**Nothing in this repository can perform any of steps 1 to 4.** Each needs an
account, a payment, a legal agreement or a credential that only the publisher
holds.

| #   | Owner action                                        | Why it is required                                                                                                                                                                    | Where                                          | Evidence it is done                                                                                                                                 | Unblocks                                               |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | ~~Republish the privacy policy~~ — **DONE**         | The hosted text predated the optional `identity` permission and the Cloud project a Google-authorized request names                                                                   | `jamalbalya/about-jamal`                       | **Done:** live, effective 2026-10-03, and read against the implementation claim by claim on that date — the table is in `OWNER-CHECKLIST.md` item 5 | —                                                      |
| 2   | **Answer "Collects authentication information"**    | The form and the policy must agree; a mismatch is a common rejection. Both readings are set out in `store-listing.md` and the answer is a judgement, not a fact about the code        | Decide, then record it                         | The answer written down beside the other eleven                                                                                                     | Step 4                                                 |
| 3   | **Supply the four unanswered listing fields**       | The dashboard will not accept a submission without them: category, language, support email, support URL. The support email must match the policy's contact address                    | `chrome-web-store-submission-checklist.md` §3b | The four filled in                                                                                                                                  | Step 4                                                 |
| 4   | **Register, pay, agree, upload**                    | A developer account, the one-time fee, and a person who can accept the Developer Agreement. Then the artifact                                                                         | Chrome Web Store dashboard                     | The dashboard reports the digest in §1                                                                                                              | Review                                                 |
| 5   | **Run the five browser-only acceptance procedures** | They need only a person, a browser and one API key, and they produce the listing screenshots in the same sitting                                                                      | `docs/testing/acceptance/RESULTS.md`           | Results recorded, screenshots captured                                                                                                              | A listing with real screenshots                        |
| 6   | **Rotate the temporary 9Router key**                | It was used during development and must be treated as exposed. The file is gitignored, absent from the artifact and present on disk — deleting it is necessary and **not** sufficient | The 9Router provider                           | A new key issued and the old one revoked                                                                                                            | Nothing in the release; it is a standing security item |
| 7   | **G-6, then its step 4.4**                          | The last unverified Gemini OAuth behaviour: whether a validly issued token with a quota project is accepted for `generateContent`                                                     | Google Cloud console, then the extension       | One task completing, per G-6 step 4.4's evidence list                                                                                               | Moving that row from unverified to confirmed           |

**Step 1 is done.** Steps 2 and 3 are what now make step 4 possible, and
neither takes long. Steps 5 to 7 improve the submission and the record; they do
not block it.

**The project is not finished and will not be until step 4 has happened, review
has concluded and the listing is live.** No step above has been performed, and
nothing in this repository has touched the Chrome Web Store.

---

## 8. What this document does not claim

- That the submitted artifact's digest is known. It is not.
- That the Store queue status is current. It is the owner's last report.
- That the candidate has been submitted, approved or published. None has
  happened.
- That live Google sign-in, live provider endpoints or live connectors have
  been exercised. None has.
