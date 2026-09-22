# Privacy policy — required content

The minimum a hosted privacy policy must state for this extension, drawn
entirely from [`data-flows.md`](data-flows.md), which was written against what
the code does rather than what a policy would like to say.

This is an outline of required content, not the policy itself. The policy
needs a URL, and a URL needs a host — an account-owner action.

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

Exactly five destination families, and the policy should list them:

1. The AI provider the user configured — OpenAI-compatible, Anthropic or
   Google Gemini. Receives the task, page content as enveloped data, and tool
   schemas.
2. A connector the user connected — currently GitHub only. Receives connector
   requests and the OAuth exchange.
3. The page the user is working on. Receives typed values, clicks, uploads.
4. Nothing else.
5. **In particular: no developer endpoint, no analytics, no crash reporting.**

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
- The user's identity — `chrome.identity` is genuinely unavailable
- Anything inside a cross-origin iframe — `all_frames` is false

## 6. Credential handling

- The API key is sent only to the provider it belongs to, as a header, never
  in a URL.
- Connector tokens are sent only to that connector's declared origins.
- Credential-shaped values are removed at the point of collection, before
  anything stores or displays them.
- **State the limit:** redaction is pattern-based. A credential in an
  unrecognised format under a non-sensitive key name can pass through. Saying
  so is better than a guarantee that cannot be kept.

## 7. Retention and deletion

- Data stays until the user deletes it or uninstalls the extension.
- Uninstalling removes all extension storage.
- The audit trail has a retention cap and evicts oldest-first.
- Connector tokens disappear when the browser closes.
- Say how a user clears things without uninstalling: disconnecting a provider
  clears its stored credential; disconnecting a connector clears its grant.

## 8. Children

The extension is not directed at children and collects nothing knowingly from
them. State whatever is true for your jurisdiction.

## 9. Changes and contact

- How changes to the policy will be communicated.
- A contact address that works. Review will check it.

## Hosting

The store requires a URL, not a file. Any of these satisfies it:

- GitHub Pages over this repository's `docs/`
- The raw GitHub URL of the published policy file
- Any page you control

The URL must be reachable without a login and must stay up for as long as the
listing does.

## The matching disclosure form

The policy and the dashboard's data-use form must agree. Mismatches are a
common rejection. The twelve answers are in
[`store-listing.md`](store-listing.md); the one that must be ticked is
**"collects website content"**.
