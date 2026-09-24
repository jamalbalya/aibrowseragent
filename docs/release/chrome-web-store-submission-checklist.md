# Chrome Web Store submission checklist

Split into two halves that must not be confused:

- **REPOSITORY COMPLETE** — done, in this repository, checkable by anyone who
  clones it.
- **ACCOUNT OWNER ACTION REQUIRED** — cannot be done from a repository at all.
  It needs a Google account, a payment, an accepted legal agreement, or a
  human at a dashboard.

Nothing in the second half is fabricated, approximated, or marked done on the
strength of the first half being done.

> **This extension has not been submitted and is not published.** There is no
> listing, no item id, and no developer account. No statement anywhere in this
> repository should be read as saying otherwise. The artifact described in
> [README.md](README.md) has been built and hashed locally and has gone
> nowhere.

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

The store requires a **hosted** privacy policy the listing can link to.
`docs/PRIVACY.md` is the content, complete and current; what is missing is a
URL. Publishing the repository's docs, or the GitHub blob URL of that file,
both satisfy it.

_Why not here:_ hosting is an account action, and the URL is not knowable
until a host is chosen.

### 3. Listing assets

| Asset                     | Required                               | Status                                                                                                             |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Item name                 | Yes                                    | **Repository complete** — `AI Browser Agent`, from the manifest                                                    |
| Short description         | Yes, ≤132 chars                        | **Repository complete** — 108 characters, in [store-listing.md](store-listing.md)                                  |
| Detailed description      | Yes                                    | **Repository complete** — drafted in [store-listing.md](store-listing.md), ready to paste                          |
| Permission justifications | Yes, one per permission                | **Repository complete** — twelve, in [store-listing.md](store-listing.md)                                          |
| Data disclosure answers   | Yes                                    | **Repository complete** — twelve, in [store-listing.md](store-listing.md); audit in [data-flows.md](data-flows.md) |
| Icon 128×128              | Yes                                    | Present, verified 128×128                                                                                          |
| Icons 16, 32, 48          | For the toolbar                        | Present, each verified at its declared size                                                                        |
| Screenshots               | Yes, at least one, 1280×800 or 640×400 | **Not produced — account owner**                                                                                   |
| Small promo tile 440×280  | Optional                               | Not produced                                                                                                       |
| Category                  | Yes                                    | Not chosen — a judgement about audience, not about code                                                            |
| Language                  | Yes                                    | Not chosen                                                                                                         |

The listing _copy_ is written and repository-complete: name, both
descriptions, every permission justification and every data-disclosure answer
are drafted in [store-listing.md](store-listing.md) against what the code
actually does.

_Why the screenshots are not here:_ a screenshot of this extension doing
something real needs a configured provider, which needs an API key this
repository does not hold and will not invent. A screenshot of the panel doing
nothing would be a listing asset that misrepresents the product, which is
worse than having none — and a fabricated one showing a capability nobody has
manually verified would be worse still. Five of the fifteen manual acceptance
procedures need only a person and a browser; running those produces both the
verification and the screenshots in one sitting.

### 4. The upload itself

- Upload `release/ai-browser-agent-0.1.0.zip`.
- Verify the dashboard reports SHA-256
  `2a648dc36c3a71ccdd68c8351aa527f6a57eeb77d2654af3e366dd82dc862236`, or
  re-derive it locally with `sha256sum -c release/*.sha256` before uploading.
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

## The account-owner procedure, in order

Everything above, as a sequence, with what each step needs. Steps 1–3 can be
done in any order; 4 onward are strictly sequential.

| #   | Step                                                                                 | Needs                                                                     | Repository provides                                                              |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Register at the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) | A Google account                                                          | —                                                                                |
| 2   | Pay the one-time registration fee                                                    | A payment method. US$5 at the time of writing — verify the current figure | —                                                                                |
| 3   | Accept the Developer Agreement and Program Policies                                  | A person who can agree to them                                            | —                                                                                |
| 4   | Publish the privacy policy at a URL                                                  | Somewhere to host it                                                      | The content: [`docs/PRIVACY.md`](../PRIVACY.md)                                  |
| 5   | Run the five browser-only acceptance procedures                                      | An hour, a browser, an API key                                            | The procedures: [`RESULTS.md`](../testing/acceptance/RESULTS.md)                 |
| 6   | Capture screenshots while running step 5                                             | The same session                                                          | —                                                                                |
| 7   | Build the artifact                                                                   | `npm ci && npm run release`                                               | The whole pipeline                                                               |
| 8   | Check the digest                                                                     | `sha256sum -c release/*.sha256`                                           | The recorded digest, in [README.md](README.md)                                   |
| 9   | Create the item and upload the ZIP                                                   | The account from 1–3                                                      | The artifact                                                                     |
| 10  | Fill the listing                                                                     | —                                                                         | Name, both descriptions, category guidance: [store-listing.md](store-listing.md) |
| 11  | Fill permission justifications                                                       | —                                                                         | Eleven, written: [store-listing.md](store-listing.md)                            |
| 12  | Fill the data-disclosure form                                                        | —                                                                         | Twelve answers, with the audit: [data-flows.md](data-flows.md)                   |
| 13  | Submit for review                                                                    | —                                                                         | —                                                                                |
| 14  | Wait                                                                                 | —                                                                         | —                                                                                |
| 15  | On rejection: fix, rebuild, re-record the digest, resubmit                           | —                                                                         | The pipeline; a changed digest is expected                                       |
| 16  | On publication: record the item id and public URL                                    | —                                                                         | —                                                                                |

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

**Seven capabilities are PARTIAL and three are NOT-STARTED.** See
`PARITY_MATRIX.md`. That is a fine state to publish from — it is not a fine
state to publish _silently_. The detailed description should say what the
extension does not yet do, because a user who discovers it after installing
leaves a review about it.

**Fifteen acceptance procedures are written and none executed.** See
[`docs/testing/acceptance/RESULTS.md`](../testing/acceptance/RESULTS.md). Five need nothing but
a person and a browser — popup handling, SPA navigation, modal dialogs,
browser restart and extension reload — and they cover behaviour no automated
test exercises. Running those five before a public release is the single
highest-value hour available, because a modal dialog reported as successfully
clicked is exactly the kind of failure a first-week user hits.
