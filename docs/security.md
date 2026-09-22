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

The card rule is the one that needs three constraints rather than one. A run
of digits is treated as a card only when it stands alone as a token, begins
with a published issuer prefix, and satisfies the Luhn checksum. Every genuine
card number meets all three, and the narrowing is what stops the rule
corrupting the identifiers and timestamps the agent reports — shape alone ate
evidence-id tails, and shape plus Luhn still ate 13-digit epoch-millisecond
timestamps, which sit on every record this system writes. A closed-loop card
outside the published issuer ranges is not caught by this rule; it is still
caught whenever it appears under a sensitive key name.

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

### Connector tokens

An OAuth access token for a connected service lives in `TokenVault`, which has
exactly one method that lets a credential out — and it returns an
`Authorization` header value, not a token. A caller that only ever receives a
header cannot put a token in a log line, an audit record, a tool result or a
model prompt, because it never holds one. A test asserts over the vault's
whole prototype, so adding a convenience getter breaks the build.

Tokens are kept in `chrome.storage.session` with the access level set
explicitly to `TRUSTED_CONTEXTS` rather than relying on the default staying
what it is. That is memory-only and unreadable from a content script. The
grant survives the service-worker eviction Chrome performs constantly and is
gone at a browser restart, which is rare — persisting a refresh token to disk
would buy a reconnect a few times a year at the cost of a long-lived
credential in extension storage.

The header is attached by the connector transport, last, over caller headers
that have had every casing of `Authorization` stripped first. HTTP header
names are case-insensitive, so "applied last" is only a guarantee if a caller
cannot have written the same header under a different spelling.

See [connectors.md](connectors.md) for the OAuth design, including why
`chrome.identity` was not used.

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

| Permission                                    | Why                                                                                                  | Could it be dropped?                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `sidePanel`                                   | The primary UI surface.                                                                              | No                                               |
| `storage`                                     | Task, session, settings and evidence persistence across worker eviction.                             | No                                               |
| `unlimitedStorage`                            | Screenshot evidence exceeds the default quota quickly.                                               | Yes, at the cost of aggressive evidence eviction |
| `tabs`                                        | Reading tab URL and title, and multi-tab workflows.                                                  | No                                               |
| `tabGroups`                                   | `tabs.group` / `tabs.ungroup`.                                                                       | Yes, by dropping those two tools                 |
| `scripting`                                   | Injecting the content script into tabs open before the extension loaded.                             | No                                               |
| `debugger`                                    | Console, network and DOM inspection, and screenshot capture. Chrome offers no lesser API for either. | No — `browser.screenshot` depends on it          |
| `notifications`                               | Telling the user a background task needs approval.                                                   | Yes, at the cost of silent stalls                |
| `activeTab`                                   | Acting on the current tab without broad host access in simple flows.                                 | No                                               |
| `host_permissions: http://*/*`, `https://*/*` | Content script injection and tab access. See below.                                                  | No                                               |

### Why not `<all_urls>`

`<all_urls>` was held briefly and has been removed. The reasoning is recorded
here in full, because the first version of this document argued the opposite
and was wrong on a point of fact.

**What went in.** The narrow pair produced a real defect: `browser.screenshot`
failed on every page with _"Either the '\<all_urls\>' or 'activeTab' permission
is required"_. Chrome's check for `tabs.captureVisibleTab` looks for that
literal pattern or an _activated_ `activeTab`, and `activeTab` is only in
effect after the user clicks the extension's icon — never for a background
task. Widening the manifest fixed the capture.

**What the measurement showed.** The widening was then probed side by side in a
real Chromium, one profile per manifest:

| Probe                                        | `<all_urls>`                                | `http://*/*` + `https://*/*`               |
| -------------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| `tabs.captureVisibleTab` on an https page    | captured                                    | refused                                    |
| `Page.captureScreenshot` over the debugger   | captured                                    | captured                                   |
| `scripting.executeScript` on a `file://` tab | **succeeded, returned the file's contents** | refused: _"Cannot access contents of url"_ |
| screenshot of a `file://` tab                | captured                                    | refused                                    |

