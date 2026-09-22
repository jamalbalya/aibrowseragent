# Owner checklist — from here to a public listing

Twenty-four steps, in order. Steps 1–9 can be done in any order among
themselves; 10 onward are sequential.

Everything marked **REPOSITORY COMPLETE** is done and needs nothing from you
except using it. Everything marked **YOU** cannot be done from a repository:
it needs a Google account, a payment, an agreement you can be bound by, a
credential you hold, or a person at a browser.

> **Current state: not submitted, not published.** There is no listing, no
> item id and no developer account. Nothing below has been performed on your
> behalf.

---

## Account and legal

**1. Google account — YOU**
Use or create the account that should own the listing. It will be the
publisher identity, so pick deliberately: moving a listing between accounts
later is awkward.

**2. Developer registration — YOU**
Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).

**3. Registration fee — YOU**
A one-time fee, **US$5 at the time of writing**. Verify the current amount on
the dashboard; it is not this repository's to assert.

**4. Developer Agreement and Program Policies — YOU**
Accept both. A person who can be bound by them must do this.

---

## Content you need to host or hold

**5. Privacy policy at a public URL — YOU, content REPOSITORY COMPLETE**
The required content is in
[`privacy-policy-outline.md`](privacy-policy-outline.md), written from the
real data flows. What is missing is only a URL.
**Do not claim the extension collects no data** — website content is
transmitted to the user's chosen provider, and that must be disclosed. The
accurate strong claim is no telemetry, no analytics, nothing to the developer.

**6. Provider credentials — YOU**

| Purpose                                  | Minimum                                           |
| ---------------------------------------- | ------------------------------------------------- |
| §85 A-1, B-1, C-1 and one provider's §87 | **1 key**, any of the three                       |
| §85 F-1 provider swap and full §87       | **3 keys** — OpenAI-compatible, Anthropic, Gemini |

Enter them in the extension's settings, in your own browser. Do not paste a
key into a file, a commit, an issue, a screenshot, or a chat.

**7. Connector OAuth application — YOU, only if you want §88 live**
Register a GitHub OAuth app with callback
`chrome-extension://<your-extension-id>/oauth/callback.html` and configure the
client id in settings. Needed for §88 C-1/R-1/V-1 and §86's duplicate-write
manual half. Not needed to publish.

---

## Testing you must do yourself

**8. Execute the remaining manual acceptance — YOU**
Twelve procedures remain, listed with exact steps in
[`../testing/acceptance/MATRIX.md`](../testing/acceptance/MATRIX.md).

Three of them cannot be automated at all, and they are the highest value per
minute. **They still need a provider key from step 6** — each starts by
running a task, and there is no task to interrupt without one. (An earlier
draft of this file said they were credential-free. They are not.)

| Procedure                   | What it catches                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| §90-08 browser restart      | whether a parked task and the settings survive a full quit, and that the connector correctly needs re-authorization |
| §90-09 extension reload     | whether a torn-down content script is reported clearly rather than failing obscurely                                |
| §90-10 network interruption | whether a dropped connection retries and then stops cleanly rather than hanging                                     |

The other nine need a credential from step 6 or 7.

Record each outcome in
[`../testing/acceptance/RESULTS.md`](../testing/acceptance/RESULTS.md) — date,
build, what you observed, and `EXECUTED — MET`, `NOT MET` or `BLOCKED`.

**9. Screenshots — YOU**
Follow [`screenshot-plan.md`](screenshot-plan.md). Capture them **during**
step 8, because a task running for a real test is exactly the image you need.
1280×800, at least one, at most five. Check every image against the
"must never be visible" list — an API key or a masked key suffix in a
published screenshot cannot be taken back.

---

## Build and verify

**10. Clean install — YOU, one command**

```bash
npm ci
```

**11. Build the artifact — REPOSITORY COMPLETE, one command**

```bash
npm run release
```

