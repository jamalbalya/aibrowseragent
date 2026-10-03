# Owner checklist — from here to a public listing

> **Read this first, before anything in the dashboard.**
>
> The `0.1.0` artifact submitted to the Chrome Web Store, whose last known
> status is `Pending Review`, **predates five defects found on 3 October 2026**
> by running the provider adapters against real endpoints for the first time.
> Two of them together meant the browser agent **could not run on Gemini at
> all**. Whatever that review returns, that artifact should not be the one that
> goes public — rebuild from `main` and upload the current one.
>
> `docs/testing/integration-readiness.md` lists the five.

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

**5. Privacy policy at a public URL — DONE, republished, and checked**
<https://about.jamal-balya.workers.dev/en/privacy>
Paste it into the dashboard exactly as written.

**Republished by the owner and effective 2026-10-03.** This item previously
said it needed republishing, because the hosted text predated the optional
`identity` permission and the Cloud project a Google-authorized request names.
Both are now in it.

**Read against the implementation on 2026-10-03**, claim by claim, and every
one holds:

| The published policy says                                                                                               | The code                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `identity` is "requested only when the user chooses to authorize a Google account for the Gemini API"                   | Optional in the manifest, requested on the button, nowhere else                       |
| "Google's own consent screen opens in a window Chrome controls, so the extension never sees the user's Google password" | `launchWebAuthFlow`; the extension never renders a Google form                        |
| The Cloud project "is configured when the extension is built, is not read from the user's Google account"               | `VITE_ABA_GOOGLE_QUOTA_PROJECT`, build-time, never from a message                     |
| An API key "is sent only to the provider it belongs to, as a request header, never in a URL"                            | Per-connection credential; the Gemini adapter refuses a base URL that could carry one |
| "GitHub, Figma, Jira and Confluence — and none is connected unless the user connects it"                                | Four registered connectors, each `authKind: 'api_token'`                              |
| "The extension has no backend operated by the developer"                                                                | No backend origin is compiled into the shipped build                                  |
| "no telemetry, no analytics and no error or crash reporting… no information is sent to the developer"                   | No such destination exists in the egress allowlist                                    |
| "does not require an account or sign-in"                                                                                | The journey runs signed out start to finish                                           |

An earlier hosted version mentioned "authentication services, synchronization
services", which the shipped build has none of. **That over-disclosure is gone
from the republished text** — worth noting because a policy claiming more than
the product does is its own kind of inaccuracy, and this one corrected itself.

Nothing further is needed here unless the implementation changes again.
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

**For Gemini there is now an alternative to a key**: authorize a Google account
instead, which needs no key but does need the one-time setup in **G-6**. Either
satisfies the Gemini rows above. Every other provider takes a key, and
`docs/account-integration.md` has the per-vendor reasons.

**7. Connector credentials — YOU, only if you want §88 live. ~~Register a
GitHub OAuth app~~ — this item was wrong**

This item used to say _"register a GitHub OAuth app with callback
`chrome-extension://<your-extension-id>/oauth/callback.html` and configure the
client id in settings"_. **That would not have worked**, and following it would
have cost an evening: GitHub's web application flow requires a `client_secret`
in the code exchange, PKCE or not, and this extension must never carry one.
Atlassian 3LO requires one and supports no PKCE at all; Figma requires one even
with PKCE. `docs/connectors.md` has the table and the vendor sources.

What actually unblocks §88 is **a token you create in your own account**, which
takes minutes and needs no registration:

| Connector  | Where you create the token                                           |
| ---------- | -------------------------------------------------------------------- |
| GitHub     | <https://github.com/settings/tokens> — the only one with a **write** |
| Figma      | <https://www.figma.com/developers/api#access-tokens>                 |
| Jira       | <https://id.atlassian.com/manage-profile/security/api-tokens>        |
| Confluence | the same Atlassian token, entered again — section D-2 says why       |

Section **D** is the five-step procedure and **D-2** covers the other three
services. Not needed to publish.

---

## Testing you must do yourself

**8. Execute the remaining manual acceptance — YOU**

**Twenty-one procedures need a person.** That is the whole list, and it is
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