The third row is the decisive one. Under `<all_urls>`, Chrome let the extension
read a local file. Under the narrow pair it refuses at the browser level,
before any of this extension's code runs.

**The claim this replaces.** An earlier version of this section stated that
`file:` access "additionally requires the user to enable _Allow access to file
URLs_". That is false for `scripting.executeScript`, which the probe above
exercised directly. The toggle governs some file-URL surfaces, not all of them,
and the extension's own block list was therefore the only thing standing
between the model and the local filesystem — a single layer, in code we
maintain, where Chrome was previously providing one for free.

**What replaced it.** `browser.screenshot` now captures through
`Page.captureScreenshot`, which is already on the DevTools allowlist and needs
no host permission at all. The feature works, the manifest stays narrow, and
Chrome's own refusal on `file://` stays in place. The cost is that a capture
attaches the debugger briefly, so Chrome shows its debugging banner — a
visible, conservative trade.

**How the line is held.** Three independent checks fail if the pattern returns:

- `scripts/validate-package.mjs` fails the build on `<all_urls>`, `*://*/*`,
  `file:///*` or `ftp://*/*` in `host_permissions`, `permissions`,
  `optional_permissions` or `content_scripts.matches`, and on any host pattern
  outside the reviewed pair.
- `tests/security/screenshot-capture.test.ts` asserts the shipped
  `public/manifest.json` against the same rules.
- The same suite asserts that a `file:`, `ftp:`, `chrome-extension:` or
  otherwise blocked tab is refused _before_ the debugger attaches, so a blocked
  page is never instrumented at all.

`content_scripts.matches` is unchanged at `http://*/*` and `https://*/*`, as it
was throughout.

Requested as **optional**, not granted until a person grants them:
`alarms` (scheduling) and `downloads` (file handling).

`alarms` has no feature behind it yet, so it is never requested.

`downloads` now does, and it stays optional. It is not granted at install, the
agent cannot request it — `chrome.permissions.request` needs a user gesture in
an extension page — and a person turns it on from Settings. Until they do,
`browser.download` refuses with an explanation rather than failing obscurely.
Uploads were built in the same wave and need **no** permission at all: they use
the content script that already exists, so the file half of the feature added
nothing to the manifest.

### Files, and what the extension still cannot reach

File upload and download exist (see [file-handling.md](file-handling.md)) and
were deliberately built so that the local-access question never arises. There
is no filesystem API, no `file://` host permission, and no tool that accepts a
path — `files.select` takes a description of _why_ a file is wanted and nothing
else, so "read `~/.ssh/id_rsa`" cannot be expressed even as a proposal. A file
reaches a task exactly one way: a person opens Chrome's own picker and chooses
one.

The bytes are then held in the service worker's memory and written nowhere —
not to storage, evidence, the audit trail or a log. An eviction loses them, and
a task that resumes says so rather than reporting an upload that did not
happen. What survives is the taint: the task stays marked as having read a
local file whether or not the file is still held.

Deliberately **not** requested, despite appearing in comparable products:
`nativeMessaging`, `offscreen`, `system.display`, `webNavigation`,
`declarativeNetRequestWithHostAccess`. Nothing implemented needs them, and
requesting a permission before it has a use is how a permission set becomes
impossible to audit.

---

## Skills, and why they are not a bypass

A workflow is "several privileged things in a row", and the obvious way to
build one is an engine that runs them. That engine would be a second path from
a proposal to a real effect, and a second path is a bypass whatever its author
intended.

So there is no second path. Every step a skill takes goes through
`ToolRegistry.dispatch` — the same function the agent runtime calls for a
model-proposed tool call — which means policy, the permission prompt, the
egress gate, sanitisation and evidence all apply, **per step**.

Three properties carry the boundary:

- **A skill cannot be created, only chosen.** Only definitions that shipped in
  the build register; a model, a page or a connector can produce a
  definition-shaped object and none of them can produce a registered one. There
  is no installer and no `skill.register` message.
