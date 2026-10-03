# Owner checklist — from here to a public listing

Twenty-four steps, in order. Steps 1–9 can be done in any order among
themselves; 10 onward are sequential.

Everything marked **REPOSITORY COMPLETE** is done and needs nothing from you
except using it. Everything marked **YOU** cannot be done from a repository:
it needs a Google account, a payment, an agreement you can be bound by, a
credential you hold, or a person at a browser.

> **Current state: submitted, last known status `Pending Review`.** Not
> approved, not published, no public listing.
>
> Nothing below has been performed on your behalf, and this list is kept in its
> original wording because every step in it is still yours to take — for the
> review now in progress, and for whatever is submitted next. The item id and
> the submission date live in your Chrome Web Store account and deliberately
> not here, because this repository cannot verify them.

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

**Thirty-two procedures need a person.** That is the whole list, and it is
ordered below so that one sitting covers as much of it as your credentials
allow. Every one has written steps; follow the reference in its row.

This number has moved three times and every move is recorded rather than
smoothed over. The §84 condition-3 census added twenty-two procedures, because
condition 3 had never been answered per capability. Sixteen of those were then
**executed** as real-Chromium tests and are gone from your list; six remain
here. Executing one of them found a defect that stranded every looping task,
which is the reason the distinction between _written_ and _executed_ is worth
this much fuss.

The third move is this one, and it went **up**. `85-D` — fetch an issue and
prefer the Jira connector over scraping the page — used to be impossible for
anybody, because there was no Jira connector. There is one now, so the item
left "nobody can do this" and joined your list. A number going up because a
capability arrived is the honest direction for it to move.

### A. With one API key — twenty-five of the thirty-two

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

### D. With a GitHub token you create yourself — five more

**This section used to say "with a registered OAuth application", and that was
wrong.** Registering one would not have let you do any of the five. GitHub's
web application flow requires a `client_secret` in the code exchange, PKCE or
not, and this extension must not carry one — a secret inside an extension is
readable by anyone who unzips it. The same is true of Atlassian, which also
supports no PKCE at all, and of Figma. `docs/connectors.md` has the table and
the vendor sources.

So the five are now reachable, and reachable **without registering anything**:

1. Go to <https://github.com/settings/tokens> in your own GitHub account.
2. Create a token. For `88-read` alone, a token with **no** permissions is
   enough — reading public issues needs no scope. For `88-write` you need
   `public_repo` on a classic token.
3. **Prefer a classic token.** GitHub reports a classic token's scopes in an
   `x-oauth-scopes` header and reports nothing for a fine-grained one, so a
   fine-grained token connects, reads, and **refuses every write** — not a
   fault, but it will not get you `88-write`.
4. Paste it into Settings → Connectors → GitHub → Connect.
5. Use a repository you own, or one you do not mind an issue appearing in.
   `88-write` opens a real issue attributed to you.
6. Revoke the token on that same settings page when you are finished.

| Procedure       | What it establishes                                                |
| --------------- | ------------------------------------------------------------------ |
| `88-connect`    | A connector authorizes against a real service                      |
| `88-read`       | A real read, with no scope required                                |
| `88-write`      | A real write, with a scope required                                |
| `88-revocation` | Revoking at the service is noticed here                            |
| `86-5-manual`   | A write killed mid-flight leaves exactly one record on the service |

**If you would rather register an application anyway**, the thing to register
is a GitHub OAuth app for the **device authorization flow**, which is the one
GitHub flow that needs no client secret. That gets you a sign-in flow instead
of a pasted token; it does not get you anything the five procedures above
cannot already establish, and it is not implemented here. The redirect URI for
the code flow, if you ever hold a secret outside the extension, is the value
of `chrome.runtime.getURL('oauth/callback.html')` for your installed build,
and `web_accessible_resources` in the manifest must list the authorization
origin.

### D-2. With a Figma, Jira or Confluence token — the same five, on another service

The five procedures in D are written for GitHub because GitHub is the one with
a write. Three more connectors now accept a token you create yourself, and
running D on any of them is worth doing: it is the same framework against a
different service, which is the only way to find out whether "the framework
holds more than one connector" is true of anything but the tests.