The fourth move is **thirty-two down to twenty-two**, and it is the largest.
Ten of the twelve §87 provider procedures were executed against live services
on 3 October 2026 — Google's Gemini API on a free AI Studio key, and a
commercial gateway speaking Chat Completions. Connect, validate, list models,
text generation, streaming, tool calling, vision, an invalid credential, rate
limiting and an unsupported capability are all now observed rather than
awaited, and they are gone from your list.

That is the whole of row 6 below bar two items, and the reason it is worth this
much fuss is what those runs found. Three defects that had passed every one of
the 4,500 mocked cases in this repository, because a fixture accepts whatever
you send it — and one of them meant **the browser agent could not run on Gemini
at all**. `docs/testing/integration-readiness.md` has them. The two items that
remain are 87-07 (many tool calls inside one task) and 87-10 (a credential that
expires while in use), and both need a condition to arrange rather than a key
to buy.

The fifth move is **twenty-two down to twenty-one**, and it is small because
only one countable item was left to take. `87-07` was executed against the
live Gemini endpoint: three tool calls across two turns, with all three numbers
in the answer coming from tool results and none from the model's own idea of
the weather. `84-P-009` — answering from a real image — went with it, on a
question only the image could answer, though it was never in the count. Both
are in [RESULTS.md](../testing/acceptance/RESULTS.md).

**`87-10` is what remains, and it is hard rather than expensive.** It asks for
a credential that expires _while in use_. An API key does not expire on a
schedule, so no key can produce the condition — it needs an OAuth
authorization, whose access token lives about an hour. Which means **G-6
first**: it is blocked on the Google client id, like everything else there.

### A. With one API key — fourteen of the twenty-one

Any one of OpenAI-compatible, Anthropic or Gemini. Do these first: they are the
bulk of the list and they share one browsing session.

**Before working through row 6 by hand, run one command.** Nine of those twelve
provider items are now automated against a real vendor endpoint:

```bash
ABA_LIVE_PROTOCOL=anthropic ABA_LIVE_API_KEY=…   npx vitest run tests/integration/provider-live.test.ts
```

It makes a handful of small paid requests and covers connect, validate, list
models, text generation, streaming, tool calling, vision, an invalid credential
and part of the unsupported-capability item — plus a real tool-result round
trip that no written procedure asks for. Since that was written, 87-07 (many
tool calls in one task) and 87-11 (being genuinely rate limited) have both been
executed live — 87-11 found a defect — so **only 87-10 stays yours**, and it
needs an OAuth account rather than a key. The breakdown is in
[MATRIX.md](../testing/acceptance/MATRIX.md) and the honest status of every
external surface is in
[integration-readiness.md](../testing/integration-readiness.md).

| Order | Procedure  | What it establishes                                                                                                                                                                                                                                                                                                                                       |
| ----- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `84-P-001` | The panel opens beside the page and never obscures or reflows it — the one claim about Chrome's own side-panel chrome                                                                                                                                                                                                                                     |
| 2     | `85-A-1`   | Whether the summary of a real page is accurate and useful                                                                                                                                                                                                                                                                                                 |
| 3     | `85-B-1`   | A genuine three-tab comparison, with one tab closed mid-task                                                                                                                                                                                                                                                                                              |
| 4     | `85-C-1`   | Whether the diagnosis of a staged broken Save is correct                                                                                                                                                                                                                                                                                                  |
| 5     | `84-P-008` | Whether an answer really depended on the screenshot                                                                                                                                                                                                                                                                                                       |
| 6     | `87-10`    | The one provider item left: a credential that **expires while in use**. An API key does not expire on a schedule, so this needs an OAuth account — which means G-6 first. Eleven of the twelve were executed live on 2026-10-03; see [MATRIX.md](../testing/acceptance/MATRIX.md) and [RESULTS.md](../testing/acceptance/RESULTS.md)                      |
| 7     | `84-P-019` | Clicking the notification brings you to the panel at the right place                                                                                                                                                                                                                                                                                      |
| 8     | `84-P-020` | A schedule survives a full browser restart. **Narrowed:** the restart mechanism is now automated — a connected provider and its model selection are read back by a new browser process — so what is left is the _schedule_ specifically, which no automated test can create because every target it could use is correctly refused for unattended running |
| 9     | `91-D-3`   | Granting the optional `downloads` permission through Chrome's own dialog                                                                                                                                                                                                                                                                                  |
| 10    | `90-10`    | A dropped connection retries and then stops cleanly rather than hanging                                                                                                                                                                                                                                                                                   |
| 11    | `90-09`    | An extension reload: a torn-down content script is reported clearly                                                                                                                                                                                                                                                                                       |
| 12    | `90-08`    | A full browser quit and reopen — and the connector correctly needing re-authorization                                                                                                                                                                                                                                                                     |

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
sign-in, which needs a deployed backend. This one needs **no backend, no secret
and no deployment**: it is what lets a user press _Connect with Google_ and give
the agent a Gemini credential to run on. You can do this and skip G-1 entirely.