- **There is nowhere to put code.** No expression language, no template, no
  literal with behaviour. A test fails if anything under `src/skills/` gains an
  evaluator, a `fetch` or a filesystem import.
- **A declaration grants nothing.** `requiredTools` and the declared risk state
  intent, which the registry checks; authorization still comes from the policy
  engine and the user. The declared risk is a floor, so understating it makes a
  skill stricter to approve.

Running a workflow costs an approval for the run **plus** whatever its steps
would have cost individually — measured in real Chromium, not asserted. See
[skills.md](skills.md).

### A recording is not a permission

Workflow recording (P-022) saves the steps a task took so you can run them
again. It reuses the skill definition, validator, runner and dispatch path
unchanged, and adds no execution code of its own.

The boundary rests on four properties:

- **A recording authorises nothing.** Every step is re-adjudicated at replay,
  against the world as it is then. A site blocked since, a connector
  disconnected since, a tool removed since or a risk raised since each refuses
  the replay at the moment it applies.
- **A recording is never model-reachable.** It is not registered, does not
  appear in `skills.list`, and there is no `workflow.*` tool. Registration is
  what makes something model-invokable, and nobody has reviewed the combination
  of tools a user's recording reaches. Replay is an explicit user action and
  nothing else.
- **A recording stores intent, never data.** Secret detection runs on every
  value regardless of provenance, sensitivity forces a slot by argument name,
  and taint decides the rest — three independent controls in a fixed order,
  where `KNOWN_UNTAINTED` establishes provenance and says nothing about whether
  a value is safe to keep. A task with `UNKNOWN` provenance contributes nothing
  at all.
- **Page-derived match data stays page-derived.** A recorded click stores a
  role and an accessible name read out of the page, tagged `PAGE_DERIVED` and
  `ELEMENT_BINDING` permanently. Passing ARIA validation, secret detection, a
  length check or a uniqueness check gates whether it may be stored at all;
  none of them changes where it came from. It may be compared for equality
  against a fresh page read and displayed in the review surface, and nothing
  else — not a tool argument, not a selector, not a policy or permission
  input, not a destination, not an egress payload, not audit or evidence, not
  a permission prompt, and never model context. This is not an exception to
  the taint model: a binding is a match predicate, not a literal, and the rule
  governing literals is unchanged.
- **A recording that is missing a step cannot run.** What the recorder could
  not write down is persisted with the record, shown in position, and refuses
  the replay — running the subset would report success having done something
  the recording does not describe.
- **A stored definition is the store's to identify.** The store canonicalises
  and hashes what it is about to persist; a caller cannot supply a hash. The
  hash is re-derived before every replay, so a record altered underneath the
  store is refused rather than run.

The observation hook the recorder sits on is an observer only: it receives a
deep-cloned, recursively frozen record of a completed dispatch, carrying no
security, policy, permission or evidence state and no live reference to
anything the dispatch path uses, on a path the return value does not depend on,
with exceptions caught. See [workflows.md](workflows.md).

### A name is not a capability

Shortcuts (P-021) let a user type `/qa-regression` to run a workflow or a
bundled skill they already have. A shortcut holds a name and a reference and
nothing else — no steps, no tool arguments, no prompt, no code — so it is not
a thing that runs, it is a thing that names something that runs.

Four properties carry the boundary:

- **It adds no execution path.** Resolving a name is a read that runs nothing.
  What it points at then runs through `workflow.replay` or `skill.run`, which
  reach the same `SkillRunner` and the same `ToolRegistry.dispatch` they always
  did, with risk, policy, permission, egress and evidence re-applied per step.
  A name buys nothing.
- **A name means one thing.** Normalisation is fixed and idempotent, lookup is
  exact equality with no nearest match, and a collision — identical, or merely
  confusable under a key that folds digit and letter lookalikes — is refused
  rather than merged or auto-renamed. Two distinct choices must not become one
  executable shortcut, because then one of them silently runs the other's
  target.
- **Targets are re-checked every time.** A deleted workflow, a recording with
  gaps, an unregistered skill or a malformed stored record all fail closed, and
  a shortcut never falls through to a different target.
