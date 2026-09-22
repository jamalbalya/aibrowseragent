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
| Icons                       | 16, 32, 48 and 128 px, all real PNGs of the declared size                |
| Deterministic archive       | two clean builds → identical SHA-256                                     |
| Digest recorded             | `release/*.sha256` and `release/*.json`                                  |

### Permissions, and the justification each one needs

Store review asks for a justification per permission, and the narrow ones are
easy. These are the answers this repository can give from its own code:

| Permission                                  | Justification                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `sidePanel`                                 | The entire user interface is the side panel                                                                 |
| `storage`, `unlimitedStorage`               | Tasks, audit trail and settings persist locally; MV3 evicts the worker, so in-memory state is not an option |
| `tabs`, `tabGroups`                         | The agent acts on tabs the user names and groups results                                                    |
| `scripting`                                 | Injects the content script that reads the page model                                                        |
| `debugger`                                  | Reads console and network for the diagnosis capability (§85 C)                                              |
| `notifications`                             | Tells the user a task needs them when the panel is closed                                                   |
| `activeTab`                                 | Acts on the tab the user is looking at                                                                      |
| `host_permissions: http://*/*, https://*/*` | The agent works on whatever page the user asks about                                                        |
| `optional_permissions: alarms, downloads`   | Requested only when used, granted under the user's own gesture                                              |

Two of these will attract reviewer attention and it is better to know which:

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

[`docs/PRIVACY.md`](../../PRIVACY.md) is written against what the code does,
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

| Asset                 | Required                               | Status                                                                 |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Item name             | Yes                                    | `AI Browser Agent`, from the manifest                                  |
| Short description     | Yes, ≤132 chars                        | The manifest `description` is available and is within the limit        |
| Detailed description  | Yes                                    | Not written — the store's field, not a repository file                 |
| Screenshots           | Yes, at least one, 1280×800 or 640×400 | **Not produced.** Needs a running extension with a configured provider |
| Small promo tile      | 440×280                                | Not produced                                                           |
| Category and language | Yes                                    | Not chosen                                                             |

_Why not here:_ a screenshot of this extension doing something real requires a
provider credential this repository does not hold. A screenshot of it doing
nothing would be a misleading listing asset, which is worse than none.

### 4. The upload itself

- Upload `release/ai-browser-agent-0.1.0.zip`.
- Verify the dashboard reports SHA-256
  `df4d80df7b2347bb67d8d50c74d9abf07eab5196bb264b788dabca18334a68b4`, or
  re-derive it locally with `sha256sum -c release/*.sha256` before uploading.
- Complete the permission justifications, using the table above.
- Complete the data-disclosure form, using the table above.
- Submit for review.

_Why not here:_ uploading requires the account from item 1.

### 5. After review

- Review takes an unpredictable time; the store publishes no guaranteed SLA.
- A rejection names a policy clause. Fix it in the repository, rebuild,
  re-record the digest, and resubmit — the digest changing is expected and is
  how the two builds are told apart.
- **Only once the listing is live** may anything in this repository describe
  the extension as published, and then only with the item id and the public
  URL recorded.

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
[`../acceptance/RESULTS.md`](../acceptance/RESULTS.md). Five need nothing but
a person and a browser — popup handling, SPA navigation, modal dialogs,
browser restart and extension reload — and they cover behaviour no automated
test exercises. Running those five before a public release is the single
highest-value hour available, because a modal dialog reported as successfully
clicked is exactly the kind of failure a first-week user hits.
