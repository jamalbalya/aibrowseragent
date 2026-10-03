# Privacy policy — required content

The minimum a hosted privacy policy must state for this extension, drawn
entirely from [`data-flows.md`](data-flows.md), which was written against what
the code does rather than what a policy would like to say.

This is an outline of required content, not the policy itself. The published
policy it was written for is at <https://about.jamal-balya.workers.dev/en/privacy>.

## The one thing that must not be claimed

**Do not write "this extension collects no data".** It is false, and a store
reviewer can disprove it in a minute by reading the manifest.

Website content leaves the browser. When a user gives a task about a page, the
page's text and structure are sent to the AI provider that user configured.
That is website content, it is transmitted to a third party, and it is the
extension's central function. A policy claiming otherwise is a false statement
in a legal document, and on the store's data-disclosure form it is a false
attestation.

The accurate strong claim — and it is a strong one — is: **no telemetry, no
analytics, no error reporting, and no data to the developer.** Everything that
leaves goes to a service the user chose and configured. That is checkable in
the code and defensible under questioning.

## 1. Who the policy is from

Identify the publisher. This must match the Chrome Web Store developer account
name, or review will query it.

## 2. What is collected, and when

State each category, with its trigger. Not "may collect" — say what happens.

| Category                                            | When                                              | Must be disclosed |
| --------------------------------------------------- | ------------------------------------------------- | ----------------- |
| Page content: text, structure, interactive elements | when the user gives a task involving that page    | **yes**           |
| Screenshots of a page                               | when a task needs one                             | **yes**           |
| Console output, network activity, rendered markup   | when a task uses the diagnostic capability        | **yes**           |
| Task history: prompts, steps, outcomes              | always, per task                                  | **yes**           |
| Provider API key                                    | when the user enters one                          | **yes**           |
| Connector OAuth tokens                              | after the user authorizes a connector             | **yes**           |
| Files the user picks                                | when the user chooses one in Chrome's file picker | **yes**           |
| Site approval rules                                 | when the user approves a site                     | yes               |
| Audit records                                       | one per tool dispatch                             | yes               |

State plainly that page reading happens **because the user gave a task about
that page**, not in the background and not on pages merely visited.

## 3. Where it is stored

| Where                    | What                                                                                                                 | Survives a browser restart           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `chrome.storage.local`   | tasks, audit trail, evidence, settings, site rules, workflows, shortcuts, health, write claims, **provider API key** | yes                                  |
| `chrome.storage.session` | **connector OAuth tokens**                                                                                           | no — cleared when the browser closes |
| Service worker memory    | uploaded file bytes, per task                                                                                        | no                                   |

All local to the user's browser. Nothing is stored on any server the
developer controls, because there is no such server.

Disclose the asymmetry rather than glossing it: the provider API key is
written to disk so the user does not re-enter it every restart; the connector
token is held in memory so a bearer credential does not persist. Both are
namespaced away from ordinary settings and neither is ever logged.

## 4. What leaves the browser, and to whom

**This section said "exactly five destination families" and named GitHub as the
only connector. Both were true when it was written and neither is now** — the
count is the kind of number that ages silently, which is why
[`data-flows.md`](data-flows.md) is the authority and this is a summary of it.

The current set, which the policy should describe:

1. **The AI provider the user configured** — an OpenAI-compatible endpoint,
   Anthropic, or Google Gemini. Receives the task, page content as enveloped
   data, and tool schemas.
2. **A connector the user connected** — GitHub, Figma, Jira or Confluence.
   Receives connector requests carrying a token **the user created in their own
   account**. Not an OAuth exchange: this section used to say otherwise, and no
   connector uses one.
3. **The user's own Atlassian site**, for Jira and Confluence — the only
   destination that is not fixed in the build, because the user types it.
4. **Google's authorization endpoints** — `accounts.google.com` and
   `oauth2.googleapis.com` — and only if the user chooses to connect a Google
   account for the Gemini API. These carry an authorization code, a PKCE
   verifier or a refresh token, and **no page content and no task data in any
   shape**. A user who connects every provider with a pasted key reaches
   neither.
5. **The page the user is working on.** Receives typed values, clicks, uploads.
6. Nothing else.
7. **In particular: no developer endpoint, no analytics, no crash reporting.**

