# Release engineering

How the artifact that would be uploaded to the Chrome Web Store is produced,
what is checked about it, and what can be said about it truthfully.

Nothing here publishes anything. See
[chrome-web-store.md](chrome-web-store.md) for what is complete in this
repository and what only an account owner can do.

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
df4d80df7b2347bb67d8d50c74d9abf07eab5196bb264b788dabca18334a68b4
df4d80df7b2347bb67d8d50c74d9abf07eab5196bb264b788dabca18334a68b4
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
| SHA-256          | `df4d80df7b2347bb67d8d50c74d9abf07eab5196bb264b788dabca18334a68b4` |
| Size             | 208,452 bytes compressed, 697,747 uncompressed                     |
| Entries          | 12                                                                 |
| Manifest version | 3                                                                  |

Twelve files, and no thirteenth:

```text
assets/sidepanel-Dp7WyO9m.css      13,177
chunks/file-model-UVlDFDlT.js      25,728
content-script.js                  21,437
icons/icon-16.png                     122
icons/icon-32.png                     182
icons/icon-48.png                     242
icons/icon-128.png                    507
manifest.json                       1,462
oauth/callback.html                 1,222
service-worker.js                 365,697
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
