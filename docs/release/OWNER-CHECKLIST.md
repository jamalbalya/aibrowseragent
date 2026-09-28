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

**5. Privacy policy at a public URL — DONE**
Published and verified reachable on 2026-09-29:
<https://about.jamal-balya.workers.dev/en/privacy>
Paste it into the dashboard exactly as written.
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

**Thirty-one procedures need a person.** That is the whole list, and it is
ordered below so that one sitting covers as much of it as your credentials
allow. Every one has written steps; follow the reference in its row.

This number moved twice and both moves are recorded rather than smoothed over.
The §84 condition-3 census added twenty-two procedures, because condition 3 had
never been answered per capability. Sixteen of those were then **executed** as
real-Chromium tests and are gone from your list; six remain here. Executing one
of them found a defect that stranded every looping task, which is the reason the
distinction between _written_ and _executed_ is worth this much fuss.

### A. With one API key — twenty-five of the thirty-one

Any one of OpenAI-compatible, Anthropic or Gemini. Do these first: they are the
bulk of the list and they share one browsing session.

| Order | Procedure         | What it establishes                                                                                                   |
| ----- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1     | `84-P-001`        | The panel opens beside the page and never obscures or reflows it — the one claim about Chrome's own side-panel chrome |
| 2     | `85-A-1`          | Whether the summary of a real page is accurate and useful                                                             |
| 3     | `85-B-1`          | A genuine three-tab comparison, with one tab closed mid-task                                                          |
| 4     | `85-C-1`          | Whether the diagnosis of a staged broken Save is correct                                                              |
| 5     | `84-P-008`        | Whether an answer really depended on the screenshot                                                                   |
| 6     | `87-01` … `87-12` | The twelve provider items against the vendor's own endpoint rather than a local server                                |
| 7     | `84-P-019`        | Clicking the notification brings you to the panel at the right place                                                  |
| 8     | `84-P-020`        | A schedule survives a full browser restart                                                                            |
| 9     | `91-D-3`          | Granting the optional `downloads` permission through Chrome's own dialog                                              |
| 10    | `90-10`           | A dropped connection retries and then stops cleanly rather than hanging                                               |
| 11    | `90-09`           | An extension reload: a torn-down content script is reported clearly                                                   |
| 12    | `90-08`           | A full browser quit and reopen — and the connector correctly needing re-authorization                                 |

Leave 8, 11 and 12 until last in the session: each one ends the browser state
the earlier items are using.

### B. With three API keys — one more

| Procedure | What it establishes                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `85-F-1`  | The same prompt on three _different adapters_ produces the same tools, prompts and answer. Two keys cannot test three adapters |

### C. With a key for a model that advertises vision — one more

| Procedure  | What it establishes                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------ |
| `84-P-009` | An image is answered _from_, and a model without vision refuses before sending rather than after |

`87-08` is in group A and is the same prerequisite: on a text-only model it
exercises the unsupported-capability path instead, which is already covered.

### D. With a registered OAuth application — five more

| Procedure       | What it establishes                                                |
| --------------- | ------------------------------------------------------------------ |
| `88-connect`    | A connector authorizes against a real service                      |
| `88-read`       | A real read, with no scope required                                |
| `88-write`      | A real write, with a scope required                                |
| `88-revocation` | Revoking at the service is noticed here                            |
| `86-5-manual`   | A write killed mid-flight leaves exactly one record on the service |

### E. Not executable by anybody, and not waiting on you

| Procedure      | Why                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `84-P-025`     | P-025 Plugins is not implemented, and is off the parity critical path                                            |
| `85-D`, `85-E` | They name Jira, Confluence, Figma and Sheets; those connectors do not exist here, and no credential changes that |
| `89-06`        | The iframe exclusion is behaviour, not a gap: the agent has no handle inside a cross-origin frame                |

### One more that is separate, and unavoidable

`84-P-026` — every MCP call prompts, on every call. It needs an **MCP server on
https at an origin somebody else operates**: the policy engine refuses a
plain-http destination, so a loopback server's tools discover here and can never
be run. This is blocker A-6, and it is the same thing `P-026-C2` asks for.

A lead rather than an instruction, because nothing here has verified it: public
unauthenticated MCP endpoints are advertised — `https://mcpplaygroundonline.com/mcp-complex-server`
was the candidate found — and this environment's proxy refuses the host, so no
handshake has been seen. If it answers for you, pasting it into Settings turns
this item from "find a remote MCP server" into two minutes. If it does not, any
remote MCP server you can reach settles the same clause. See
[`BLOCKER-CERTIFICATION.md`](BLOCKER-CERTIFICATION.md) A-6 for why it is not
wired into the build.

Record each outcome in
[`../testing/acceptance/RESULTS.md`](../testing/acceptance/RESULTS.md) — date,
build, what you observed, and `EXECUTED — MET`, `NOT MET` or `BLOCKED`. A `NOT
MET` is the valuable one: two of the five procedures executed so far failed, and
both were real defects.

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
cd release && sha256sum -c ai-browser-agent-0.1.0.zip.sha256
```

Expect:

```text
ai-browser-agent-0.1.0.zip: OK
```

Run it from inside `release/`: the `.sha256` file records a bare filename, so
from the repository root the tool looks for the ZIP in the wrong place and
reports `FAILED open or read`.

This checks the ZIP against the digest the packager recorded for **this**
build, which is what you want — the digest is a function of the source, so it
differs at every commit that changes `src/` or `public/`. There is deliberately
no digest written here to compare against by eye; see
[README.md](README.md#the-artifact-you-are-shipping) for why.

Two clean builds of the same commit produce byte-identical archives on the
same toolchain (Node v22.22.2), which is what makes the recorded digest worth
having. A different Node or OS may legitimately differ — vite's minifier is
not promised reproducible across versions — so treat a `FAILED` on a _re-built_
archive as a toolchain question, not necessarily tampering.

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
hash to the digest in `release/ai-browser-agent-0.1.0.zip.sha256` — that digest
identifies **what you uploaded**, not what Chrome distributes. Compare the
version and the manifest contents, not the archive hash.

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
