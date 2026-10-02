# Release engineering

How the artifact that would be uploaded to the Chrome Web Store is produced,
what is checked about it, and what can be said about it truthfully.

Nothing here publishes anything. See
[chrome-web-store-submission-checklist.md](chrome-web-store-submission-checklist.md) for what is complete in this
repository and what only an account owner can do.

## The handoff documents

| Document                                                                             | For                                                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [OWNER-CHECKLIST.md](OWNER-CHECKLIST.md)                                             | The twenty-four steps from here to a public listing, marked repository-complete or yours |
| [chrome-web-store-submission-checklist.md](chrome-web-store-submission-checklist.md) | The same split, by topic rather than in order                                            |
| [store-listing.md](store-listing.md)                                                 | Name, both descriptions, twelve permission justifications, twelve disclosure answers     |
| [data-flows.md](data-flows.md)                                                       | Every data category: collected when, stored where, leaving to whom                       |
| [privacy-policy-outline.md](privacy-policy-outline.md)                               | What a hosted policy must say, from those flows                                          |
| [screenshot-plan.md](screenshot-plan.md)                                             | What to capture, and what must never appear in a published image                         |
| [../testing/acceptance/MATRIX.md](../testing/acceptance/MATRIX.md)                   | Every §85–§90 procedure, one classification each                                         |
| [BLOCKER-CERTIFICATION.md](BLOCKER-CERTIFICATION.md)                                 | What is genuinely blocked, what is a decision, and what was merely unclassified          |

## Producing the artifact

```bash
npm ci
npm run release          # build:release → validate → package, with the digest
```

That is three steps and each answers a different question:

| Step                   | Question it answers                            |
| ---------------------- | ---------------------------------------------- |
| `build:release`        | Is there a production build? (no source maps)  |
| `validate-package.mjs` | Would Chrome load this?                        |
| `validate-release.mjs` | Is this the artifact we intended to publish?   |
| `package-release.mjs`  | What exactly is in it, and what is its digest? |

They are separate because a package can load perfectly and still be wrong to
ship — carrying a source map that reveals the whole tree, a test fixture, an
absolute path from the build machine, or a version that disagrees with
`package.json`. None of those break loading.

## The artifact is reproducible, and that was measured

A recorded digest is only worth having if the same source produces the same
digest. Otherwise it identifies the build run rather than the code, which is
the opposite of what recording it is for.

Two clean builds of the same commit, each deleting `dist/` first, produced
byte-identical archives. Measured at commit `f7e09e6` (2026-09-22):

```text
2a648dc36c3a71ccdd68c8351aa527f6a57eeb77d2654af3e366dd82dc862236
2a648dc36c3a71ccdd68c8351aa527f6a57eeb77d2654af3e366dd82dc862236
```