Builds for production, validates the package, validates the release, packages
the ZIP and verifies the packing is deterministic.

**12. Verify the checksum — YOU, one command**

```bash
sha256sum -c release/ai-browser-agent-0.1.0.zip.sha256
```

Expect:

```text
8ac438910d24492633d6789662794b6669fb7ed90922a7f9b6ec58352a6ba8dc
```

Two clean builds of commit `a3da142` produce byte-identical archives on the
same toolchain (Node v22.22.2). A different Node or OS may legitimately
differ — vite's minifier is not promised reproducible across versions — so
treat a mismatch as a toolchain question, not necessarily tampering.

---

## The listing

**13. Upload the ZIP — YOU**
`release/ai-browser-agent-0.1.0.zip`, and no other file.

**14. Item name — REPOSITORY COMPLETE**

```text
AI Browser Agent
```

**15. Short description — REPOSITORY COMPLETE**, 108 characters, in
[`store-listing.md`](store-listing.md).

**16. Detailed description — REPOSITORY COMPLETE**, drafted in
[`store-listing.md`](store-listing.md), ready to paste. It states the
limitations up front — one connector, no scheduling, no plugins, no MCP, **no
iframe support** — because a user who finds those out after installing leaves
a review about it.

**17. Permission justifications — REPOSITORY COMPLETE**
Eleven, one per permission, in [`store-listing.md`](store-listing.md).
Expect a question about `debugger`; the specific answer is there — the CDP
surface is a fixed allowlist with no evaluator, no tool accepts a method name,
and a standing test fails the build if `Runtime.evaluate` is ever added.

**18. Data-use disclosures — REPOSITORY COMPLETE**
Twelve answers, in [`store-listing.md`](store-listing.md), with the
category-by-category audit in [`data-flows.md`](data-flows.md).
**Answer yes to "collects website content."** It is transmitted to the
provider the user chose, and saying otherwise because it is transient would be
a false attestation. It must match the privacy policy from step 5.

**19. Submit for review — YOU**

---

## After submission

**20. Monitor the review — YOU**
No guaranteed turnaround is published. A rejection names a policy clause: fix
it in the repository, rebuild from step 10, and resubmit. **The digest will
change, and that is expected** — it is how two builds are told apart.

**21. Verify publication — YOU**
Only once the dashboard shows the item live.

**22. Verify the public listing — YOU**
Open the public URL in a signed-out browser. Check the description, the
screenshots and the permission list are what you submitted.

**23. Install the public version — YOU**
Install from the store into a clean profile and run one real task end to end.
A listing that installs but does not work is worse than no listing.

**24. Verify the installed version matches what you shipped — YOU**
Confirm the installed version reads `0.1.0` and that its behaviour matches the
build you tested. Chrome re-signs the package, so the installed CRX will not
hash to `8ac43891…` — that digest identifies **what you uploaded**, not what
Chrome distributes. Compare the version and the manifest contents, not the
archive hash.

---

## Only after step 22

Once the listing is genuinely live, the repository may record it: the item id,
the public URL, and the date. Not before.

`tests/security/release-claims.test.ts` fails the build if any document claims
store availability, so that record becomes a deliberate edit to a test rather
than a sentence somebody wrote optimistically. That is the intended friction.

---

## Two decisions to make deliberately before step 19

**The version is `0.1.0`.** It signals pre-release, and users read it as a
claim. Seven capabilities are PARTIAL and three NOT-STARTED, so `0.1.0` is
accurate. If you want a public v1, change it in `package.json` — the build
fails until the manifest agrees, which is intended.

**Twelve acceptance procedures are unexecuted.** Publishing is still
defensible: the automated coverage is substantial and the listing states the
gaps. But the three environment ones in step 8 cost about an hour between them
once you have a key, and the last two procedures that were executed both found
real defects.
That is the argument for doing them first, in one sitting, and capturing the
screenshots while you are there.