State that data sent to a provider is then governed by **that provider's**
terms, not this policy. The extension decides whether data may leave and to
where; it cannot govern what happens afterwards. A user choosing a provider is
choosing those terms.

## 5. What is never accessed

Frame these as absences of capability, with the reason, because that is what
makes them verifiable:

- Cookies and session tokens — the `cookies` permission is not requested
- Browsing history — the `history` permission is not requested
- Password field values — excluded from the page model by type
- Bookmarks — the `bookmarks` permission is not requested
- Local files — no filesystem API exists; Chrome itself refuses `file://`
- Anything inside a cross-origin iframe — `all_frames` is false

**One item was removed from this list because it stopped being true, and
publishing it would now be a false statement in a legal document.** It read
_"The user's identity — chrome.identity is genuinely unavailable"_ (written here
without the backticks it had, so that the consistency guard does not read a
quotation of a false sentence as an assertion of one). The
`identity` permission is now declared, as an **optional** permission, for one
purpose: `chrome.identity.launchWebAuthFlow` is the only thing that can receive
Google's redirect for a Chrome Extension OAuth client, so it is what lets a
user authorize a Google account for the Gemini API.

What the policy must say instead is narrower and still strong:

- The permission is **not granted at install.** Chrome asks for it at the
  moment the user presses _Connect with Google_, they can decline, and they can
  withdraw it afterwards. A user who connects every provider with a pasted key
  never grants it.
- It does **not** give access to the browser profile's own signed-in Google
  account. The API that would — `getAuthToken` — reads its client id from the
  manifest's `oauth2` key, and this extension declares none, so it has nothing
  to work with. A real-Chromium test calls it and asserts no token comes out.
- Authorizing a Google account is **not a sign-in to this extension**, creates
  no account with the developer, and is not required to use anything.

## 6. Credential handling

- The API key is sent only to the provider it belongs to, as a header, never
  in a URL.
- Connector tokens are sent only to that connector's declared origins.
- Credential-shaped values are removed at the point of collection, before
  anything stores or displays them.
- **State the limit:** redaction is pattern-based. A credential in an
  unrecognised format under a non-sensitive key name can pass through. Saying
  so is better than a guarantee that cannot be kept.
- A Google-authorized Gemini connection holds an **access token and a refresh
  token** rather than a key. Both are credentials, both are stored the same way
  and encrypted by the same optional local protection, and neither is ever
  displayed, logged or put in a URL. Revoking the extension's access at
  <https://myaccount.google.com/permissions> ends it from Google's side;
  disconnecting the account ends it from this side and removes both tokens.
- A Google-authorized request also carries the **name of the Google Cloud
  project** the usage is metered against, because Google requires a
  user-credential call to name one. It is configured when the extension is
  built, is not read from the user's Google account, and says nothing about the
  user.

## 7. Retention and deletion

- Data stays until the user deletes it or uninstalls the extension.
- Uninstalling removes all extension storage.
- The audit trail has a retention cap and evicts oldest-first.
- Connector tokens disappear when the browser closes.
- Say how a user clears things without uninstalling: disconnecting a provider
  clears its stored credential; disconnecting a connector clears its grant.
- **The published page now understates this, because the extension improved
  after it was written.** It says _"Revoking the extension's access in the
  permissions page of the user's Google Account ends it from Google's side"_ —
  true, and once the only way. Since `52211d7`, disconnecting a
  **Google-authorized** account also asks Google to withdraw the grant:
  `accounts.disconnect` posts the refresh token to
  `https://oauth2.googleapis.com/revoke` before deleting it locally, because
  deleting it first would destroy the token revocation needs.

  This is an **under-statement, not a misstatement** — the page promises less
  than the extension does, which is the safe direction for a policy and not
  urgent. It is still a mismatch with behaviour. The sentence to add, which is
  deliberately careful about what is guaranteed:

  > Disconnecting a Google-authorized account also asks Google to withdraw the
  > authorization. If Google cannot be reached the authorization may remain
  > listed in your Google Account, where you can revoke it yourself; the
  > credential is deleted from this device either way.

  The hedge matters and is not padding: revocation is attempted once and never
  allowed to block a disconnect, so a person asking to disconnect always
  does — and the grant can therefore outlive the tokens if Google is down.
  Claiming an unconditional revocation would be the one thing this document's
  opening forbids.

  Owner action: add that sentence to the deployed page in the `about-jamal`
  repository and move `EFFECTIVE_DATE`. Not required before submission, because
  nothing currently published is false.

