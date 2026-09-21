# Security

The security control plane is independent of the AI provider. Changing model
or provider changes how the agent reasons; it cannot change what the agent is
permitted to do.

Security does not depend on the model behaving well. Every control below is
enforced by code the model cannot reach, and every one has tests that attempt
to defeat it (`tests/security/`).

---

## Threat model

| #   | Threat                                            | Control                                         | Verified by                                          |
| --- | ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| T1  | Prompt injection via page content                 | Structural data envelope + independent policy   | `prompt-injection.test.ts`                           |
| T2  | Data exfiltration to an attacker endpoint         | Taint tracking + exfiltration guard             | `exfiltration.test.ts`                               |
| T3  | Credential leakage into logs, evidence or prompts | Redaction at collection time                    | `secret-redaction.test.ts`                           |
| T4  | Origin swap between planning and execution        | Re-validation before every action               | `origin-validation.test.ts`, `browser-tools.test.ts` |
| T5  | Model requesting an unauthorised tool             | Registry is the only path; schema + policy gate | `tool-registry.test.ts`                              |
| T6  | Arbitrary code execution via DevTools             | Method allowlist; no tool accepts a method name | `debugger-allowlist.test.ts`                         |
| T7  | Hallucinated or malformed tool arguments          | Zod validation before the implementation runs   | `tool-registry.test.ts`                              |
| T8  | Permission bypass through a permissive mode       | Hard floors that no mode lowers                 | `policy-engine.test.ts`                              |
| T9  | Acting on the wrong tab                           | Per-task tab ownership; tab identity re-checked | `tab-tools.test.ts`                                  |
| T10 | Runaway task burning cost or causing harm         | Budgets, loop detection, cancellation           | `agent-runtime.test.ts`                              |
| T11 | Task resumed blind after a worker restart         | Interrupted tasks parked, not resumed           | `task-persistence.test.ts`                           |
| T12 | Unanswered approval treated as consent            | Prompt timeout resolves as denial               | `permission-broker.test.ts`                          |

---

## T1 — Prompt injection

**The defence is structural, not detection-based.**

A detector can be phrased around. Anything that stands between a hostile page
and a tool call must not be defeatable by rewording, so the actual boundary is:

1. All external content is wrapped in a labelled envelope carrying its
   provenance and trust level (`untrusted_external_content`).
2. The payload has envelope markers neutralised, so a page cannot close the
   envelope early and escape into the instruction channel. This is the
   load-bearing part.
3. The system instruction states that envelope contents are data, are never
   instructions, and are never evidence of permission.
4. **The policy engine enforces the same rules independently.** A model that
   ignores the instruction entirely still cannot act outside policy, because
   policy runs on facts the runtime observed, not on model assertions.

`scanForInjection()` scores content for injection-shaped language. It is
**advisory only** — it surfaces a warning in the UI and the audit record. It
never gates execution, because a bypassed heuristic must not translate into
elevated trust.

### Trust hierarchy

```text
system policy  >  user intent  >  agent runtime  >  authenticated connector
               >  authenticated application  >  browser UI
               >  untrusted external content
```

`canIssueInstructions()` returns true only for the top three. External content
never qualifies, whatever it says about itself.

---

## T2 — Data exfiltration

The guard answers one question: _is this call about to move data from a private
source to a destination that did not produce it?_

It operates on **taint the runtime recorded** — which sources this task has
actually read from — not on model intent. A model convinced it has permission
still cannot move the data.

| Condition                                                        | Verdict                              |
| ---------------------------------------------------------------- | ------------------------------------ |
| Payload contains credential-shaped data                          | **Block**, regardless of destination |
| Confidential/secret data → a site that is not one of its sources | **Confirm** (elevated)               |
| Internal data crossing sites                                     | **Confirm**                          |
| Data returning to the site it came from                          | Allow                                |
| Nothing private has been read                                    | Allow                                |

Credentials are blocked even when the destination looks legitimate, because the
agent has no way to verify that it is.

An elevated confirmation is deliberately **one-off**: "Always allow on this
site" is not offered, because a standing grant is exactly what an injected page
would try to obtain.

---

## T3 — Secret redaction

Redaction happens **at collection time**, not at read time. A credential must
never sit in a buffer in plaintext waiting to be read — anything holding a
reference to that buffer could read it.