- **No model authority.** There is no `shortcut.*` tool and no `shortcut.run`
  route; a model can neither manage a shortcut nor invoke one, and shortcuts
  never reach `skills.list` or the tool schemas a model is offered.

The confirmation shown before a shortcut runs is **not** a security decision.
It says which reviewed thing is about to start, not whether it may do what it
does. See [shortcuts.md](shortcuts.md).

### An audit trail that cannot become a payload store

The unified trail (P-038) records every task's decisions in one place and is
the one artefact designed to leave the extension as a file, which makes it the
most sensitive single thing the product holds. Five properties carry it:

- **It observes; it never authorises.** Nothing reads it to decide anything,
  and the audit layer imports no gate. A write that fails is a gap in the
  record of an execution that already happened — never a failed execution.
- **It holds decisions, never data.** Every field is an identifier, a closed
  vocabulary, a flag or a reference. Records are flat and bounded, anything
  over a limit is refused rather than trimmed, and a field the redactor would
  alter is dropped rather than marked.
- **It is not a model-writable field.** A tool name, the one field with
  model-controlled reach, is checked against the registered set; an
  unrecognised one is stored as `(unknown)` and the proposed string dropped.
- **Its order is checkable.** A persisted sequence and a digest chain detect
  corruption, gaps, duplication and reordering. This is not tamper protection
  and is not described as such: anyone who can rewrite extension storage can
  rewrite the chain with it.
- **Export is local only.** A blob of the extension's own origin, written
  through an anchor click, needing no permission, with no network carrier and
  no URL parameter. The scope is required and never inferred.

Eviction writes a `retention.compacted` record in the same transaction that
removes the records, so a reader can always tell a quiet period from a
truncated one. There is no delete in the UI. See [audit.md](audit.md).

## Persistence failure, and why it is written down

The failure this guards against is quiet. A task's security state — its
taint, its salt, what it has already read — lives in one place; a write to
that place fails; and within minutes MV3 evicts the worker that noticed. What
comes back is a task that looks fine, because the only record that it was not
fine was in the memory of a worker that no longer exists. A storage failure
that erases its own evidence is indistinguishable from no failure at all.

So health is written down, per domain, on a ladder: `HEALTHY`, `DEGRADED`
(a write did not land), `CORRUPT` (something stored did not read back as
written), `RECOVERY_REQUIRED`, `IRRECOVERABLE` (storage itself is unusable).

Two rules keep it honest:

- **Monotone.** Severity only rises. A later successful write does not mean
  the earlier loss did not happen, so nothing in the failure paths may lower
  it — and no failure handler in the codebase can, which is asserted by test.
  Only an explicit acknowledgement from a person lowers it, and that is
  recorded in the audit trail.
- **Worst of both.** What is reported is the worse of the persisted record and
  a floor this worker has held since it started. If the marker itself could
  not be written, the floor still stops _this_ worker.

Two domains gate work and one deliberately does not:

| Domain          | Degraded means                                         | Gates work |
| --------------- | ------------------------------------------------------ | ---------- |
| `task-security` | a task's taint, salt or record did not persist         | **yes**    |
| `storage`       | the substrate is not usable                            | **yes**    |
| `audit`         | a record of something that already happened is missing | **no**     |

The audit domain is excluded on purpose, and it is not an oversight. A gap in
the record of an execution that already ran is not a failed execution, and
making audit failure stop a task would convert one into the other — which is
exactly what P-038's contract forbids. It is reported, durably, and it does
not stop anything.

The gate is consulted where work _begins_ — starting, resuming and retrying a
task — and nowhere else. Not mid-execution: aborting work that is already
authorised and already happening is a different failure from refusing to
begin. It adds no check to dispatch, policy, permission or egress, and those
modules do not import it.

**The honest limit.** The marker is written to the same storage whose failure
it records. Under a total, permanent storage failure it cannot be written
either, and a worker that starts afterwards cannot know. This raises the floor
— it covers quota exhaustion, a rejected write, a record that will not parse,
and a transient fault — and it is not a guarantee. It is not described as one
in the code, and it is not described as one here.