## 8. Children

The extension is not directed at children and collects nothing knowingly from
them. State whatever is true for your jurisdiction.

## 9. Changes and contact

- How changes to the policy will be communicated.
- A contact address that works. Review will check it.

## Where it is published, and how to update it

**The policy is already published, and this section used to say "any page you
control" — which was the right advice before one was chosen and is no help
now.** The hosted page the Chrome Web Store listing points at is:

<https://about.jamal-balya.workers.dev/en/privacy>

It is produced by a **different repository**, `jamalbalya/about-jamal`, and
nothing in this repository can change it. What follows was read from that
repository rather than assumed, and the owner is the only one who can run it.

|                 |                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository      | `jamalbalya/about-jamal`                                                                                                                                                                                                                                                        |
| The policy text | `src/lib/content/privacy.ts` — a content module, **English only** and deliberately so: _"a translated policy is a second policy, and if the two ever disagree about what the extension does with a user's data, the disagreement is the developer's problem, not the reader's"_ |
| The date        | `EFFECTIVE_DATE` in that same file, which **must move with any change to the substance** — the policy's own section 12 promises a revised date on every update                                                                                                                  |
| The record      | a `CHANGELOG.md` entry, which that file's header requires for the same reason                                                                                                                                                                                                   |
| Its own tests   | `tests/unit/privacy.test.ts` — section count and order, unique fragment ids, no empty section, the product name, a fully-specified date, reachability in every locale, and that the published build needs no account                                                            |

### The procedure

1. In `jamalbalya/about-jamal`, edit `src/lib/content/privacy.ts`. The two
   additions this extension now requires are in §5 and §6 above: the
   **optional `identity` permission** and what it is not, and that a
   Google-authorized request carries the **Cloud project name**.
2. Move `EFFECTIVE_DATE` to the day of the change.
3. Add a `CHANGELOG.md` entry saying what changed.
4. Run that repository's own checks and preview it locally:

   ```sh
   npm test
   npm run cf:preview
   ```

   `npm test` includes the policy's own test file, which is what catches a
   malformed section or a date that did not move.

5. Deploy:

   ```sh
   npm run cf:deploy
   ```

6. **Verify the live page, rather than assuming the deploy landed.** Fetch it
   and look for both the new text and the new date:

   ```sh
   curl -s https://about.jamal-balya.workers.dev/en/privacy | grep -i 'identity\|effective'
   ```

   A page without the new effective date is a cached or failed deploy, not a
   published policy.

7. Only then paste the URL into the Chrome Web Store dashboard. The published
   page is what a reviewer reads; `docs/PRIVACY.md` in this repository is the
   code-level account of the same behaviour and is not what the listing points
   at.

**Do not** treat a repository change as publication. Until step 6 shows the new
text at that URL, the policy a reviewer would read is the old one.

## What must stay synchronized with the extension's behaviour

Two sentences on the published page describe behaviour the extension can
change, so they are the ones to re-read after any credential or deletion work.
Listed here because the page lives in another repository and nobody looking at
this one would otherwise know which lines are load-bearing.

| Published sentence                                                                                                   | What would falsify it                                                                   | Status                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| _"A credential the user supplies is stored locally and is sent only to the service it belongs to."_                  | Sending a credential anywhere else — a telemetry endpoint, a backend, a second provider | True. `tests/security/credential-boundary.test.ts` and `data-flows.md` |
| _"Revoking the extension's access in the permissions page of the user's Google Account ends it from Google's side."_ | The extension revoking the grant itself, which it now does                              | **Understated** — see the retention section above for the replacement  |

Chrome's own policy text, read 4 October 2026, is also worth keeping beside
this: _"Handle"_ means _"collecting, transmitting, using, or sharing user
data"_, and disclosure is required _"even when data is processed or stored
locally on a user's device and is not transmitted to external servers or third
parties"_. A policy that leans on "it never leaves the device" is leaning on
something the policy explicitly does not accept as an exemption. The published
page does not lean on it; `store-listing.md` records where this repository used
to.

## The matching disclosure form

The policy and the dashboard's data-use form must agree. Mismatches are a
common rejection. The twelve answers are in
[`store-listing.md`](store-listing.md); the one that must be ticked is
**"collects website content"**.
