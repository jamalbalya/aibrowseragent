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

### Reproducible from the commit, not only from the same `dist/`

The two builds above delete `dist/` and rebuild in the same working tree, which
proves the **packer** adds no variance. It does not prove the **commit**
reproduces, because a working tree holds things a clone does not: a resolved
`node_modules`, build caches, and — on a development machine — an untracked
`.env`. `check-extension-env.mjs` reads that file, so "does the build depend on
it?" was an open question answered only by reasoning.

Re-measured on 4 October 2026 for `0.2.0`, at commit `b41f87d`, on Node
22.23.3 — this time by cloning **from the remote** rather than from the local
directory, so the clone carries only what was actually pushed:

```sh
git clone --depth 1 --branch main https://github.com/jamalbalya/aibrowseragent.git repro
cd repro
npm ci            # a fresh dependency tree, from package-lock.json
npm run release
```

```text
working tree : 1750528e7571776cd1e3bdbd55cd86cf70be2e3e9f431d532f6c8f7c364dcda9
clean clone  : 1750528e7571776cd1e3bdbd55cd86cf70be2e3e9f431d532f6c8f7c364dcda9
```

Byte-identical, **291,862 bytes, 13 entries**, `ai-browser-agent-0.2.0.zip`.

The previous measurement, at commit `efff272` for `0.1.0`, produced
`b09109896dc65a33fb8d7a5c065df7281b4de786e6014b115190f69f4195541a` at 291,869
bytes — seven bytes larger.

**A smaller archive is expected here, and the exact figure is deliberately not
explained further.** Two source files differ between those commits:
`public/manifest.json`, where the version string changed and kept its length,
and `src/providers/oauth/provider-auth-config.ts`, where a dead export was
removed. That second one is known not to affect the bytes: when it was removed,
the artifact still hashed to `b0991098…`, which is what established the export
was genuinely dead. What does shorten the package is the release build dropping
`identity` from `optional_permissions` — the manifest inside the archive is
1,402 bytes against the published one's 1,468.

So the direction is accounted for. The precise seven is a deflate outcome over
a changed manifest, and attributing it exactly would be arithmetic nobody
checked — an earlier draft of this paragraph claimed the difference was fully
accounted for and that no `src/` file had changed, and both halves were wrong. Two things follow, and the second is
the one worth having:

- The archive is a function of the **commit** on this toolchain, not of the
  working tree it was built in.
- **The build does not depend on the developer's `.env`.** The clone has none —
  only the two tracked `.example` files — and produced the same bytes. That
  closes from the second direction what `validate-release.mjs` closes from the
  first: it checks that no `.env` value appears _in_ the artifact, and this
  checks that the artifact does not change when the file is absent.

Run it before a submission if the digest matters to you. It costs an `npm ci`.

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

A submission **has** been made and the published listing has since moved to
version `0.2.0`. The current tree builds `0.2.1`, which is a separate artifact
and must not be confused with what is currently published.

- An artifact was uploaded and submitted for Chrome Web Store review by the
  account owner, **completed review, and `0.2.0` is published**.
- The listing is live at
  <https://chromewebstore.google.com/detail/hlhcfmlgoojeoapmijopmicdmmhealhl>,
  showing version `0.2.0`. The item id was supplied by the account owner and the
  listing was read directly, so the published version is verified.
- The artifact a fresh `npm run release` produces today is a **different, later
  artifact**: `0.2.1`. It has **not been uploaded, submitted or published**.
- **`0.2.0` is the published version. `0.2.1` is prepared and has not been
  uploaded, submitted or published.**

### The `0.2.1` manifest differs from the published one in exactly one field

Measured by unpacking the published package and comparing its `manifest.json`
with what the release build produces:

| Field                      | Published `0.2.0` | Release `0.2.1` |
| -------------------------- | ------------------ | ---------------- |
| `version`                  | `0.2.0`            | **`0.2.1`**      |
| `permissions` (10)         | identical           | identical        |
| `host_permissions`         | identical           | identical        |
| `optional_permissions`     | `["downloads"]`     | `["downloads"]`  |
| `web_accessible_resources` | `https://github.com/*` | `https://github.com/*` |

The release build keeps the same permission surface while changing only the
version and the source changes represented by the new artifact.

### Two artifacts, and which one is which

|                                  |                                                                 |
| -------------------------------- | --------------------------------------------------------------- |
| **Published artifact**           | `0.2.0`, live on the store.                                      |
| **Current engineering artifact** | `0.2.1`, what `npm run release` builds from `HEAD`; **not uploaded**. |

They are not the same bytes: the current engineering artifact contains the
Jira/Confluence connector UI fix and has a different version.

Three facts about the submitted artifact live with the owner's Chrome Web Store
account and are deliberately **not** written here: the submission date, the
uploaded archive digest, and other account-side review metadata. This repository
cannot verify those account-side details.