## A file does not outlive the work it was chosen for

A person hands the extension bytes from their own machine for one piece of
work. Cancelling a task freed them from the start. Completing one did not —
so a staged file sat in the worker's memory until MV3 happened to evict it,
which is minutes and is not a guarantee, and was not a decision anybody made.
Any terminal state now frees them, hooked once where the task manager already
says a task has finished rather than reproduced at each exit.

Around that, the properties the upload path already had and keeps: a request
that nobody answers resolves as **cancelled**, never as a selection; an
answer to a request that already settled changes nothing; the request has
nowhere to put a filesystem path, so a model cannot propose one; and a staged
file is looked up by task as well as by id, which makes reaching another
task's file a matter of not being able to rather than of not guessing.

Download is the browser's job. The extension validates a filename, never
overwrites, declares the URL as an egress in the outbound direction — a URL
carries whatever was put in its query string — and holds no filesystem
primitive of its own. The `downloads` permission stays optional and
unrequested, so the path that has actually run end to end in a browser is the
refusal; the granted path is covered in unit and integration tests, and that
distinction is kept rather than folded into a verdict.

## Setting a form control that is not a text field

Date, time, datetime-local, month, week, colour, range and number are set
through `browser.set_value`, and a multi-select through
`browser.select_many`. Both are ordinary registry tools: an element handle
from a page read this build issued, a declared page-write egress, a risk
level, and no route or authorisation of their own. Neither accepts a
selector, an expression or a script, and neither added a permission.

Two rules keep a value honest. It is checked against the format its type
accepts _and_ against the bounds the page declared, so a value outside them
is refused rather than clamped — clamping would submit a number or a date
nobody chose. And it is read back after assignment, because a browser's way
of rejecting a value it cannot parse is to clear the field and say nothing:
`2026-02-30` matches the date format exactly and is not a date. A value the
control refuses is restored rather than left cleared.

A multi-select is set as a whole rather than added to, for the same reason
`set_checked` is not a toggle: an additive call has to be right about what is
already selected, and a stale snapshot would leave options set that the
caller believed it had cleared. Options match exactly — a prefix match would
turn `admin` into `admin-readonly` depending on document order, which is not a
substitution a permissions dropdown should make.

## Switching provider, and what must not come with it

Switching provider or model is an explicit action, and §60 forbids a silent
fallback. Two things this wave found were quiet substitutions rather than
loud ones.

**A capability measurement belongs to the pair it was measured on.** The
stored connection record holds what the capability doctor observed, and
selecting a new provider or model used to spread that record forward and
replace two fields — so a measurement of one model became a claim about
another. A stale claim is worse than no claim, because nothing downstream can
tell it from a real one. A switch now drops the capabilities, the timestamp
that dated them, and the readiness decided from them, and the record is
configuration again until the doctor measures. Unmeasured falls back to the
conservative set, where nothing is claimed.

`ModelCapabilities` is boolean, not the SUPPORTED / UNSUPPORTED / UNKNOWN
vocabulary of §24B — that tri-state belongs to the web-provider design, which
is gated and unbuilt. The boolean default points the same way (unmeasured
reads as "do not rely on it") without being able to tell an unmeasured
capability from a measured absence, and that limit is stated rather than
papered over.

**A task does not change model underneath itself.** A task records the
provider and model it began on, and the adapter is resolved once per
execution rather than per turn, so a switch mid-run cannot reach the turn in
flight. Resuming a half-finished task onto whatever is active by then is the
case that was open: the conversation so far was produced by one model, and
continuing it on another under a record still naming the first is exactly the
substitution §60 rules out. It is refused, naming both models, and switching
back or retrying on the current model are the two explicit ways forward.

Credentials are per provider and are read by the provider being resolved, so
a switch moves none. Consent is pinned to a canonical provider destination
and a model, so changing either already invalidates the grant — the switch
does not re-implement that, because a rule with two implementations is a rule
with two places to be wrong.

## Route trust

Every message the extension routes arrives over `chrome.runtime` or
`chrome.tabs`, and the receiver used to look only at the message. That is the
wrong half: a message says what the sender wants, and it cannot say who the
sender is. A `taskId`, a `requestId` or an export `scope` in a payload is a
request, never a credential.

