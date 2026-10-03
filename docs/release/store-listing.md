# Store listing draft

Copy for the Chrome Web Store listing, written against what this build
actually does. Every capability named here is implemented and tested; every
significant gap is stated rather than left for a user to discover.

Nothing here has been entered into a store dashboard. There is no listing.

---

## Item name

```text
AI Browser Agent
```

## Short description (132 character limit)

108 characters, from the manifest:

```text
A provider-agnostic browser agent. You choose the AI model; the extension supplies the browser capabilities.
```

## Developer / creator

```text
Created by Jamal Balya
```

This belongs in the **store listing only**. It is deliberately not in the
extension's own interface.

That used to be followed by "a check would be the wrong tool for that: the
string simply is not there". The reasoning was backwards, and it is the exact
shape this repository keeps finding — an absence nothing verifies is an absence
that comes back. Two checks now hold it:

- `tests/unit/about-link.test.ts` reads the **built bundle** and fails if
  "Created by" appears anywhere in it.
- `tests/e2e/standalone-ux.spec.ts :: the credit is a link and never a byline`
  reads the **rendered panel**, which is a different claim: a string can ship
  and never appear, and it is what a person sees that matters here.

## The credit that is in the interface

The extension's Settings screen ends with one icon linking to
`https://www.linkedin.com/in/jamalbalya`, and nothing else — no name, no
byline, no label beyond the accessible name "LinkedIn profile".

It is the **only** outbound link in the interface, and the same unit suite
censuses the panel source to keep it that way. The URL is a module constant, so
nothing a model produces, a page supplies or storage holds can redirect it; the
link carries `rel="noopener noreferrer"` and `target="_blank"`; and the glyph is
inline SVG, so it needs no network request and no CSP relaxation.

One thing for the account owner to confirm rather than for this repository to
decide: the mark is a simple rendering of the LinkedIn glyph, and LinkedIn
publishes brand guidelines for use of its logo. Whether the rendering as shipped
satisfies them is a judgement about someone else's trademark policy.

## Category

`Workflow & Planning`, or `Developer Tools`. Not chosen here — it affects
discovery, which is a judgement about audience rather than about the code.

## Detailed description