Twenty minutes. The fiddly part is the extension id, so that is step 1.

**One provider remains completely untested, and it is one command.**

Anthropic is the last protocol with no live verification: there is no Anthropic
key in this repository or on the development machine, so `api.anthropic.com`
has never been reached. Gemini and an OpenAI-compatible gateway both are
verified, and between them they produced five defects that every mocked test
had passed — two of which meant the agent could not run on Gemini at all.
There is no reason to assume Anthropic's own translation is clean.

```sh
ABA_LIVE_PROTOCOL=anthropic ABA_LIVE_API_KEY=… \
  npx vitest run tests/integration/provider-live.test.ts
```

No base URL is needed; the adapter defaults to `api.anthropic.com`, and **no
model id either** — the harness asks the vendor what the key can reach and
picks one that answers, preferring one that accepts a tool. Naming a model
would be guessing at a catalogue you have not seen, which is the mistake
Google's own list punishes. Twelve cases: discovery, connection, the capability doctor on a real model, a
completion, a stream, a two-turn tool round trip, many tool calls across
several turns, a real image, a listed-but-unrunnable model, and two asserting
the credential does not come back out.

**The harness's Anthropic path has already been verified**, so a failure will
be the provider or this build rather than the test. A local stand-in speaking
the Anthropic Messages protocol — `x-api-key`, `/v1/models`, `/v1/messages`,
`tool_use` and `tool_result` blocks, SSE events — was served on loopback and
the harness reached `AGENT_READY` through it with the full round trip passing;
a mutation that made the stand-in ignore the tool result failed the case meant
to catch it. That is recorded in
[RESULTS.md](../testing/acceptance/RESULTS.md) and is **not** evidence about
`api.anthropic.com`.

It spends a few cents of a real key. Nothing else in the repository needs one.

**What is already covered without it**, so a failure will be the provider or
this build rather than the test: 42 unit cases over connection (including
connecting before a model is chosen), the model-list envelope, request
formatting, response parsing, authentication, the error taxonomy and credential
redaction — and the harness's `anthropic` path driven against a loopback
stand-in speaking the Messages protocol, reaching `AGENT_READY` with the full
two-turn round trip, with a mutation that ignored the tool result caught by the
case meant to catch it.

---

**Before you start: you may not need this at all.** On 3 October 2026 the
Gemini **API key** path was exercised against the real
`generativelanguage.googleapis.com` and works end to end — 44 models
discovered, tool calling and streaming measured by the capability doctor. So a
working Gemini brain is available today for the price of a key from AI Studio,
with no Cloud project, no OAuth client and no extension id to pin. G-6 buys one
thing on top of that: a user connecting their own Google account without
handling a key. It is a convenience, not a dependency, and nothing in the
release waits on it.

Two things that live run settled, which this section used to leave you to find
out the hard way:

- **Google serves `:streamGenerateContent` on models whose `/models` entry no
  longer lists it.** The adapter used to read that absence as a denial and turn
  streaming off for every Gemini model. Fixed; mentioned here because if you
  ever compare the model list against what works, they will not agree.
- **Google's model list leads with three models it has retired.**
  `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-2.5-flash-lite` are all
  offered and all answer `404 … no longer available to new users`. Pick a
  `-latest` or a `3.x` id. The extension now says so when you hit one, instead
  of sending you to check the list that just offered it.

**And if the client is ever refused:** the extension now prints the exact
redirect URI it used in the failure message, so you can paste it straight into
the Google console rather than reconstructing it from the id on the
`chrome://extensions` card.

**What is repository work and already done:** the authorization flow, the PKCE
exchange, token renewal, the quota-project header, every refusal message, the
build-time configuration check, and the panel that reports the option
unavailable when no client id is compiled in. **What only you can do:** the
three things below that touch a Google account and a Cloud project. Nothing in
this repository can register a client, enable an API, or hold your credential.

