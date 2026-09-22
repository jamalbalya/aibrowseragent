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
• Connect to GitHub to read and write issues.
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

• Only one connector exists: GitHub. There is no Jira, Confluence, Figma or
  Google Sheets integration.
• Scheduled and recurring tasks are not implemented.
• Plugins and MCP are not implemented.
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

| Permission                                       | Justification to submit                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidePanel`                                      | The extension's entire interface is a side panel.                                                                                                                                                                              |
| `storage`                                        | Tasks, settings and the audit trail persist locally. MV3 evicts the service worker constantly, so in-memory state would lose a task mid-step.                                                                                  |
| `unlimitedStorage`                               | The audit trail and stored screenshots exceed the 10 MB default over normal use. Nothing is uploaded; the storage is local.                                                                                                    |
| `tabs`                                           | The agent acts on tabs the user names, and reports which tabs exist so the user can choose.                                                                                                                                    |
| `tabGroups`                                      | Results from a multi-tab task are grouped, using Chrome's own grouping.                                                                                                                                                        |
| `scripting`                                      | Injects the content script that builds the page model. It injects a fixed file, never a function or a string.                                                                                                                  |
| `debugger`                                       | Reads console output and network activity so the agent can diagnose a failing page. The CDP surface is a fixed allowlist containing no code-evaluation method, and no tool accepts a method name as an argument.               |
| `notifications`                                  | Tells the user a task needs a decision when the side panel is closed.                                                                                                                                                          |
| `activeTab`                                      | The access path that still works when a user restricts site access to "on click". Not redundant with host permissions for that reason.                                                                                         |
| `host_permissions` (`http://*/*`, `https://*/*`) | A browsing agent acts on whatever page the user points it at. Deliberately **not** `<all_urls>`, which would add `file://` and other extensions' pages, and `all_frames` is `false`, so cross-origin frames are never entered. |
| `downloads` (optional)                           | Requested only when a task downloads a file, granted by the user from Settings. Not granted at install.                                                                                                                        |

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

- One connector only (GitHub).
- No scheduled tasks, plugins or MCP.
- No cross-origin iframe support.
- Requires a tool-calling model and the user's own API key.
- Seven of forty specification capabilities are partial; three are not started.

## What is NOT claimed anywhere in this copy

- Capability parity with any other product.
- Any connector that does not exist.
- Any provider validated against its live endpoint — all three are tested
  against local servers implementing their documented wire formats.
- Any manual acceptance procedure having passed. Fifteen are written; none has
  been executed.
- Chrome Web Store approval or publication.
