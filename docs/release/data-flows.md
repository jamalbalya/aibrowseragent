# Data flows

Every category of data this extension touches: whether it is collected, where
it is kept, whether it leaves the browser, under what authorization, and why
it is needed. Written against what the code does, with the mechanism named so
each row can be checked rather than believed.

This is the audit behind the store's data-disclosure form. It is not a privacy
policy — [`docs/PRIVACY.md`](../PRIVACY.md) is that, written for a person
rather than a reviewer.

## Where things are kept

Two storage areas, chosen per category rather than by default:

| Area                     | Survives                                      | Readable by a content script                   |
| ------------------------ | --------------------------------------------- | ---------------------------------------------- |
| `chrome.storage.local`   | a browser restart; written to disk            | no                                             |
| `chrome.storage.session` | only until the browser closes; held in memory | no — access level is set to `TRUSTED_CONTEXTS` |

Every store is namespaced (`src/storage/storage-area.ts`), so code holding one
store cannot read another's keys.

## The categories

| Data                        | Collected                          | Stored                                              | Where                                | Leaves the browser                                     | Authorization                                        | Why                                                      |
| --------------------------- | ---------------------------------- | --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------- |
| **Page content**            | when a task reads a page           | as task context and evidence                        | `local:evidence`, `local:tasks`      | to the chosen AI provider only                         | the user gave a task naming that page                | the agent cannot act on a page it has not read           |
| **Page screenshots**        | when a task needs one              | as evidence, by reference                           | `local:evidence`                     | only if the model is asked to look at one              | per-task, risk-rated                                 | visual context the semantic model cannot carry           |
| **Task state**              | always, per task                   | steps, status, taint, approvals                     | `local:tasks`                        | no                                                     | —                                                    | MV3 evicts the worker; without this a task dies mid-step |
| **Provider API key**        | when the user enters one           | as a credential, namespaced apart from settings     | `local:credentials`                  | to that provider only, as a header                     | the user entered it                                  | the provider will not answer without it                  |
| **Connector OAuth tokens**  | after the user authorizes          | access and refresh tokens                           | `session:connector-tokens`           | to that connector's declared origins only, as a header | the user completed an OAuth grant                    | the connector will not answer without it                 |
| **Audit trail**             | one record per dispatch            | decisions, never payloads                           | `local:audit`                        | no — export is local, to a file the user saves         | —                                                    | so a person can see what was decided and why             |
| **Evidence digests**        | per task                           | hash, keyed per task                                | `local:evidence`                     | no                                                     | —                                                    | so a claim about what was seen can be checked            |
| **Uploaded files**          | when the user picks one            | bytes, keyed by task, in memory                     | service worker memory                | to the page the user is filling in                     | the user chose the file in Chrome's own picker       | the page asked for a file                                |
| **Downloaded files**        | never read by the extension        | by the browser, where the user chose                | the user's filesystem                | —                                                      | optional `downloads` permission, granted by the user | the task produced a file                                 |
| **Workflows and shortcuts** | when the user records or names one | steps and bindings; secret-shaped names are dropped | `local:workflows`, `local:shortcuts` | no                                                     | the user saved it                                    | replaying a task the user already did                    |
| **Site policy rules**       | when the user approves a site      | the rule and its risk ceiling                       | `local:policy`                       | no                                                     | the user's approval                                  | so a standing decision is remembered                     |
| **Persistence health**      | on a storage failure               | a severity, per domain                              | `local:health`                       | no                                                     | —                                                    | so a degraded store fails closed instead of silently     |
| **Connector write claims**  | before an external write           | an idempotency key and outcome                      | `local:connector-writes`             | no                                                     | —                                                    | so a retry after a timeout does not duplicate the write  |

## What leaves the browser, and to where

Exactly five destination families, and no others:

| Destination                                                             | Carries                                                       | When                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `api.openai.com`, or any OpenAI-compatible endpoint the user configures | the task prompt, page content as enveloped data, tool schemas | the user chose this provider            |
| `api.anthropic.com`                                                     | the same                                                      | the user chose this provider            |
| `generativelanguage.googleapis.com`                                     | the same                                                      | the user chose this provider            |
| `api.github.com`, `github.com`                                          | connector requests and the OAuth exchange                     | the user connected the GitHub connector |
| the page the user is working on                                         | typed values, clicks, file uploads                            | the task is acting on that page         |

There is **no telemetry, no analytics and no error reporting endpoint**. That
is checkable rather than asserted: `security-invariants.test.ts` fixes the
number of files holding a network primitive at three, and every outbound
request passes `authorizeEgress`, of which there are exactly two callers.

## What is never collected

Stated as absences of capability, not promises of restraint — each is the
consequence of a permission not requested or a code path that does not exist:

| Not collected                       | Why it cannot be                                                     |
| ----------------------------------- | -------------------------------------------------------------------- |
| Cookies and session tokens          | no `cookies` permission; asserted in the manifest invariant          |
| Browsing history                    | no `history` permission                                              |
| Password field values               | the page model excludes `password`, `hidden` and `file` values       |
| Bookmarks                           | no `bookmarks` permission                                            |
| Local files                         | no filesystem API anywhere; Chrome itself refuses `file://`          |
| The user's identity                 | no `identity` permission; `chrome.identity` is genuinely unavailable |
| Anything from a cross-origin iframe | `all_frames` is `false`                                              |

## The asymmetry worth knowing

A provider API key is written to disk; a connector OAuth token is not.

That is deliberate rather than inconsistent. An API key is long-lived and the
user typed it in — writing it to `session` would mean re-entering it after
every browser restart, which trains people to keep keys somewhere worse. An
OAuth access token is short-lived and refreshable, so keeping it in memory
costs the user one re-authorization after a restart and removes a disk-resident
bearer credential.

Both are namespaced away from ordinary settings, neither is ever passed to the
logger, and the vault exposes no method that returns a bare token — asserted
over its whole interface, so a method added later that returned one would fail.

## What this audit cannot tell you

**What the AI provider does with what it receives.** Once page content reaches
OpenAI, Anthropic or Google, this extension's controls end and that vendor's
terms begin. The extension decides _whether_ data may leave and to _where_; it
cannot decide what happens after. A user choosing a provider is choosing those
terms, and no statement here should be read as covering them.

**Whether redaction caught everything.** Redaction is pattern-based. A
credential in an unrecognised format, under a non-sensitive key name, can pass
through. The design mitigates this by minimising what is collected at all, not
by assuming the patterns are complete.