A route now runs only when the sender is **positively identified** as a
context allowed to invoke it. Classification happens before anything else:

    classify sender → resolve route class → authorise → handler

so a refused message never reaches a handler. It cannot mutate state, answer a
pending permission or file selection, start or replay anything, change policy,
or produce an export — there is no partially-executed case, because nothing
ran.

### Contexts, and how one is recognised

`sender.id` is the _extension_ id and is identical for the side panel and for
this extension's content scripts, so it separates this extension from another
one and nothing else. Identity is a conjunction:

| Context            | How it is recognised                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Side panel**     | this extension's id, the extension origin, and the panel document itself — exactly, not its directory                                                                                                                                                                            |
| **Service worker** | this extension's id and the worker script URL, with no tab. Chrome sets no `origin` on a worker sender, so requiring one here would deny every broadcast; `sender.url` is filled in by the browser, not the sender, and no outside context can carry this extension's worker URL |
| **Content script** | this extension's id with a _page_ origin, corroborated by a tab                                                                                                                                                                                                                  |
| **Anything else**  | another extension, a page, or a sender whose fields contradict each other                                                                                                                                                                                                        |

`sender.tab` is used only to recognise a content script, never to establish
that a sender _is_ the panel: Chrome may associate a side panel with a tab,
and a rule reading "the panel has no tab" would break the day that changed.

Ambiguity is a denial. A sender missing a field it should have, or carrying
fields that disagree, is refused rather than resolved to whatever it most
resembles.

### Route classes

| Class                          | Who may send   | What it covers                                                                      |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------- |
| `CLASS_A_INTERNAL_WORKER_ONLY` | nobody         | reserved; empty today                                                               |
| `CLASS_B_PANEL_CONTROL_PLANE`  | side panel     | mutates, executes, authorises, changes policy, or discloses audit, evidence or logs |
| `CLASS_E_PANEL_READ_ONLY`      | side panel     | reads that do none of those                                                         |
| `CLASS_C_CONTENT_DATA_PLANE`   | service worker | the `content.*` routes                                                              |
| `CLASS_D_AUTH_CALLBACK`        | nobody         | the OAuth redirect target, which carries no message path                            |
| `CLASS_F_EVENT_CHANNEL`        | service worker | `agent.event` broadcasts to the panel                                               |

Every panel route is in one of the two panel classes. The table is typed as a
total record over the protocol's route names, so **adding a route without
assigning a class does not compile**, and a route that somehow reaches the
router without one is refused. Registration grants nothing on its own.

### What this replaces

No page can reach a privileged route today, for three reasons: the content
script runs in an isolated world, `src/content/` contains no `postMessage`
bridge, and the manifest declares no `externally_connectable`. All three are
true. **None of them is a check** — each is a fact about the current shape of
the code that a single future line could change.

So the boundary is enforced at the receiver instead. A `postMessage` bridge
added by accident in a later wave would expose page content to a content
script, which is a real bug; it would not expose a single route.

Two consequences worth stating plainly:

- **A pending request id is not a credential.** `permission.listPending` hands
  out live request ids and `permission.respond` turns one into an approval —
  including `approve_site`, which writes a lasting rule at a caller-chosen
  risk ceiling. Both are control-plane routes, because the first is what makes
  the second usable.
- **Model unreachability is not authorization.** No panel route is a
  registered tool, and none may become one. That is a separate control from
  this one, and neither substitutes for the other.

The event channel is protected at its receiver too. It carries
`permission.requested`, which the panel renders as a prompt, so an event from
anywhere but the worker would put someone else's text in front of the person
at the one moment a human is the control.

A refused message is recorded as a `route.refused` audit record holding the
route name and a closed sender class — never the sender's URL.

Route trust is a filter in front of the existing routes. It can only subtract:
a message that passes it meets exactly the same policy, permission, egress and
consent gates it met before.

## Reporting a vulnerability

Open a security advisory on the repository rather than a public issue.
