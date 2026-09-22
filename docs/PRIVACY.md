# Data handling

What this extension does with data, described against what the code actually
does rather than against an intention. Where a statement is enforced by a
specific mechanism, the mechanism is named so the claim can be checked.

This document does **not** assert compliance with any store policy. Chrome Web
Store requirements are published separately, change independently of this
repository, and have not been verified from this codebase.

## What is read

**Page content, when you ask the agent to work on a page.** Reading a page
produces its text, its interactive elements, and — when a task needs one — a
screenshot. That happens because you gave the agent a task involving that page,
not in the background and not on pages you are merely visiting.

**Diagnostic data, when a task needs it.** Console output, network activity and
rendered markup can be read through the browser's debugging interface. Values
that look like credentials are removed at the point of collection, before the
data is stored or shown to a model.

## What is never read

The extension does not read passwords, does not inspect password fields, and
does not type into them. It does not read cookies, session tokens or OAuth
tokens; it does not request the permissions that would allow it to. It does not
touch the browser's saved-password store. It cannot turn a website session you
are signed into on the web into an API credential, and does not try to.

**It cannot browse your computer.** There is no filesystem access and none is
requested. The agent cannot list a folder, cannot open a file by name, and
cannot be instructed to — the tool that brings a file into a task takes a
description of why a file is wanted and has no field for a location. A file
reaches the agent exactly one way: you open Chrome's own file picker and choose
one.

These are absences of capability, not promises of restraint: the extension does
not request the `cookies` permission, no code path reads a password field's
value, and there is no filesystem API anywhere in it.

## What can leave your device

**Task data sent to your configured AI provider.** To act on a task, the agent
sends the conversation — which can include text it read from a page — to the AI
provider you configured. That is the provider you chose and connected; it is
not a third party of ours.

Every outbound transfer passes a single authorization gate before it happens.
The gate refuses when it cannot establish what the task has read, when the
destination cannot be identified, and when the payload looks like a credential.
A transfer that would carry data read from one site to a different site asks
you first.

**Changing provider re-asks.** A task is bound to the provider and model you
started it with. Switching either does not inherit the previous approval.

**A file you chose, if you approve sending it.** Choosing a file and sending it
to a website are two separate decisions, and you are asked for both. The second
prompt names the file and the site it would go to. A file you picked but did
not approve sending is never transmitted.

## What stays on your device

Task records, evidence, settings and API keys are stored in the browser's
extension storage. None of it is sent anywhere by the extension. There is no
analytics, no telemetry and no crash reporting: the extension makes no network
request other than to the AI provider you configured.

**A file you choose is held in memory only.** It is never written to extension
storage, to evidence, to the activity log or to a log file. When the browser
shuts the extension's background worker down — which Chrome does routinely —
the file is simply gone, and a task that resumes afterwards asks again rather
than pretending it still has it.

Evidence of what left the device records metadata — destination, decision,
size, a keyed digest — and not the content itself. A file appears there as a
name and a size, never as its contents. The digest is computed under
a key unique to each task, so records cannot be correlated across tasks and a
short payload cannot be recovered from its digest.

## Signing in to a provider website

When a provider requires you to sign in, the extension opens the login page and
**pauses**. You complete the sign-in yourself, including any multi-factor step,
CAPTCHA or single sign-on. The extension does not type credentials, does not
read what you type, and does not read the fields you type into.

To learn whether sign-in finished it observes only coarse signals — the address
the browser settles on, and a small set of predefined page landmarks. If those
signals are ambiguous, the task stays paused rather than assuming you are
signed in. There is no automation deadline on this: the task waits for you.

## Model output is not trusted

Text produced by an AI model, and text read from any web page, is treated as
data. It cannot grant permission, authorize a transfer, change a policy, or
cause a tool to run on its own. Only the system's own rules and your explicit
intent can do those things.

## Permissions, and why each exists

| Permission                       | Why                                                           |
| -------------------------------- | ------------------------------------------------------------- |
| `tabs`, `tabGroups`, `activeTab` | see and act on the tab a task is working in                   |
| `scripting`                      | inject the content script that reads and operates the page    |
| `debugger`                       | screenshots, console, network and rendered markup             |
| `storage`, `unlimitedStorage`    | keep tasks, evidence and settings on your device              |
| `sidePanel`                      | the agent's interface                                         |
| `notifications`                  | tell you when a task needs your approval                      |
| `downloads`, `alarms`            | optional; requested only if a feature that needs them is used |
| `http://*/*`, `https://*/*`      | act on ordinary websites you direct the agent to              |

The extension deliberately does **not** request `<all_urls>`. That broader
permission would also grant access to local files, which was demonstrated and
removed.

## Removing your data

Uninstalling the extension removes its storage, including tasks, evidence and
any API key you entered.
