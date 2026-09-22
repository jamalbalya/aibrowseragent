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
| [store-listing.md](store-listing.md)                                                 | Name, both descriptions, eleven permission justifications, twelve disclosure answers     |
| [data-flows.md](data-flows.md)                                                       | Every data category: collected when, stored where, leaving to whom                       |
| [privacy-policy-outline.md](privacy-policy-outline.md)                               | What a hosted policy must say, from those flows                                          |
| [screenshot-plan.md](screenshot-plan.md)                                             | What to capture, and what must never appear in a published image                         |
| [../testing/acceptance/MATRIX.md](../testing/acceptance/MATRIX.md)                   | Every §85–§90 procedure, one classification each                                         |

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
byte-identical archives:

```text
2a648dc36c3a71ccdd68c8351aa527f6a57eeb77d2654af3e366dd82dc862236
2a648dc36c3a71ccdd68c8351aa527f6a57eeb77d2654af3e366dd82dc862236
```

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

## The current artifact

Produced from `dist/` after `npm run build:release`:

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| File             | `ai-browser-agent-0.1.0.zip`                                       |
| SHA-256          | `2a648dc36c3a71ccdd68c8351aa527f6a57eeb77d2654af3e366dd82dc862236` |
| Size             | 208,798 bytes compressed, 698,629 uncompressed                     |
| Entries          | 12                                                                 |
| Manifest version | 3                                                                  |

Twelve files, and no thirteenth:

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
- **No `<all_urls>`**, no host pattern hiding in `permissions`, and a CSP that
  allows neither `unsafe-eval` nor `unsafe-inline`.

What it deliberately does not check is Chrome Web Store policy. Policy is
published by Google, changes independently of this repository, and is not
verifiable from here. A script claiming to check it would be inventing a fact.

## What has and has not happened

- The artifact has been **built, validated and packaged**, and its digest
  recorded, twice, reproducibly.
- It has **not been uploaded** anywhere.
- It has **not been submitted** for review.
- It has **not been published**, and there is no public listing.
- No developer account exists for it, and none is claimed.

There is no state between "packaged locally" and "live on the store" that this
repository can reach on its own.