#### 1. Decide which extension id you are registering, and get it

Google pins an OAuth client of this type to **one** extension id. An unpacked
build and a Web Store build have different ids, so a client registered for one
is refused for the other — the extension reports that as a build configuration
problem rather than blaming your Google account, but it still will not work.

```sh
npm run build
```

Then load `dist/` at `chrome://extensions` with **Developer mode** on and
**Load unpacked**. The id is the 32-character lowercase string on that card.
Copy it.

Register the id of the build you intend to test with. After publishing, the
Web Store assigns its own id and you register that one too — one client can
hold only one, so a published build needs its own client or its own id added
to a second client.

#### 2. In the Google Cloud console — the part only you can do

Everything here is on <https://console.cloud.google.com>, signed in with the
Google account whose Gemini access you want to use.

1. **Pick or create a project.** The project selector is at the top of the
   page. Note its **project ID** (a lowercase string, not the display name) —
   step 4 needs it. Usage will be billed to this project.
2. **Enable the Generative Language API** on that project. Search the console
   for "Generative Language API" and enable it. Without this, an authorized
   call is refused however correct the OAuth is.
3. **Create the OAuth client.** Go to the credentials page for your project,
   create a new **OAuth client ID**, and choose application type **Chrome
   Extension**. Paste the extension id from step 1. Google shows you a client
   id ending `.apps.googleusercontent.com` and **no client secret** — that is
   correct and expected: Google does not issue one for this client type, and
   this extension could not hold one safely if it did.
4. **On the consent screen**, add the scope
   `https://www.googleapis.com/auth/cloud-platform` and add your own Google
   account as a **test user**. While an app is unverified only test users can
   complete the flow. That is Google's rule, not a limitation here.

> The exact menu labels in the Cloud console change from time to time. The four
> things to achieve are the ones above: a project, the Generative Language API
> enabled on it, an OAuth client of type **Chrome Extension** bound to your
> extension id, and the `cloud-platform` scope with your account as a test
> user. If a label here does not match what you see, trust the goal rather than
> the wording, and tell us what it actually said.

#### 3. Configure the build, and check that the value took

Copy `.env.extension.example` to `.env` and fill the two values, or pass them
on the command line:

```sh
VITE_ABA_GOOGLE_PROVIDER_CLIENT_ID=<your-id>.apps.googleusercontent.com \
VITE_ABA_GOOGLE_QUOTA_PROJECT=<your-project-id> \
npm run build
```

**The quota project is not optional in practice.** Google documents that a
user-credential call to a client-based API must name a project for billing and
quota, and answers one that does not with a message about exactly that. Set it
to the project ID from step 2.1 — the extension sends it as
`x-goog-user-project` and never guesses it.

The build prints what it decided, and **refuses a value that is set and
unusable** rather than ignoring it. To check without producing a build:

```sh
node scripts/check-extension-env.mjs
```

A configured build reports `Google provider authorization: configured with
client id …`. An unconfigured one says so in those words. A typo fails the
build with a sentence naming the problem, because a value that is silently
ignored looks exactly like one that was never set.

You can also confirm it from a packaged artifact — `npm run release` prints
`google oauth: a client id IS compiled in` or `no client id`.

#### 4. What to actually test, in this order

Load the configured build, open Settings, choose **Google Gemini**, and press
**Connect with Google**. Five outcomes, each worth producing deliberately.

**4.1 — Decline the Chrome permission prompt.** Chrome asks because `identity`
is an optional permission. _Expected:_ the panel says nothing was changed, no
account appears in the list, and Google is never opened. Declining is a
supported answer, not an error.

**4.2 — Accept the prompt, then accept Google's consent screen.** _Expected:_
an account appears labelled _authorized with Google_, with **no model
selected** — that is deliberate — and the model list fills from what Google
says that project may use. If it is empty, the project almost certainly does
not have the Generative Language API enabled; see step 2.2.

**4.3 — Uncheck the requested access**, if Google offers the choice.
_Expected:_ the connection is refused with a sentence about authorizing again
and leaving the access selected. Nothing is stored. A token without
`cloud-platform` can neither list nor run a model, so storing it would produce
an account that looks connected and fails later.

**4.4 — The one test that closes the last unknown.**