```text
AI Browser Agent gives your browser to an AI model you choose, and keeps the
safety controls out of that model's hands.

You supply the model — an OpenAI-compatible endpoint, Anthropic, or Gemini,
using your own API key. The extension supplies everything else: reading pages,
filling forms, clicking, navigating, working across tabs, inspecting the
console and network when something is broken, and asking you before anything
consequential happens.

WHAT IT CAN DO

• Read a page as structure, not as a screenshot — roles, labels and states,
  so the model works with what a screen reader would see.
• Fill forms: text, dropdowns, checkboxes, radios, multi-selects, and
  structured inputs like dates, times, colours and ranges.
• Click, scroll, wait, and navigate, re-checking the page each time.
• Work across several tabs, with each task owning the tabs it opened.
• Diagnose a broken page by reading its console and network activity.
• Upload a file you pick yourself, and download one if you allow it.
• Record a task you performed and replay it later.
• Run bundled skills, and name them as shortcuts.
• Connect GitHub to read and write issues, or Figma, Jira and Confluence to
  read from them, using a token you create in your own account.
• Keep an audit trail of every decision, which you can export.

HOW IT DECIDES WHAT IT MAY DO

Not by asking the model nicely. Every action is rated for risk and checked
against a policy the model cannot reach or change. Anything consequential
asks you first. Some things are refused in every mode, including payments,
entering card or identity details, submitting credentials into a page that
did not issue them, permanently deleting records, and defeating CAPTCHA.

If a page tries to hijack the agent — and pages do try — page content is
wrapped as data that cannot close its own envelope and become instructions.
The policy engine runs on what the browser actually did, not on what the
model was told.

Data that came from one site does not silently travel to another. The
extension tracks which sites a task has read from, and a request carrying
that data to somewhere else is blocked or asks you first. Credential-shaped
values are removed at the moment they are collected, before anything stores
or displays them.

WHAT YOU NEED

An API key for one of: any OpenAI-compatible endpoint, Anthropic, or Google
Gemini. The extension ships no key and no free tier, and sends your key only
to the provider you chose.

The model must support tool calling. The extension checks this when you
connect and tells you plainly if a model cannot drive a browser, rather than
starting a task that will fail halfway.

WHAT IT DOES NOT DO YET

Being straight about this up front, because discovering it after installing
is worse:

• Four connectors exist: GitHub, Figma, Jira and Confluence. There is no
  Google Sheets integration. Figma, Jira and Confluence are read-only, because
  none of those services tells the extension what a token may do — so rather
  than attempting a change and failing, it offers no way to make one.
• You connect each one with a token you create in your own account, not by
  signing in. Jira and Confluence also need your own site address, and your
  token is bound to that one address and can go nowhere else.
• No connector has been used against a real service from this repository. The
  paths are tested against local servers; what is untested is somebody else's
  production endpoint.
• Plugins are not implemented.
• MCP works as a client only. You can add a server in Settings and its tools
  and resources are offered to the model, confirmed on every call. It has been
  verified against the MCP project's own reference server; no server that
  somebody else operates has been reached from here, and the extension is never
  itself an MCP server.
• Scheduled tasks run only while Chrome is running. There is no cloud
  scheduler, so a schedule due while the browser is closed is skipped rather
  than caught up, and a scheduled run stops instead of approving anything on
  your behalf.
• It does not work inside cross-origin iframes — a form in an embedded frame
  is out of reach, deliberately, because reaching into every frame on every
  page is a much larger risk than the feature is worth.

PRIVACY

No telemetry. No analytics. No error reporting. Your data goes to the AI
provider you configured, to a connector you connected, and to the page you
are working on — nowhere else.

It does not read cookies, session tokens, passwords, browsing history or
bookmarks, and does not request the permissions that would let it. It cannot
browse your computer: there is no filesystem access, and a file reaches the
agent only when you pick it in Chrome's own file picker.

Everything it stores stays in your browser.
```

## Permission justifications

One per permission, as the dashboard asks. Each is what the code does, not a
rationale written to sound acceptable.

| Permission                                       | Justification to submit                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel`                                      | The extension's entire interface is a side panel.                                                                                                                                                                                                                                                                                                                                                                                      |
| `storage`                                        | Tasks, settings and the audit trail persist locally. MV3 evicts the service worker constantly, so in-memory state would lose a task mid-step.                                                                                                                                                                                                                                                                                          |
| `unlimitedStorage`                               | The audit trail and stored screenshots exceed the 10 MB default over normal use. Nothing is uploaded; the storage is local.                                                                                                                                                                                                                                                                                                            |
| `tabs`                                           | The agent acts on tabs the user names, and reports which tabs exist so the user can choose.                                                                                                                                                                                                                                                                                                                                            |
| `tabGroups`                                      | Results from a multi-tab task are grouped, using Chrome's own grouping.                                                                                                                                                                                                                                                                                                                                                                |
| `scripting`                                      | Injects the content script that builds the page model. It injects a fixed file, never a function or a string.                                                                                                                                                                                                                                                                                                                          |
| `debugger`                                       | Reads console output and network activity so the agent can diagnose a failing page. The CDP surface is a fixed allowlist containing no code-evaluation method, and no tool accepts a method name as an argument.                                                                                                                                                                                                                       |
| `notifications`                                  | Tells the user a task needs a decision when the side panel is closed.                                                                                                                                                                                                                                                                                                                                                                  |
| `activeTab`                                      | The access path that still works when a user restricts site access to "on click". Not redundant with host permissions for that reason.                                                                                                                                                                                                                                                                                                 |
| `alarms`                                         | Wakes the service worker when a scheduled task is due. One alarm for all schedules; MV3 gives no other way to run something at a chosen time. A scheduled run has no extra authority and stops if it needs the user's approval.                                                                                                                                                                                                        |
| `host_permissions` (`http://*/*`, `https://*/*`) | A browsing agent acts on whatever page the user points it at. Deliberately **not** `<all_urls>`, which would add `file://` and other extensions' pages, and `all_frames` is `false`, so cross-origin frames are never entered.                                                                                                                                                                                                         |
| `downloads` (optional)                           | Requested only when a task downloads a file, granted by the user from Settings. Not granted at install.                                                                                                                                                                                                                                                                                                                                |
| `identity` (optional)                            | Requested only when the user chooses to connect a Google account for the Gemini API, and declinable. Needed because `chrome.identity.launchWebAuthFlow` is the only way to receive Google's redirect for a Chrome Extension OAuth client. The manifest declares **no `oauth2` key**, so `getAuthToken` — the API that could reach the browser profile's own Google account — has no client id and cannot work. Not granted at install. |