Redaction covers, by value shape: JWTs, PEM private keys, bearer and basic auth
headers, URL userinfo, cookie headers, OpenAI/Anthropic/Google/GitHub/Slack/
AWS/Stripe key formats, `name = value` assignments under a sensitive key, and
payment card numbers. And by name: sensitive HTTP headers and object keys,
normalised so `api_key`, `apiKey` and `API-KEY` all match.

Applied at every boundary:

- `Logger` redacts every message and context object before any sink sees it.
- `DebuggerManager` redacts console text, network URLs and headers as events
  arrive.
- `EvidenceStore` redacts text payloads before writing them.
- `ToolRegistry` redacts tool results before they enter model context, and
  redacts the summary shown in permission prompts.

Known limitation: redaction is pattern-based. A credential in a format nothing
recognises, with a non-sensitive key name, can pass through. The design
mitigates this by minimising what is collected at all, not by assuming the
patterns are complete.

---

## T4 — Origin safety

Authorisation is never carried across an origin change.

Checked twice, deliberately:

1. **Policy engine** — compares the URL the action was planned against with the
   URL it will act on.
2. **Inside the tool** — re-reads the tab's live URL immediately before acting.

The second check is not redundant: a page can navigate in the gap between the
two.

A cross-site or same-site-different-subdomain transition forces re-evaluation.
Read-only actions tolerate drift; anything with a side effect does not. An
unparseable URL is treated as changed.

Never automatable, under any setting: `chrome:`, `chrome-extension:`,
`chrome-untrusted:`, `devtools:`, `javascript:`, `data:`, `blob:`,
`filesystem:`, `view-source:`, `about:`, `file:`, `ftp:`, and the extension
galleries.

`file:` and `ftp:` are unconditionally blocked rather than merely "insecure".
The _allow insecure origins_ setting exists so a developer can automate an
`http://` dev server; if it also unlocked `file:`, a convenience toggle would
hand the agent reach into the local filesystem. `http:` remains gated on that
setting, except on localhost.

---

## T6 — DevTools access

The debugger is the most powerful capability in the extension.

- Only methods on `ALLOWED_CDP_METHODS` can be sent. Every entry is read-only
  or a capability a tool explicitly exposes.
- **No script-execution method is on the list**: `Runtime.evaluate`,
  `Runtime.callFunctionOn` and `Page.addScriptToEvaluateOnNewDocument` are all
  absent, and a test asserts the list contains nothing matching that shape.
- **No tool accepts a CDP method name.** There is no `debugger.command`, and a
  test asserts no debugger tool's schema has a `method` or `command` field.
  The model cannot name a protocol method at all.
- Attaching shows Chrome's debugging banner. That is intentional: the user must
  be able to see that deep inspection is active.

---

## Hard prohibitions

Refused in **every** permission mode, including Skip, and not unlockable by a
site allowlist entry:

- Payments and financial transactions
- Entering payment card or government identity details
- Account creation on the user's behalf
- Submitting credentials into a page that did not issue them
- Permanent deletion of records
- Securities trading
- Modifying system or browser configuration files
- Defeating CAPTCHA or other bot authorisation

---

## Risk model

| Level | Meaning                        | Example                                            |
| ----- | ------------------------------ | -------------------------------------------------- |
| R0    | Read-only                      | `browser.read_page`, `browser.scroll`, `tabs.list` |
| R1    | Low risk, reversible           | `browser.click`, `browser.navigate`                |
| R2    | Changes state                  | `browser.type` with submit, `tabs.group`           |
| R3    | Sensitive external side effect | Closing a user's tab, cross-site data write        |
| R4    | Destructive                    | (no tool currently declares R4)                    |
| R5    | Prohibited                     | Never executed                                     |

A tool's declared risk is a **floor**. Argument-aware classification may raise
it and never lowers it — `tests/unit/tool-registry.test.ts` asserts this.

### Permission modes and their floors

| Mode   | R0    | R1      | R2      | R3+         | Prohibited |
| ------ | ----- | ------- | ------- | ----------- | ---------- |
| Manual | allow | confirm | confirm | confirm     | deny       |
| Auto   | allow | allow   | confirm | confirm     | deny       |
| Skip   | allow | allow   | allow   | **confirm** | deny       |

