# Chrome Web Store submission checklist

Split into two halves that must not be confused:

- **REPOSITORY COMPLETE** — done, in this repository, checkable by anyone who
  clones it.
- **ACCOUNT OWNER ACTION REQUIRED** — cannot be done from a repository at all.
  It needs a Google account, a payment, an accepted legal agreement, or a
  human at a dashboard.

Nothing in the second half is fabricated, approximated, or marked done on the
strength of the first half being done.

> **A submission has been made. Its last known status is `Pending Review`.**
>
> The extension is **not approved and not published**: there is no public
> listing, and no statement anywhere in this repository should be read as
> saying otherwise. The status above is what the account owner reported — this
> repository cannot observe the store, so it is a report rather than a
> measurement and may be out of date.
>
> **The artifact under review is not the artifact this repository builds
> today.** It is the archive the owner uploaded at submission time. Engineering
> has continued since, so a fresh `npm run release` produces a different, later
> archive that has **not** been uploaded. See
> [README.md](README.md#two-artifacts-and-which-one-is-which).
>
> The checklist below is kept as it was written: a **pre-submission** checklist,
> describing what had to be true before anything could be uploaded. It is
> history, not a live status board, and the first submission is evidence that
> its "REPOSITORY COMPLETE" half was in fact complete. The
> "ACCOUNT OWNER ACTION REQUIRED" half below is left in its original wording
> for the same reason — it records what the repository could never do, which is
> still true of the next submission.

---

## REPOSITORY COMPLETE

### The package

|                             | Status                                                                   |
| --------------------------- | ------------------------------------------------------------------------ |
| Manifest V3                 | `manifest_version: 3`, verified by `validate-package.mjs`                |
| Version single-sourced      | `package.json` and manifest must agree or the build fails                |
| Production build            | `npm run build:release`; no source maps emitted                          |
| No development artefacts    | enforced: no `.map`, `.ts`, `.md`, `tests/`, `fixtures/`                 |
| No remote code              | no `<script src="http…">`; CSP forbids `unsafe-eval` and `unsafe-inline` |
| No credential-shaped values | scanned by issuer-prefixed pattern                                       |
| No build-machine paths      | scanned                                                                  |
| Icons                       | 16, 32, 48 and 128 px, each verified a real PNG at its declared size     |
| Deterministic archive       | two clean builds → identical SHA-256                                     |
| Digest recorded             | in [README.md](README.md), beside the toolchain it was measured on       |

### Permissions, and the justification each one needs

Store review asks for a justification per permission, and the narrow ones are
easy. These are the answers this repository can give from its own code:

| Permission                                  | Justification                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel`                                 | The entire user interface is the side panel                                                                                                       |
| `storage`, `unlimitedStorage`               | Tasks, audit trail and settings persist locally; MV3 evicts the worker, so in-memory state is not an option                                       |
| `tabs`, `tabGroups`                         | The agent acts on tabs the user names and groups results                                                                                          |
| `scripting`                                 | Injects the content script that reads the page model                                                                                              |
| `debugger`                                  | Reads console and network for the diagnosis capability (§85 C)                                                                                    |
| `notifications`                             | Tells the user a task needs them when the panel is closed                                                                                         |
| `activeTab`                                 | The access path that still works when a user restricts site access to "on click" — not redundant with host permissions for that reason            |
| `alarms`                                    | Wakes the service worker when a scheduled task is due; one alarm for all schedules, and MV3 offers no other way to run something at a chosen time |
| `host_permissions: http://*/*, https://*/*` | The agent works on whatever page the user asks about                                                                                              |
| `optional_permissions: downloads`           | Requested only when a download is attempted, granted under the user's own gesture                                                                 |

Two of these will attract reviewer attention, and it is better to know which
before a reviewer raises them:

**`debugger`** is the most heavily scrutinised permission in the catalogue,
because it can execute arbitrary code in a page. This extension's answer is
that it cannot, here: the CDP surface is a fixed allowlist holding no
evaluator, and no tool accepts a method name as an argument. That is asserted
as a standing invariant, not a convention —
`tests/security/security-invariants.test.ts` fails if `Runtime.evaluate` ever
appears in the allowlist, and `tests/security/debugger-allowlist.test.ts`
covers the surface. If review asks, that is the specific, checkable answer.

**Broad host permissions.** `http://*/*` and `https://*/*` are broad, and the
honest framing is that a browser agent the user points at arbitrary pages
needs them. What can be said alongside: `<all_urls>` is deliberately _not_
requested — it would add `file://` and `chrome-extension://` — and
`all_frames` is `false`, so the content script never enters a cross-origin
frame. Both are enforced as standing invariants so they cannot be widened
quietly.

### Single purpose

The store requires a single purpose. This one's is: _let a user give a browsing
task, in natural language, to an AI model of their own choosing, and have the
extension carry it out in their browser under their supervision._ The
provider-agnostic design serves that purpose rather than adding a second one —
the user supplies the model; the extension supplies the browser capabilities
and the safety controls.

### Privacy disclosures

[`docs/PRIVACY.md`](../PRIVACY.md) is written against what the code does,
mechanism by mechanism. The facts a store data-disclosure form asks for:

| Question                                                        | Answer from the code                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Is data sold?                                                   | No                                                                                                                         |
| Is data used for anything other than the user's stated purpose? | No                                                                                                                         |
| Is data transferred to third parties?                           | Only to the AI provider the user chose and configured, and to a connector the user connected                               |
| Is authentication data collected?                               | No. No `cookies` permission; password fields are never read                                                                |
| Is personal communication read?                                 | Only page content of a page the user asked the agent to work on                                                            |
| Is location collected?                                          | No                                                                                                                         |
| Is browsing history collected?                                  | No. No `history` permission                                                                                                |
| Where is data stored?                                           | Locally, in extension storage. Credentials for connectors are in session storage, which does not survive a browser restart |

`docs/PRIVACY.md` states explicitly that it asserts no compliance with any
store policy, which remains true and should stay that way: policy is published
by Google and changes independently of this repository.

---

## ACCOUNT OWNER ACTION REQUIRED

None of this can be done from a repository. Each item names why.

### 1. Developer account

- Register at the Chrome Web Store Developer Dashboard with a Google account.
- Pay the one-time registration fee (**US$5** at the time of writing; verify
  the current amount, it is not this repository's to assert).
- Accept the Developer Agreement and the Developer Program Policies.

_Why not here:_ it requires a Google identity, a payment method, and an
acceptance of legal terms by a person who can bind themselves to them. No part
of that can be produced by code, and fabricating any of it would be fraud
rather than automation.

### 2. Privacy policy at a public URL

The store requires a **hosted** privacy policy the listing can link to, and
there now is one:

```text
https://about.jamal-balya.workers.dev/en/privacy
```

Verified reachable over HTTPS on 2026-09-29: `200`, no redirect, served as
`text/html`, titled "Privacy Policy — AI Browser Agent · Jamal Balya". It
names the publisher and carries a contact address. Paste that URL into the
dashboard's privacy policy field exactly as written above.

`docs/PRIVACY.md` remains the repository's own account of the same behaviour.
The hosted page is what the listing links to; if one changes, change both.

### 3. Listing assets

| Asset                     | Required                               | Status                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item name                 | Yes                                    | **Repository complete** — `AI Browser Agent`, from the manifest                                                                                                                                                                                                                                                                                            |
| Short description         | Yes, ≤132 chars                        | **Repository complete** — 108 characters, in [store-listing.md](store-listing.md)                                                                                                                                                                                                                                                                          |
| Detailed description      | Yes                                    | **Repository complete** — drafted in [store-listing.md](store-listing.md), ready to paste                                                                                                                                                                                                                                                                  |
| Permission justifications | Yes, one per permission                | **Repository complete** — twelve, in [store-listing.md](store-listing.md)                                                                                                                                                                                                                                                                                  |
| Data disclosure answers   | Yes                                    | **Repository complete** — twelve, in [store-listing.md](store-listing.md); audit in [data-flows.md](data-flows.md)                                                                                                                                                                                                                                         |
| Icon 128×128              | Yes                                    | Present and **enforced**: `validate-package.mjs` reads each declared icon's PNG header and fails the build if it is unreadable or not the size it is declared under. It previously checked only that the file existed, so a key pointing at the wrong file — `"128": "icons/icon-16.png"` is one transposition away — would have surfaced at the dashboard |
| Icons 16, 32, 48          | For the toolbar                        | Present, and checked by the same rule                                                                                                                                                                                                                                                                                                                      |
| Screenshots               | Yes, at least one, 1280×800 or 640×400 | **Not produced — account owner**                                                                                                                                                                                                                                                                                                                           |
| Small promo tile 440×280  | Optional                               | Not produced                                                                                                                                                                                                                                                                                                                                               |
| Category                  | Yes                                    | Not chosen — a judgement about audience, not about code                                                                                                                                                                                                                                                                                                    |
| Language                  | Yes                                    | Not chosen                                                                                                                                                                                                                                                                                                                                                 |

The listing _copy_ is written and repository-complete: name, both
descriptions, every permission justification and every data-disclosure answer
are drafted in [store-listing.md](store-listing.md) against what the code
actually does.

_One judgement about the icons, which is the owner's:_ all four are valid and
correctly sized, and each is a flat two-tone glyph — three distinct pixel
values across the 128×128. Chrome sets no minimum complexity and nothing here
is a defect, so this is not a blocker; it is worth a look before submitting,
because the 128×128 is the store icon a person sees next to the listing. The
repository will not invent branding.

_Why the screenshots are not here:_ a screenshot of this extension doing
something real needs a configured provider, which needs an API key this
repository does not hold and will not invent. A screenshot of the panel doing
nothing would be a listing asset that misrepresents the product, which is
worse than having none — and a fabricated one showing a capability nobody has
manually verified would be worse still. Five of the fifteen manual acceptance
procedures need only a person and a browser; running those produces both the
verification and the screenshots in one sitting.

### 3b. The listing fields nobody has answered yet

**These are not written anywhere else, and the dashboard will not accept a
submission without them.** They were missing from this checklist, which meant
discovering them at upload time with the artifact already built.

Four of them are judgements about audience, contact and support that only the
publisher can make. None is a question about the code, and none can be
pre-filled here without inventing a commitment somebody then has to keep.

| Dashboard field               | What it needs                                                                                        | Already decided?                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Category**                  | `Workflow & Planning` or `Developer Tools`                                                           | **No** — [store-listing.md](store-listing.md) deliberately leaves it: it affects discovery, which is a judgement about audience rather than about the code                                             |
| **Language**                  | The listing's primary language                                                                       | **No**. The listing copy is English                                                                                                                                                                    |
| **Support email**             | An address that reaches you, and that Chrome will verify                                             | **No**. The privacy policy's section 9 already promises _"a contact address that works. Review will check it"_, so this and the policy must name the same one                                          |
| **Support / homepage URL**    | A page about the extension. Optional in the dashboard, and a listing with neither reads as abandoned | **No**                                                                                                                                                                                                 |
| **Privacy policy URL**        | <https://about.jamal-balya.workers.dev/en/privacy>                                                   | **Yes** — and it needs republishing first; see owner checklist item 5                                                                                                                                  |
| **Single purpose**            | One sentence                                                                                         | **Yes** — in [store-listing.md](store-listing.md), written to be pasted                                                                                                                                |
| **Permission justifications** | One per permission                                                                                   | **Yes** — twelve in [store-listing.md](store-listing.md), including the optional `identity`                                                                                                            |
| **Data-use form**             | Twelve answers                                                                                       | **Eleven yes, one open** — "Collects authentication information" is a judgement with two defensible readings, set out in [store-listing.md](store-listing.md). It must agree with the published policy |

**The support email and the privacy policy's contact address have to match.**
A reviewer who finds two different addresses has found an inconsistency in a
legal document, and that is a question rather than a rejection — but it is a
question that costs a review cycle.

### 4. The upload itself

- Upload `release/ai-browser-agent-0.1.0.zip`.
- Verify the dashboard reports the SHA-256 that
  `release/ai-browser-agent-0.1.0.zip.sha256` records for the build you are
  uploading. Confirm that file first, from inside `release/`:
  `cd release && sha256sum -c ai-browser-agent-0.1.0.zip.sha256`, which prints
  `ai-browser-agent-0.1.0.zip: OK`. No digest is pinned in this checklist on
  purpose — it is a function of the source and changes at every commit that
  touches `src/` or `public/`.
- Complete the permission justifications — the twelve in
  [store-listing.md](store-listing.md) are written to be pasted.
- Complete the data-disclosure form. **Answer yes to "collects website
  content"**: page content is website content, it is transmitted to the
  provider the user chose, and saying otherwise because it is transient would
  be false.
- Paste the detailed description from [store-listing.md](store-listing.md).
- Submit for review.

_Why not here:_ uploading requires the account from item 1.

### 5. After review

- Review takes an unpredictable time; the store publishes no guaranteed SLA.
- A rejection names a policy clause. Fix it in the repository, rebuild,
  re-record the digest, and resubmit — the digest changing is expected and is
  how the two builds are told apart.
- **Only once the listing is live** may anything in this repository describe
  the extension as published, and then only with the item id and the public
  URL recorded. `tests/security/release-claims.test.ts` fails the build if a
  document claims availability, so that claim becomes a deliberate edit to a
  test rather than a sentence someone wrote optimistically.

---

### 6. Dashboard declarations

The dashboard asks these separately from the listing copy, and none of them is
answerable from a repository: each is a statement the publisher makes, not a
property of the code. What the repository can state as fact is in the middle
column; the answer is still yours.

| Declaration           | What this repository can state as fact                                                                                                                        | Owner |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Ads                   | No advertising code, no ad network and no ad identifier exists in the artifact                                                                                | ✓     |
| Affiliate content     | The package carries exactly one outbound link, to the LinkedIn profile, and no referral or tracking parameter                                                 | ✓     |
| Pricing               | Nothing in the extension charges, meters or gates a feature behind payment                                                                                    | ✓     |
| Distribution regions  | Nothing in the code is region-specific, and no region is preferred or excluded                                                                                | ✓     |
| Age / target audience | Not directed at children; `docs/PRIVACY.md` says so under "Children"                                                                                          | ✓     |
| Account or login      | **No account is required.** Sign-in needs a backend origin fixed at build time and this build has none. What a user must supply is their own provider API key | ✓     |
| Encryption / export   | Only the platform's own primitives are used — WebCrypto and TLS. No cryptography is implemented here                                                          | ✓     |
| Trader / non-trader   | Nothing in a repository determines this. It is a legal status under the EU Digital Services Act                                                               | ✓     |

The trader declaration is the one to read carefully rather than tick: it is
about whether the listing is published in the course of a trade or profession,
and the store asks for a name, address and contact if it is.

## The account-owner procedure, in order

Everything above, as a sequence, with what each step needs. Steps 1–3 can be
done in any order; 4 onward are strictly sequential.

| #   | Step                                                                                 | Needs                                                                     | Repository provides                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) | A Google account                                                          | —                                                                                                                                                                                                                                         |
| 2   | Pay the one-time registration fee                                                    | A payment method. US$5 at the time of writing — verify the current figure | —                                                                                                                                                                                                                                         |
| 3   | Accept the Developer Agreement and Program Policies                                  | A person who can agree to them                                            | —                                                                                                                                                                                                                                         |
| 4   | Publish the privacy policy at a URL — **DONE**                                       | —                                                                         | Live at <https://about.jamal-balya.workers.dev/en/privacy>, republished and **effective 2026-10-03**, and read against the implementation claim by claim on that date — the table is in [`OWNER-CHECKLIST.md`](OWNER-CHECKLIST.md) item 5 |
| 5   | Run the five browser-only acceptance procedures                                      | An hour, a browser, an API key                                            | The procedures: [`RESULTS.md`](../testing/acceptance/RESULTS.md)                                                                                                                                                                          |
| 6   | Capture screenshots while running step 5                                             | The same session                                                          | —                                                                                                                                                                                                                                         |
| 7   | Build the artifact                                                                   | `npm ci && npm run release`                                               | The whole pipeline                                                                                                                                                                                                                        |
| 8   | Check the digest                                                                     | `sha256sum -c release/*.sha256`                                           | The recorded digest, in [README.md](README.md)                                                                                                                                                                                            |
| 9   | Create the item and upload the ZIP                                                   | The account from 1–3                                                      | The artifact                                                                                                                                                                                                                              |
| 10  | Fill the listing                                                                     | —                                                                         | Name, both descriptions, category guidance: [store-listing.md](store-listing.md)                                                                                                                                                          |
| 11  | Fill permission justifications                                                       | —                                                                         | Eleven, written: [store-listing.md](store-listing.md)                                                                                                                                                                                     |
| 12  | Fill the data-disclosure form                                                        | —                                                                         | Twelve answers, with the audit: [data-flows.md](data-flows.md)                                                                                                                                                                            |
| 13  | Submit for review                                                                    | —                                                                         | —                                                                                                                                                                                                                                         |
| 14  | Wait                                                                                 | —                                                                         | —                                                                                                                                                                                                                                         |
| 15  | On rejection: fix, rebuild, re-record the digest, resubmit                           | —                                                                         | The pipeline; a changed digest is expected                                                                                                                                                                                                |
| 16  | On publication: record the item id and public URL                                    | —                                                                         | —                                                                                                                                                                                                                                         |

Step 5 is placed before the upload on purpose. It is the only step that can
still find a defect, it costs about an hour, and it produces the screenshots
step 6 needs as a by-product. Submitting first means discovering a modal
dialog bug from a user review.

---

## Before submitting, decide these three deliberately

They are not blockers and they are not oversights. Each is a real decision
that has been left to the owner rather than made on their behalf.

**Version `0.1.0`.** The manifest says `0.1.0`, which signals pre-release. The
store does not care, but users read it. If the intent is a public v1, change
it in `package.json`; the single-sourcing check will fail until the manifest
agrees, which is the intended behaviour.

**Three capabilities are PARTIAL and one is NOT-STARTED.** See
`PARITY_MATRIX.md`. That is a fine state to publish from — it is not a fine
state to publish _silently_. The detailed description should say what the
extension does not yet do, because a user who discovers it after installing
leaves a review about it.

**Thirty-two acceptance procedures are still blocked.** See
[`docs/testing/acceptance/MATRIX.md`](../testing/acceptance/MATRIX.md), which records
forty-five PASS, no FAIL and nothing unexecuted. What remains needs a
credential, an OAuth application, or a person at a browser, and
[`OWNER-CHECKLIST.md`](OWNER-CHECKLIST.md) orders them so one sitting covers as
much as your credentials allow. Running them before a public release is the
single highest-value hour available: two of the procedures executed so far
failed, and both were real product defects rather than bad tests.