**That digest is the measurement, not the current artifact.** The archive is a
function of the source, so every commit that changes `src/` or `public/`
produces a different one — which is the property being demonstrated, not a
defect in it. What the two lines establish is that repeating the build does
not change the bytes. For the digest of the artifact you are about to ship,
see [The artifact you are shipping](#the-artifact-you-are-shipping) below.

That did not happen by itself. An ordinary ZIP stores a modification time per
entry and takes whatever order the filesystem returned, so two builds of
identical source differ. `scripts/package-release.mjs` writes the archive
itself and pins three things: entry order is the sorted path, every timestamp
is a fixed 1980-01-01 (obviously not a build time, so nobody mistakes it for
one), and compression is raw deflate at a fixed level with no extra fields.

`npm run package:release -- --verify` re-packs and compares, so the pinning
cannot regress silently.

Writing the archive by hand also means no dependency was added to produce the
one file that reaches users. A packaging library is an odd place to accept
supply-chain risk.

### The one way a release build differs from a development build

Two differences, both narrowings, both deliberate:

|                                    | Development                                                        | Release                |
| ---------------------------------- | ------------------------------------------------------------------ | ---------------------- |
| Source maps                        | emitted                                                            | not emitted            |
| `web_accessible_resources` matches | `https://github.com/*`, `http://127.0.0.1/*`, `http://localhost/*` | `https://github.com/*` |

The loopback matches exist so the end-to-end suite's mock authorization server
— which runs on 127.0.0.1 — can perform the redirect a real authorization
server does. A shipped build does not need them, and leaving them in would let
any page served from loopback load an extension page and confirm the extension
is installed.

This does mean the artifact that ships is not byte-identical to the one the
end-to-end suite drove, which is worth knowing rather than glossing. The
difference is a strict narrowing of one manifest field, it is applied by the
build rather than by hand, `validate-release.mjs` fails if it did not happen,
and `release-claims.test.ts` asserts both halves. Everything else — every line
of executable code — is the same.

### The honest limit of that claim

Reproducible **on the same machine, with the same toolchain**. Measured with:

|                            |                                                                    |
| -------------------------- | ------------------------------------------------------------------ |
| Node                       | v22.22.2                                                           |
| npm                        | 10.9.7                                                             |
| `package-lock.json` sha256 | `d83cf2cf984369e1f0df144555cc2a8ebd24e1818183e891c21859bcedbc477e` |
| OS                         | Linux x64                                                          |

A different Node version, a different OS, or a re-resolved dependency tree may
produce different bytes, because `vite build` and its minifier are not
themselves promised to be reproducible across versions. Nothing here
establishes cross-machine reproducibility, and it is not claimed. What is
established is that this repository's own packaging contributes no variance,
so a digest mismatch points at the toolchain rather than at the packer.

## The artifact you are shipping

Produced from `dist/` after `npm run build:release`:

|                  |                                                  |
| ---------------- | ------------------------------------------------ |
| File             | `release/ai-browser-agent-0.1.0.zip`             |
| SHA-256          | read `release/ai-browser-agent-0.1.0.zip.sha256` |
| Size and entries | read `release/ai-browser-agent-0.1.0.zip.json`   |
| Manifest version | 3, enforced by `validate-package.mjs`            |

**No digest is written into this document any more, and that is the fix for a
defect this repository has had three times.** The digest is a function of the
source tree, so it changes with every commit that touches `src/` or `public/`.
Pinning it in prose means the prose is true only until the next commit, and
keeping it true means remembering to re-run the packager and hand-edit three
documents in step. That was tried: `4c1ed7b9…` was replaced by `8ac43891…`
(commit `f01ec29`, titled "Record the new release digest: the previous one no
longer builds"), which was replaced by `2a648dc3…`. It then went stale again
across twenty further commits, which is how it was found.

`scripts/package-release.mjs` already writes the answer twice, mechanically,
every time it runs:

```bash
npm run release
cd release && sha256sum -c ai-browser-agent-0.1.0.zip.sha256
# ai-browser-agent-0.1.0.zip: OK
```

`sha256sum -c` must run from inside `release/`, because the `.sha256` file
records a bare filename in the format the tool reads. `release/<name>.json`
carries the same digest, the byte count and every entry, for anything that
wants to read it rather than eyeball it.

The file list below is from the `f7e09e6` measurement and is kept because the
shape is the claim — twelve entries, and what each one is. The names carry
content hashes and the sizes move, so read `release/<name>.json` for the
build in front of you:

```text
assets/sidepanel-Dp7WyO9m.css      13,177
chunks/file-model-UVlDFDlT.js      25,728
content-script.js                  22,148
icons/icon-16.png                     122
icons/icon-32.png                     182
icons/icon-48.png                     242
icons/icon-128.png                    507
manifest.json                       1,388
oauth/callback.html                 1,222
service-worker.js                 365,942
sidepanel.js                      267,497
src/sidepanel/index.html              474
```

`release/<name>.json` records the same list mechanically, and
`release/<name>.sha256` is in the format `sha256sum -c` reads, so the digest
can be checked with a standard tool rather than by eye.

**Nothing in `release/` is committed**, and that is deliberate on two
counts. The `.zip` can be regenerated byte-for-byte, so committing a binary
adds repository weight and nothing else — regenerating it is precisely what
determinism buys. And a bare `.sha256` sitting in the tree would read as
authoritative for any build, which is exactly the claim the section above
declines to make: the digest is meaningful _with_ the toolchain it was
measured on, so it is recorded here, beside that toolchain, and nowhere
else.

## What is checked before the digest is taken

`validate-release.mjs`, all of it enforced rather than advised:

- **Nothing development-only ships** — no `.map`, `.ts`, `.tsx`, `.md` or
  `.log`; no path matching `tests/`, `fixtures/`, `e2e/`, `coverage/`,
  `node_modules/`, `.env` or `.git`.
- **No build-machine paths** — an absolute `/home/<user>/` or `C:\Users\` in
  any shipped text file is a failure. Harmless to Chrome; it leaks a directory
  layout and usually a username.
- **No credential-shaped values**, by issuer-prefixed pattern. Deliberately
  narrow: a broad "long token" rule fires on minified code and gets switched
  off within a week, which is worse than not having it.
- **No source map reference** left in any shipped file.
- **No remote script** in any HTML — a `<script src="https://…">` is remote
  code and is refused.
- **The version is single-sourced** — `package.json` and the manifest must
  agree, so a published build is identifiable by one number.
- **`web_accessible_resources` is narrowed to https origins.** The development
  manifest allows loopback so the end-to-end suite's mock authorization server
  can redirect to the OAuth callback; `build.mjs` removes those for a release
  and this is where that removal stops being a convention. An entry matching
  nothing, or matching every site, fails too.
- **No `<all_urls>`**, no host pattern hiding in `permissions` **or in
  `optional_permissions`**, and a CSP that allows neither `unsafe-eval` nor
  `unsafe-inline`. A host pattern in `optional_permissions` is the same
  escalation as one in `permissions`, reachable one dialog away rather than not
  at all.
- **The locked architectural prohibitions, on the manifest that actually
  ships** — no `externally_connectable`, no `nativeMessaging`, no
  `devtools_page`, no `chrome_url_overrides`. These are also asserted in
  `security-invariants.test.ts`, and that is a different artifact:
  `build.mjs` transforms the manifest on the way out — it is what strips the
  loopback `web_accessible_resources` entry described above — so a transform
  that _added_ one of these keys would pass every test in the repository and
  ship anyway. This file is the last thing between a build and a store, so it
  re-checks them on the bytes in the package.

What it deliberately does not check is Chrome Web Store policy. Policy is
published by Google, changes independently of this repository, and is not
verifiable from here. A script claiming to check it would be inventing a fact.

## What has and has not happened

A submission **has** been made. That is new, and it changes what this document
can claim — but less than it might appear, because it introduces a second
artifact and the two must not be confused.

- An artifact was **uploaded and submitted** for Chrome Web Store review by the
  account owner.
- Its **last known status is `Pending Review`**, as reported by the owner. This
  repository cannot observe the store, so that status is a report rather than a
  measurement, and it may have changed since it was written here.
- It has **not been approved** and it has **not been published**. There is no
  public listing, and nothing in this repository should be read as saying
  otherwise.
- The artifact a fresh `npm run release` produces today is a **different, later
  artifact**, and it has **not been uploaded**. See the section below.

### Two artifacts, and which one is which

|                                  |                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Submitted artifact**           | The archive the owner uploaded at submission time, built from the commit that was current then. It is the one under review. |
| **Current engineering artifact** | What `npm run release` builds from `HEAD` now. Reproducible, validated, and **not uploaded**.                               |

They are not the same bytes and will not be: the digest is a function of the
source tree, so every commit touching `src/` or `public/` produces a different
archive. Engineering has continued since the submission, so the current artifact
is ahead of the submitted one by definition.

Three facts about the submitted artifact live with the owner's Chrome Web Store
account and are deliberately **not** written here: the item id, the submission
date, and which digest was uploaded. This repository cannot verify any of them,
and recording an unverifiable value in prose is how the digest in this very
document went stale three times (see below). If a later submission needs them
pinned, pin them where they can be checked — not here.

What has not changed is the shape of the boundary: there is still no state
between "packaged locally" and "live on the store" that this repository can
reach, observe or advance on its own.

### Is the current artifact ready for a new submission?

> The facts for that one decision are collected in
> [SUBMISSION-CANDIDATE.md](SUBMISSION-CANDIDATE.md), including what is **not**
> known about the submitted artifact and a ten-minute checklist for the
> dashboard. This section is the summary; that file is the detail.

**Technically yes, and the decision is not this repository's to make.** The
current artifact is reproducible, deterministic over repeated packing,
validated, and built from a tree where every gate passes. Its permission set
and host access are byte-identical to the submitted one — no permission has
been added since, which is the thing a reviewer looks at hardest.

What has changed since the submission is capability and correctness, not
posture: three connectors a user can actually connect, controls inside web
components now visible and clickable, a defect fixed that stopped every task
once somebody signed in with Google, and the account-selection routing proved
rather than assumed.

Two things to weigh before replacing a submission that is in review, and both
are judgement rather than fact:

- **Replacing an item under review restarts the review.** If the pending one is
  close to a verdict, waiting costs nothing and resubmitting costs the queue
  position.
- **Capability.** The current artifact can do things the pending one cannot:
  three connectors a user can connect, controls inside web components, and the
  account-selection routing proved rather than assumed.

Nothing here submits, replaces or withdraws anything, and the call is the
owner's because only the owner can see the queue.

### A correction: the pending artifact does **not** have the sign-in defect

An earlier revision of this section said it did, and told the owner that _"a
reviewer who signs in with Google and then runs a task will find it refused"_.
That was wrong, and it was the stronger of the two arguments for replacing the
submission — so the correction matters more than the original claim did.

The defect needed a **completed** sign-in. The conflict was between a local
installation id and a **profile** id, and the profile is written only by
`recordSignIn`, which `signInWithGoogle` and `verifyEmailSignIn` both refuse to
reach when no backend origin is compiled in. The shipped build has none: the
origin is inlined by Vite at build time, there is no default, and nothing can
set one at run time. So no profile is ever written, the two ids never disagree,
and the conflict never fires.

**Measured rather than reasoned.** `auth-google.spec.ts :: the sign-in
ownership conflict is unreachable in the shipped build` drives the shipped
`dist` in real Chromium: both sign-in paths answer `NOT_CONFIGURED`, no profile
key exists in storage, the health record does not say `RECOVERY_REQUIRED`, and
`task.create` is not `POLICY_BLOCKED`. That same case was then run against a
build with the **old, defective** resolution restored and a shipped
configuration — and it still passed, which is what establishes unreachability
rather than merely "fixed".

It was reachable in exactly one build: `dist-auth`, the fixture with an origin
inlined for `auth-google-protocol.spec.ts`. That is a test artifact and has
never been uploaded anywhere.

What this changes for the decision: replacing the pending submission is now a
question about **capability and queue position only**. There is no defect in it
that a reviewer can reach, so there is no correctness argument for restarting a
review that may be close to a verdict.