### If review asks about `debugger`

It is the permission most likely to draw a question, because it can normally
execute arbitrary code in a page. Here it cannot, and the answer is specific:

- `src/tools/debugger/debugger-manager.ts` holds a fixed `ALLOWED_CDP_METHODS`
  list with no evaluator in it.
- No tool schema accepts a CDP method name, so a model cannot name one.
- `tests/security/debugger-allowlist.test.ts` covers the surface, and
  `tests/security/security-invariants.test.ts` fails the build if
  `Runtime.evaluate` is ever added to the allowlist.

## Data disclosure answers

| Dashboard question                                            | Answer                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Sells user data                                               | No                                                                                                                |
| Uses data for purposes unrelated to the item's single purpose | No                                                                                                                |
| Uses data to determine creditworthiness or for lending        | No                                                                                                                |
| Collects personally identifiable information                  | No                                                                                                                |
| Collects health information                                   | No                                                                                                                |
| Collects financial and payment information                    | No                                                                                                                |
| Collects authentication information                           | No                                                                                                                |
| Collects personal communications                              | No                                                                                                                |
| Collects location                                             | No                                                                                                                |
| Collects web history                                          | No                                                                                                                |
| Collects user activity                                        | No                                                                                                                |
| Collects website content                                      | **Yes** — page content of a page the user asked the agent to work on, sent to the AI provider the user configured |

The last row is the one that must be ticked. Page content is website content,
it is transmitted, and saying otherwise because it is transient would be
false. The detailed description and the privacy policy both say so plainly.

### One answer is a judgement the owner has to make: authentication information

**This answer says "No" and has never been reasoned about in writing.** It is
recorded here rather than changed, because the form is submitted by the owner
and the question is about Google's definition rather than about this code.

What the extension actually does with credentials:

- it stores an **API key** the user pastes, locally, and sends it to the
  endpoint that key belongs to as a request header;
- for a Google-authorized Gemini account it stores an **access token and a
  refresh token**, locally, and sends the access token to Google;
- none of it reaches the developer, a log, an audit record, evidence, a task
  record, a model prompt, or a URL — and `tests/security/credential-boundary.test.ts`
  is what holds that.

### What Chrome's own policy says, read rather than remembered