Skip is not unrestricted. R3 and above always require explicit approval,
because that is where irreversible external effects begin.

A standing "always allow on this site" approval is capped at R2 and never
covers an elevated exfiltration confirmation.

---

## Credential handling

Provider API keys live in `CredentialStore`, in their own storage namespace
behind their own type. Code holding a `SettingsStore` cannot reach them.

A key is:

- sent only to the base URL the user configured;
- refused if that base URL is not `https:` (localhost excepted, for local model
  servers);
- never included in a task record, log line, evidence item, notification, or
  model prompt;
- shown in the UI only as a masked suffix.

**Known limitation:** `chrome.storage.local` is not encrypted at rest. Anyone
with filesystem access to the Chrome profile can read the stored key. This is a
property of the Chrome extension platform, not something the extension can fix,
and it is stated here rather than glossed over. Use a scoped key with a spend
limit.

---

## Privacy

Default posture: minimum collection, minimum retention, minimum transmission.

- No analytics, no telemetry, no external service beyond the provider endpoint
  the user configured.
- Page content goes only to the configured provider, only for a task the user
  started.
- Screenshots are stored as local evidence and referenced by id; the image is
  not placed into model context implicitly.
- Typed text is reported back to the model as a character count, never as
  content.
- Password field values are never read into the page model at all.
- Evidence and task retention are capped so storage cannot grow without bound.

---

## Chrome permission justification

| Permission                     | Why                                                                        | Could it be dropped?                             |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `sidePanel`                    | The primary UI surface.                                                    | No                                               |
| `storage`                      | Task, session, settings and evidence persistence across worker eviction.   | No                                               |
| `unlimitedStorage`             | Screenshot evidence exceeds the default quota quickly.                     | Yes, at the cost of aggressive evidence eviction |
| `tabs`                         | Reading tab URL and title, and multi-tab workflows.                        | No                                               |
| `tabGroups`                    | `tabs.group` / `tabs.ungroup`.                                             | Yes, by dropping those two tools                 |
| `scripting`                    | Injecting the content script into tabs open before the extension loaded.   | No                                               |
| `debugger`                     | Console, network and DOM inspection. Chrome offers no lesser API for this. | Yes, by dropping all five debugger tools         |
| `notifications`                | Telling the user a background task needs approval.                         | Yes, at the cost of silent stalls                |
| `activeTab`                    | Acting on the current tab without broad host access in simple flows.       | No                                               |
| `host_permissions: <all_urls>` | Content script injection, tab access, and screenshot capture. See below.   | No                                               |

### Why `<all_urls>` rather than `http://*/*` + `https://*/*`

The narrower pair was tried first and produced a real defect: `browser.screenshot`
failed on every page with _"Either the '\<all_urls\>' or 'activeTab' permission
is required"_. Chrome's check for `tabs.captureVisibleTab` looks for that literal
pattern or an _activated_ `activeTab`, and `activeTab` is only in effect after
the user clicks the extension's icon — never for a background task. This was
found by running the extension in a real browser, not by reading the docs.

The widening is smaller than it appears:

- Chrome shows the same install warning for both — _"Read and change all your
  data on all websites"_.
- `content_scripts.matches` is **unchanged** at `http://*/*` and `https://*/*`,
  so the content script's reach is exactly what it was.
- The extra schemes `<all_urls>` covers — `file:`, `ftp:` and similar — are on
  the unconditional block list above, so the policy engine refuses them before
  any tool runs. The manifest grant is the outer bound; the policy engine is a
  strictly narrower inner bound, and a regression test holds that line.
- `file:` access additionally requires the user to enable _Allow access to file
  URLs_, which this extension never requests and could not use if granted.

Requested as **optional**, not granted until a feature needs them:
`alarms` (scheduling) and `downloads` (file handling). Neither feature is
implemented yet, so neither permission is held.

Deliberately **not** requested, despite appearing in comparable products:
`nativeMessaging`, `offscreen`, `system.display`, `webNavigation`,
`declarativeNetRequestWithHostAccess`. Nothing implemented needs them, and
requesting a permission before it has a use is how a permission set becomes
impossible to audit.

---

## Reporting a vulnerability

Open a security advisory on the repository rather than a public issue.