**Figma.** Create a token at
<https://www.figma.com/developers/api#access-tokens> with
`file_content:read`, `file_comments:read` and `current_user:read`. The last one
is what lets this build check the token belongs to you — without it the
connection is refused, which is deliberate and conservative rather than a bug.
Paste it in Settings → Connectors → Figma. Then ask the agent to read a Figma
file you have open, using the file key from its URL.

Figma is **read-only** and that is not caution: Figma reports nothing about what
a token may do, so a write would declare a permission that could never be
established and be refused every time. `88-write` is therefore not available on
Figma; use GitHub for it.

**Jira.** Create an API token at
<https://id.atlassian.com/manage-profile/security/api-tokens>. Paste it in with
the **email address of your Atlassian account** and **your own site address** —
`https://your-team.atlassian.net`, with nothing after it.

`85-D` is the acceptance item this unblocks, and it is the one that moved onto
your list rather than off it: _get an issue and summarise its requirements,
preferring the Jira connector if one is configured._ Run it by opening a web
page that shows one of your own issues and asking for that issue — then watch
whether the agent reads it through the connector or scrapes the page it has
open. The connector is the pass.

The site address is the interesting part to test, and it is worth being
deliberate about:

1. Enter it correctly first and confirm the connection reports your name.
2. Then try it again with the site typed wrongly — `http://` instead of
   `https://`, a path on the end, or somebody else's team name. Each must be
   refused with a sentence that says what to fix, and **nothing must be
   stored**. That is the whole security property of a connector whose API
   address belongs to the user.
3. Ask the agent to search issues with JQL and to read one.

Jira is read-only for the same reason Figma is.

**Confluence.** The **same token works**, and that is the point of connecting
it. Use the one you already created at
<https://id.atlassian.com/manage-profile/security/api-tokens>, with the same
email address and the same site address, and paste it in Settings →
Connectors → Confluence. Then ask the agent to search pages with CQL and to
read one.

Entering the same token twice is deliberate, and the thing worth testing is
what it buys:

1. Connect **Jira only**, then ask the agent to read a Confluence page. It must
   refuse, because connecting one authorises nothing for the other — each
   connector holds its own credential bound to its own site address.
2. Connect both, then disconnect Jira. Confluence must still work.
3. Try the wrong site address on Confluence too — `http://`, a path on the end,
   somebody else's team name. The refusals are the same ones, because the rule
   is one function both connectors reach rather than a copy in each.

Confluence is read-only, and for a third reason: Basic authentication reports
no scopes at all, so a declared write could never be established.

**What to record.** Which service, which procedures, what happened, and the
date. Not the token, not the base64 of it, and not a screenshot showing the
field with anything in it.

### E. Not executable by anybody, and not waiting on you

| Procedure      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `84-P-025`     | P-025 Plugins is not implemented, and is off the parity critical path                                                                                                                                                                                                                                                                                                                                                              |
| `85-D`, `85-E` | They name Jira, Confluence, Figma and Sheets, and need **all four at once** for one workflow. Three of the four now exist and are connectable with a token you create (D-2); Google Sheets does not, and it is the one that would need a registered client id rather than a user-created token. So these moved from "no connector exists" to "three of four exist" — still not executable, and now for one reason rather than four |
| `89-06`        | The iframe exclusion is behaviour, not a gap: the agent has no handle inside a cross-origin frame                                                                                                                                                                                                                                                                                                                                  |

### One more that is separate, and unavoidable

`84-P-026` — every MCP call prompts, on every call. It needs an **MCP server on
https at an origin somebody else operates**: the policy engine refuses a
plain-http destination, so a loopback server's tools discover here and can never
be run. `P-026-C2` itself is **VERIFIED** — a public credential-free remote MCP server was reached through the production path — so this is not waiting on anything to obtain. What it waits on is you, pointing Settings at such a server and watching the prompts. `BLOCKER-CERTIFICATION.md` has the lead.

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

## Security actions, and one that is overdue

**S-1. Rotate the temporary 9Router API key — YOU, and treat it as exposed.**

A temporary 9Router key was supplied to this repository for live integration
testing on 2026-10-01. It was never committed, never printed, and every scan
that checked for it carried a positive control — but it was pasted into a
session and written to a file on this machine, so the only state in which it is
not exposed is **revoked or rotated at the provider**.

Deleting the file is not sufficient and never was:

```
rm /Users/jemz/code/jemz/aibrowseragent/.env.9router.local   # necessary, not sufficient
```

What closes it is rotating the credential in the 9Router instance that issued
it. Until that happens, assume anything that key authorises is reachable by
anyone who has seen it. This item exists in the repository rather than only in
a session report because a reminder that lives in a transcript is a reminder
that disappears — it had been raised four times and written down nowhere.

Evidence to capture: nothing from the key itself. Record only the date it was
rotated.

**S-2. No OAuth client secret is in the extension — REPOSITORY COMPLETE.**

Asserted rather than promised. `ConnectorOAuthConfig` has no field for one, and
`tests/security/credential-boundary.test.ts` plus the release artifact scan hold
the line. The backend holds `ABA_GOOGLE_CLIENT_SECRET`; the extension never
sees it and could not use it.

---

## Google sign-in against the real Google — YOU

Everything in the sign-in is implemented and covered by 34 cases in real
Chromium against a controlled backend over real HTTPS with genuinely signed
RS256 tokens: the flow, cancellation, session persistence, refresh, concurrent
refresh, a worker restart, logout, and server-side revocation. One of those
cases runs the whole journey and a task on the selected AI account.

**What has never happened is a sign-in against Google's own endpoints.** That
needs two things this repository cannot have: a backend reachable at an https
origin, and a Google OAuth client registered to it. Both are yours. Nothing
below is implemented on your behalf and no credential is invented.

### G-1. Register a Google OAuth client

1. In the Google Cloud console, create (or pick) a project and configure the
   OAuth consent screen. **External**, and it may stay in _Testing_ with your
   own address as a test user — this does not need verification to work for you.
2. Create an OAuth **client id** of type **Web application**. Not "Chrome
   extension": the code exchange happens on your backend, which is a web
   server, and that is also why a client _secret_ exists and why it must never
   reach the extension.
3. Scopes: `openid`, `email`, `profile`. Nothing else. The backend asks for no
   more and the extension asks for nothing at all.
4. Authorised redirect URI — exactly one, and exactly this shape:

   ```
   https://<your-backend-origin>/v1/auth/google/redirect
   ```

   That path is `DEFAULT_PATHS.redirectPath` in `server/http/router.ts`. Google
   redirects **to your backend**, never to the extension; the backend then
   redirects once more to `/v1/auth/google/callback`, which is the URL the
   extension watches for. A redirect URI pointing at a `chrome-extension://`
   origin is wrong here and Google will refuse it.

### G-2. Deploy the backend

`server/` is a self-contained identity service that `src/` has never imported.
It needs these environment variables, and the three marked secret belong in a
secret store rather than a config map:

| Variable                       | What it is                              | Secret  |
| ------------------------------ | --------------------------------------- | ------- |
| `ABA_PUBLIC_ORIGIN`            | the https origin the backend answers on | no      |
| `ABA_ACCESS_TOKEN_SIGNING_KEY` | signs access tokens                     | **yes** |
| `ABA_DATABASE_URL`             | database connection string              | **yes** |
| `ABA_GOOGLE_CLIENT_ID`         | the client id from G-1                  | no      |
| `ABA_GOOGLE_CLIENT_SECRET`     | the client secret from G-1              | **yes** |

The Google pair is configured **as a group or not at all**: a backend without
them is a working backend that simply cannot sign anybody in that way, and the
routes that would are absent rather than broken. `server/config.ts` throws
naming every missing variable at once rather than one per restart.

Run the migrations in `server/migrations/` in order.

### G-3. Build an extension that knows where the backend is

The backend origin is inlined by Vite at build time, deliberately — an origin
that could be set from a message would be an origin an attacker could set.
There is no runtime setting for it and there must not be.

```
VITE_ABA_BACKEND_ORIGIN=https://<your-backend-origin> npm run build
```

It must be `https://` and an origin only. A build with no origin — which is
what ships — reports `configured: false` and offers no sign-in button at all,
rather than one that cannot work.

### G-4. What to actually test, and what evidence to keep

Load that build unpacked and work through this. Each line is a thing that has
only ever been exercised against a controlled backend:

| #   | Do this                                                | Met when                                                                |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | Open Settings → sign in with Google                    | Google's own consent screen appears, on `accounts.google.com`           |
| 2   | Approve it                                             | the panel reports signed in, and names no token anywhere                |
| 3   | **Dismiss** the Google window instead, on a second try | reported as cancelled; no session is created                            |
| 4   | Connect an AI provider account and run a task          | the task runs — this is the regression that signing in used to break    |
| 5   | Reopen the browser                                     | still signed in, without a second consent screen                        |
| 6   | Sign out                                               | signed out, and every workflow, account, key and task is still there    |
| 7   | Sign in again                                          | the **same** account, with no second device registered                  |
| 8   | Stop the backend, then reload the panel                | still usable; the agent still runs tasks; the status says what is wrong |
| 9   | Revoke the app at `myaccount.google.com/permissions`   | the next refresh fails and asks you to sign in, rather than retrying    |

Evidence to capture, and **nothing else**: a screenshot of the panel signed in
with the account name visible, a screenshot of step 8's status, and the dates.
Do **not** capture or paste a token, a session id, an authorization code, a URL
containing `code=` or `state=`, or the contents of `chrome.storage`. None of
those is needed to establish that any of the nine happened.

### G-5. If something fails

A production configuration error should say so rather than fail obscurely.
`auth.status` reports `configured: false` for a build with no origin, and the
backend names every missing variable at startup. If step 1 produces a Google
error page, the redirect URI in G-1 does not match
`ABA_PUBLIC_ORIGIN` + `/v1/auth/google/redirect` exactly — compare them
character by character, including the scheme and any trailing slash.

Report what happened. A failure here is a finding about the repository, not
about you.

### G-6. Register a Google OAuth client for the **Gemini API** — a separate thing

**This is not G-1 and does not depend on it.** G-1 to G-5 are the product
sign-in, which needs a deployed backend. This one needs no backend, no secret
and no deployment: it is what lets a user press _Connect with Google_ and give
the agent a Gemini credential to run on. You can do this and skip G-1
entirely.

Twenty minutes, and the only part that is fiddly is the extension id.

1. **Decide which extension id you are registering.** Google pins the redirect
   to one id. An unpacked build has a different id from the published one, so
   register the one you intend to test with, and expect to register the Web
   Store id separately after publishing.
2. In the Google Cloud console, pick or create a project, and **enable the
   Generative Language API** on it. Usage is billed to this project.
3. APIs & Services → Credentials → Create credentials → OAuth client ID →
   application type **Chrome Extension** (not Web application, not Desktop).
   Paste the extension id. You will be given a client id ending
   `.apps.googleusercontent.com` and **no client secret** — Google does not
   issue one for this client type, and the extension could not hold one safely
   if it did.
4. On the OAuth consent screen, add the scope
   `https://www.googleapis.com/auth/cloud-platform` and add your own Google
   account as a test user. While the app is unverified, only test users can
   complete it — that is Google's rule and not a defect here.
5. Build with the client id inlined:

   ```sh
   VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID=<your-id>.apps.googleusercontent.com npm run build
   ```

6. Load that build, open Settings, choose Google Gemini, and press
   **Connect with Google**. What to watch, in this order:
   - Chrome asks for the `identity` permission. **Decline it once.** The panel
     must say nothing was changed, and no account must appear.
   - Press it again and accept. Google's consent screen appears.
   - **Uncheck the requested access** if Google offers the choice. The
     connection must be refused with a sentence about authorizing again — a
     token without that scope cannot list or run a model, and storing it would
     produce an account that looks connected and fails at first use.
   - Accept properly. An account appears, with **no model selected**, and the
     model list is populated from what Google says that project can use.
   - Choose a model, run the capability check, then run a task.
7. **What to record.** Which extension id, which project, whether each of the
   four outcomes above behaved, and the date. Not the client id's project
   number if you would rather not, and **never** a token, a code or a
   screenshot showing one.

**If the consent screen shows an error instead of a prompt**, the extension id
in the client registration does not match the build you loaded. Compare
`chrome://extensions` against the console entry character by character.

**If a task then fails with a Google error about quota or a project**, that is
the one thing this repository marks **unverified**: Google's discovery document
declares no OAuth scope for `generateContent`, and whether every method accepts
a bearer token on every project configuration has not been established here.
Report exactly what Google said — it is a finding, and `docs/account-integration.md`
is where it belongs.

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