This section used to quote the definition without citing where it came from,
which is a thin footing for a declaration somebody signs. Read from the source
on 4 October 2026 —
[Chrome Web Store user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
— three statements matter, and two of them were not in this document before:

1. **The category.** _"Authentication information"_ is defined as _"logins,
   password, and authentication cookies"_.
2. **The threshold is handling, not collecting.** _"Handle"_ means
   _"collecting, transmitting, using, or sharing user data."_
3. **Local-only storage is explicitly not an exemption.** _"Extensions are
   required to disclose how they handle user data, even when data is processed
   or stored locally on a user's device and is not transmitted to external
   servers or third parties."_

**Statements 2 and 3 remove most of the "No" case**, and they were the parts
this document had been missing:

| Argument previously made for "No"                  | What the policy text does to it                                                                                                        |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| "Nothing is _collected_"                           | The threshold is **handle** — collecting, transmitting, using **or** sharing. The extension transmits these credentials and uses them. |
| "They stay on the user's device"                   | Explicitly not an exemption: disclosure is required for data stored locally and never transmitted.                                     |
| "It is the user's own key, not gathered from them" | Provenance is not in the definition. Where the data came from does not change whether it is handled.                                   |

What genuinely survives for "No" is narrower than it looked, and it is only
this: an **API key** is arguably none of the three named examples — not a
login, not a password, not a cookie. That argument does not extend to the other
credential this extension holds. A Google **OAuth access and refresh token**
is, in function, exactly what an authentication cookie is: a bearer artefact
that proves an authenticated session to a service. And the extension holds one
whenever a user takes the Google path.

**Whichever is chosen, the policy and the form must agree**, because a mismatch
between them is a common rejection. That constraint used to carry a cost: a
"Yes" would have needed a sentence in the hosted policy that was not there yet.
It no longer does. The published policy, read on 3 October 2026, already says

> "A credential the user supplies is stored locally and is sent only to the
> service it belongs to."

and names the Google case explicitly — _"Google access and refresh tokens, for
a Google-authorized Gemini connection, are stored the same way"_ — alongside
_"No credential is written to the audit trail, to evidence, to a task record,
to a log, to anything sent to an AI provider."_

So **both answers are consistent with what is published**, and neither requires
a policy change before submitting. The decision stays the owner's, because it
is about Google's definition rather than about this code; what has changed is
that it can no longer produce a form/policy mismatch, and nothing downstream is
waiting on it.

### Wording you can use, whichever way you answer

Factual sentences, for the justification box beside the answer. They describe
what the extension does and take no position on the question — so the same
facts support either answer, which is the point.

**If you answer "No":**

> The extension does not collect authentication information. It has no login
> of its own and creates no account. An API key the user obtains from their own
> AI provider, and — for a Google-authorized Gemini connection — the OAuth
> access and refresh tokens issued to that user, are stored in the browser's
> own extension storage on the user's device and sent only to the provider they
> belong to, as request headers. None of it is transmitted to the developer or
> to any third party, and nothing is collected from the user's accounts.

**If you answer "Yes":**

> The extension stores authentication information supplied by the user: an API
> key the user obtains from their own AI provider, and — for a Google-authorized
> Gemini connection — the OAuth access and refresh tokens issued to that user.
> Both are held in the browser's own extension storage on the user's device and
> sent only to the provider they belong to, as request headers. Neither is
> transmitted to the developer or to any third party, and the extension has no
> login of its own.

**What makes the two answers both defensible**, stated once so the choice is
informed rather than arbitrary:

| Reading                                                                               | Rests on                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No** — nothing is _collected_                                                       | Chrome's examples are _"logins, passwords, and authentication cookies"_. The user's own API key is none of those, nothing is gathered _from_ their accounts, and there is no login to this extension. |
| **Yes** — an OAuth token is authentication information, and the extension handles one | Chrome's guidance names _"having login functionality, even if using a third-party system like Google authentication"_, and this build does run a Google authorization flow for Gemini.                |

Both sentences above are true of the implementation and verifiable from it:
`tests/security/credential-boundary.test.ts` holds that no credential reaches
the audit trail, evidence, a task record, a log, a model prompt or a URL, and
`docs/release/data-flows.md` lists every destination a credential is sent to.

### A recommendation, which is not a decision

Asked for one, here it is. **Answer "Yes".** The decision remains the owner's —
the form is submitted by a person who can be held to it — but the reasoning has
changed since this recommendation was first written, and it is worth saying how.

It used to lead on the asymmetry of being wrong: an understated "No" is a
rejection, an overstated "Yes" costs nothing. That is still true and is now the
**weakest** of the reasons, because reading Chrome's own policy text supplied
better ones:

1. **The form's threshold is "handle", and the policy defines handle as
   "collecting, transmitting, using, or sharing".** The extension transmits
   these credentials to their providers on every request and uses them to
   authenticate. That is handling on Chrome's own definition, and no reading of
   "we never collect anything" changes it.
2. **"It stays on the device" is explicitly ruled out as an exemption.**
   Disclosure is required _"even when data is processed or stored locally on a
   user's device and is not transmitted to external servers or third parties"_.
   This extension's whole storage design is local-first, so that sentence is
   aimed squarely at it.
3. **One of the two credentials is squarely in the category.** A Google OAuth
   access or refresh token is functionally what an authentication cookie is: a
   bearer artefact proving an authenticated session. The named examples cover
   it even if they do not obviously cover an API key.
4. **Nothing is lost by answering "Yes".** Both answers are consistent with the
   published policy, so it requires no policy change and forecloses nothing.
   The data-use form is a disclosure, not a constraint on what you may ship.

**What still argues for "No"**, so the choice is informed: an API key is
literally none of the three named examples, and if the Google path were removed
the question would be genuinely close. It is not removed. "No" is the answer
currently recorded, and the case for it is narrower than this document
previously presented.

**Either way the justification text matters more than the checkbox**, because
it is what a reviewer reads. Use the wording above verbatim; it is true of the
implementation and verifiable from
`tests/security/credential-boundary.test.ts` and
`docs/release/data-flows.md`.

**This repository has not changed the declaration.** It is recorded as "No",
the recommendation above is a recommendation, and a declaration nobody chose
would be worse than either answer.

#### What changed on 4 October 2026: the Google path is registered, the artifact still is not

The owner registered a Google OAuth client and put its id in `.env`. That moves
one fact in the table above from hypothetical to real, and leaves another in
place, and the difference decides nothing by itself — but it does mean **the
declaration and the artifact have to be chosen together.** Measured, not
assumed:

| Fact                                                            | Evidence                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A Google OAuth client now exists and Google recognises it       | The authorization endpoint answers this client id with `redirect_uri_mismatch`, not `invalid_client`     |
| A build configured with it **does** offer _Connect with Google_ | `accounts.authMethods` returns `configured: true` in real Chromium (`google-provider-auth.spec.ts`)      |
| The **release artifact** still carries no client id             | `validate-release` reports _"no client id"_; the zip is byte-identical to the one built before this work |

So for the artifact as it stands today, an installer cannot reach the OAuth
path at all, and the only credential the extension handles for them is an API
key they paste — which is the one credential for which "No" was ever arguable.
For a build that carries the client id, the extension handles a Google **access
and refresh token**, and the case for "No" loses the only ground it had.

**The recommendation does not change: answer "Yes".** It is now firmer rather
than different. Reasons 1 and 2 above — handling includes transmitting and
using, and local storage is not an exemption — never depended on the Google
path, and they apply to the API key alone. Reason 3 now applies to a build the
owner can actually produce.

**What this does add is a sequencing constraint.** If the submitted artifact
ever carries the client id, "Yes" stops being a judgement and becomes the only
defensible answer. Deciding the declaration before deciding which build is
submitted gets those two out of order.

### One other answer worth taking deliberately: "Collects web history"

Recorded as **No**, and that is probably right — but the third policy statement
above (local storage is not an exemption) removes one of the reasons it looked
obviously right, so it deserves a deliberate answer rather than an inherited
one.

**What the extension actually stores.** A task record persists, per tab the
task touched, the `url`, the `origin`, whether the agent opened it, and a
`lastObservedAt` timestamp. The audit trail records a `site` per decision. All
of it local, all of it visible in the panel, and all of it removed when the
task or the profile is deleted. Chrome's own description of the category — a
list of pages visited with associated data such as the time of visit — is not a
bad description of that.

**Why "No" is still the better answer.** Three facts, each checkable:

- **The extension cannot read browsing history at all.** `history` is not in
  the manifest (neither required nor optional), and `chrome.history` appears
  nowhere — not in the source, and zero times in the built bundles. The
  narrower claim is deliberate: an earlier draft of this line said the _string_
  "history" does not appear in the bundles, and that was wrong. It does, in
  `sidepanel.js`, as a CSS class name (`history`, `history__list`,
  `history__item`), a React transition type, and the panel's own list of the
  user's **tasks**. None of those is a browsing record, and overstating a
  checkable fact is how a true conclusion acquires a false reason. That is not merely printed and hoped
  for: several Chromium tests read `chrome.runtime.getManifest()` in the live
  worker and assert the **exact sorted permission list**, so adding `history`
  fails the suite rather than slipping past a reviewer's eye.
- **The scope is a task, not a session.** What is stored is the pages one task
  the user asked for actually worked on — the record of the work, not a trace
  of the person's browsing. A reviewer comparing the two would be comparing
  "what did this task do" with "where has this user been".
- **The page data itself is already declared.** "Collects website content" is
  **Yes**, which is the honest disclosure of the thing a reviewer would
  actually care about. A URL in the task record beside it adds no undisclosed
  category.

**Owner action: none required, but answer it on purpose.** If a reviewer
queries it, the reply is the three facts above — not "it stays on the device",
which the policy text rules out as a reason.

Supporting detail is in [`data-flows.md`](data-flows.md), category by
category.

## Single purpose

```text
Let a person give a browsing task, in natural language, to an AI model of
their own choosing, and have the extension carry it out in their browser
under their supervision.
```

Provider-agnosticism serves that purpose rather than adding a second one: the
user supplies the model, the extension supplies the browser capabilities and
the safety controls.

## Supported browser

Chrome 116 or later (`minimum_chrome_version`), or a Chromium browser
supporting Manifest V3 and the Side Panel API.

## Known limitations to state in the listing

Already in the detailed description above. Repeated here as a checklist so
none is quietly dropped when the copy is edited:

- Four connectors (GitHub, Figma, Jira, Confluence), three of them read-only,
  each connected with a token you supply. None exercised against a real
  service.
- No plugins. MCP is client-side only, and has been verified against the MCP
  project's own reference server, not against a server somebody else operates.
- Scheduled tasks exist, but only while Chrome is running.
- No cross-origin iframe support.
- Requires a tool-calling model and the user's own API key.
- Three of forty specification capabilities are partial; one is not started.
- No Google sign-in in this build. The product has one, but it needs a backend
  that is not deployed, so the option is absent rather than offered and
  broken. Everything the extension does works without it.
- **Requires your own AI account, and no account here.** You connect an AI
  provider with a key you create, or — for Google's Gemini API only — by
  authorizing your Google account. There is nothing to sign up for to use the
  extension.
- **Connecting Google does not find your other AI accounts.** No AI provider
  offers a way to list the accounts a Google identity holds elsewhere, and this
  extension does not imply one. Models _are_ discovered — from the endpoint,
  once an account has a credential.
- **Google authorization is unavailable in this build**, because it carries no
  Google OAuth client id. The panel says so and offers the Gemini API key path
  instead. Every other provider is connected with a key and is unaffected.
- `identity` is an **optional** permission, requested only if you choose to
  connect a Google account, and declinable.

## What is NOT claimed anywhere in this copy

- Capability parity with any other product.
- Any connector that does not exist.
- Any provider validated against its live endpoint — all three are tested
  against local servers implementing their documented wire formats.
- Any acceptance procedure that is still blocked having passed. The matrix
  records forty-five PASS and no FAIL; thirty-two remain blocked on a
  credential, an OAuth application or a person at a browser, and four name
  capabilities that do not exist here.
- Chrome Web Store approval or publication.