This is the step nothing in the repository can do. Everything up to here proves
the authorization; this proves the authorization is **accepted by the Gemini
API for generating content**, which is the single thing still unverified.

1. On the account's row, press **Choose a model** if it has none, and pick
   one — the list is what Google offered in 4.2. `gemini-2.5-flash` is a good
   choice: it is inexpensive and it supports tool calling, which the agent
   requires.
2. Press **Run capability check**. _Expected:_ a report in which **tool calling
   passes**. The agent is enabled only when it does, because a model that
   cannot call tools cannot drive a browser. A model reported _Chat only_ is
   not a failure of the authorization — pick a different one.
3. Open any ordinary web page.
4. In the panel, run exactly this task:

   ```text
   Summarise this page in one sentence.
   ```

   One page read and one model turn: the smallest task that proves the agent
   reached the model through this credential. _Expected:_ a one-sentence
   summary, and the task reaching `COMPLETED`.

5. **Capture this evidence**, which is what makes the result reportable:

   - the capability check's verdict, including whether tool calling passed;
   - whether the task completed, and the summary it produced;
   - the model id you selected;
   - from Settings → Activity, the entries for that task — they name the
     provider and model used and carry no credential;
   - if anything failed, **Google's own message, verbatim**.

   **Do not capture** a token, an authorization code, a screenshot showing
   either, or the contents of your `.env`. None is needed and none is safe to
   paste anywhere.

6. If it completed, the last Gemini OAuth unknown is closed, and
   `docs/account-integration.md` should move that row from _unverified_ to
   _confirmed live_, naming the date and the model.

**4.5 — Revoke, and confirm the product notices.** Go to
<https://myaccount.google.com/permissions>, remove this extension's access,
then run another task. _Expected:_ the task refuses with a sentence telling you
to connect the Google account again, and the account's row shows it as
disconnected with that reason rather than staying green. An **Authorize again**
button appears on that row; pressing it re-authorizes **the same account**,
keeping your model choice, rather than adding a second row. Run the capability
check again afterwards — the previous measurement was taken with a credential
that no longer exists.

**What to record overall.** Which extension id, which project ID, the outcome
of each of 4.1 to 4.5, and the date. Never a token, a code, a screenshot of
either, or your `.env`.

#### 5. If something goes wrong, what it probably is

| What you see                                                   | What it is                                                                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google shows an error page instead of a consent prompt         | The extension id in the client registration does not match the build you loaded. Compare `chrome://extensions` against the console entry character by character. |
| The panel says this build carries no Google OAuth client id    | The value did not reach the build. Run `node scripts/check-extension-env.mjs`; if it says NOT configured, the variable was not set for that build.               |
| The build refuses with a message about the client id           | A typo. The id ends `.apps.googleusercontent.com`.                                                                                                               |
| The panel says Google did not accept this build's OAuth client | The same id mismatch as the first row, reported from the token exchange rather than the consent screen.                                                          |
| A task fails with something about a Cloud project              | Either `VITE_ABA_GOOGLE_QUOTA_PROJECT` is unset, or that project does not have the Generative Language API enabled, or the authorized account may not use it.    |
| Google refuses with something about test users                 | The consent screen has your account missing from its test users while the app is unverified.                                                                     |
| The model list in 4.2 is empty                                 | The project does not have the Generative Language API enabled, or the authorized account may not use it. Step 2.2.                                               |
| A task is `BLOCKED` rather than failing                        | The capability check has not passed for that model. Selecting a model does not measure it; step 4.4.2 does.                                                      |
| The row shows disconnected and tasks refuse                    | The authorization expired or was revoked. Press **Authorize again** on that row — it repairs the same account rather than adding a second.                       |

**One thing is genuinely unknown and step 4.4 settles it.** The extension sends
a bearer token and a quota project, and both the request path and the headers
match Google's documentation. A credential-free probe establishes that
`generateContent` itself accepts the bearer scheme — it answers a
non-credential literal with _"Expected OAuth 2 access token…"_, naming
`GenerativeService.GenerateContent`. What no probe can establish is whether a
**validly issued** token with a quota project is accepted for that method on a
given project configuration.

**Report exactly what Google said, including any error verbatim.** It is a
finding either way, and `docs/account-integration.md` keeps the four evidence
classes apart and has the row this belongs in.

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
