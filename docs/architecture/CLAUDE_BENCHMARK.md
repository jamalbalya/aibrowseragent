# Claude Extension behaviour benchmark

The locked product goal names the Claude Extension as the benchmark for
capability **and behaviour**. Until now this repository measured itself against
`docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`, which is a
specification, not an observation. This file records what the comparison
product is actually documented to do, so a parity claim has something to be
checked against.

## What this document is not

**Nobody has observed the Claude Extension for this project.** No one on this
side has installed it, run it, or watched it behave. Everything below is
documentary, gathered from published sources on 2026-09-24 and labelled with
where it came from. A reader deciding what to build should treat the UNKNOWN
rows as the most important ones in the file.

### Evidence classes

| Class  | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| **E0** | Direct observation of the shipping extension — **none held** |
| **E1** | Official documentation about Claude in Chrome specifically   |
| **E2** | Official documentation about a directly related product      |
| **E3** | Official product or blog documentation                       |
| **E4** | Reliable third-party evidence                                |
| **E5** | Inference                                                    |

E2–E5 is never promoted to E1. Where two surfaces disagree the conflict is
preserved rather than resolved.

---

## 1. Permission model (E1)

Three modes: **"Manually approve"**, **"Automatically approve"**, **"Skip all
approvals"**.

- Manual: _"Claude pauses and asks for approval before each action."_
- Auto: _"Claude keeps working and reviews each action for safety,
  automatically blocking anything it determines to be unsafe."_
- Skip: _"Claude doesn't pause to ask and nothing checks its actions
  automatically."_

**Always requires approval, in every mode:** modifying permission settings ·
granting authorizations · inputting potentially sensitive information into
websites.

**Documented as prohibited outright:** purchases and financial transactions ·
creating accounts · handling sensitive credit card or ID data · downloading
files from untrusted sources · permanent deletions · investment or financial
advice · executing financial trades · modifying system files · completing
instructions from emails or web content · bypassing CAPTCHAs · scraping facial
images.

**Site-scoped persistent grants** exist (_"Always allow actions on this site"_)
and are revocable in settings. Three actions stay approval-protected despite a
grant: downloading a file, entering potentially sensitive information, granting
authorizations.

**Manual mode carries plan-before-execution semantics:** it _"creates a plan
specifying websites and approach for your approval before starting"_, and
_"Claude will only use the websites listed in the plan"_.

**Secondary review of consequential actions, even in auto (E3):** _"Before
anything consequential, like submitting a form, sending a message, or
downloading a file, a separate check reviews the action."_

## 2. Side panel has two modes (E1/E3)

_"The Claude in Chrome side panel is now a Claude Cowork session."_ A classic
mode also exists, and the capability sets differ — _"Recording isn't available
when the side panel runs as a Cowork session."_

This matters for benchmarking: a single "Claude Extension behaviour" does not
exist. Which mode is being matched has to be stated.

## 3. Scheduled tasks (E1, thin)

Cadences: _"daily, weekly, monthly, or annually"_. Created from the clock icon;
a shortcut gains a **Schedule** toggle with frequency, date and time, and a
**model** picker.

The only behavioural sentence published for Chrome: _"Claude runs the workflow
at the specified time and notifies you when it's done or needs input."_

Everything else is UNKNOWN for Chrome — see §Gap-2.

## 4. Plugins, skills, connectors, MCP (E2)

A plugin _"bundles skills, connectors, and sub-agents into a single package"_
and may include _"local MCP servers that run on your computer with the same
permissions as any other program you run."_ Installed from marketplaces, a git
URL or a custom upload; auto-updates; uninstallable except where an
organization requires them. Trust is delegated to the user — _"Only install
plugins from sources you trust"_ — with optional Enterprise scanning.

The extension is **itself** an MCP server: `claude-in-chrome`, blockable by the
`deniedMcpServers` managed setting, with tools viewable through `/mcp`. MCP
tools marked `requiresUserInteraction` prompt on every call.

## 5. Injection defence (E1/E3)

Two classifiers — one over inbound content, one over every action — and
_"Actions are either blocked or paused for your approval when a classifier
flags a risk."_ Published red-team figures: 23.6% → **11.2%** attack success
rate with mitigations in autonomous mode; a browser-specific challenge set
35.7% → **0%**.

AI Browser Agent reaches the same goal by different machinery: taint tracking,
provenance and an egress gate. Neither is a subset of the other.

## 6. User intervention (E2)

_"When Claude encounters a login page or CAPTCHA, it pauses and asks you to
handle it manually."_ JavaScript dialogs block the agent and need manual
dismissal, after which the user tells Claude to continue.

## 7. Credential boundary (E1)

_"With 1Password for Claude, Claude can complete tasks that require signing in
without handling the credential itself. 1Password fills the login directly, and
your passwords and one-time codes never enter Claude's context."_

The shape worth copying is not the vendor integration — it is the property:
**a credential can be delivered to a page without passing through the agent.**

---

## Gaps this benchmark opened

### Gap-1 — declared prohibitions with no producer

Claude documents purchases, account creation, card/ID entry and permanent
deletion as blocked. This repository declares the equivalent categories and
enforces them in the policy engine, but **no tool raises five of them**, so the
guarantee is about a call nobody constructs. Recorded in
`PROHIBITION_ENFORCEMENT` and in `../security.md`. Closing it is an
architecture decision — where detection happens, and whether the outcome is a
refusal or a confirmation — not a patch.

### Gap-2 — Chrome scheduled-run semantics

Three questions have **no Chrome answer**: what a run does when it needs
approval; what happens to an occurrence missed while the browser was closed;
whether the browser must be open at all.

Claude Code Desktop — a **different product** (E2) — documents: _"the run
stalls until you approve it. The session stays open in the sidebar so you can
answer later"_; _"exactly one catch-up run for the most recently missed time"_;
and a per-task saved grant where _"future runs of that task auto-approve the
same tools without prompting"_, revocable from the task's detail page.

That is not Chrome behaviour and must not be recorded as such. It is listed
because it is the nearest documented design from the same vendor and it
disagrees with this project's P-020 decision on all three points. See
`SCHEDULED_EXECUTION.md`.

### Gap-3 — plan → approve → execute

Manual mode's plan step, and the restriction of execution to the sites named in
the approved plan, have no analogue here. Not represented in any of the forty
capability rows.

### Gap-4 — credential-manager boundary

No analogue. Typing a password is an ordinary `browser.type` at R1 today.

### Gap-5 — outbound MCP

P-026 has been scoped as "consume external tools". The comparison product also
**exposes** its browser capabilities as an MCP server. Both directions need a
decision before P-026 is designed.

### Gap-6 — deliberate divergences, recorded as such

Not gaps to close:

| Behaviour                  | Claude                              | This project                             |
| -------------------------- | ----------------------------------- | ---------------------------------------- |
| Session storage            | _"sessions live with your account"_ | Local-first, by locked decision          |
| Local MCP / native process | Supported                           | Refused — extension-only, no native host |
| Provider                   | Claude models                       | Interchangeable brain, by locked goal    |
| Worker-eviction recovery   | User-driven reconnect (E2)          | Automatic reconciliation on startup      |

---

## Sources

E1 — [Get started](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome) ·
[Permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide) ·
[Use safely](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely) ·
[Admin controls](https://support.claude.com/en/articles/13065128-claude-in-chrome-admin-controls) ·
[Troubleshooting](https://support.claude.com/en/articles/12902405-claude-in-chrome-troubleshooting)

E2 — [Claude Code with Chrome](https://code.claude.com/docs/en/chrome) ·
[Claude Code Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) ·
[Cowork scheduled tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) ·
[Use Cowork safely](https://support.claude.com/en/articles/13364135-use-claude-cowork-safely) ·
[Use plugins](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) ·
[Skills, connectors and plugins directory](https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory)

E3 — [Piloting Claude for Chrome](https://claude.com/blog/claude-for-chrome) ·
[Cowork in the Chrome side panel](https://claude.com/blog/cowork-chrome-side-panel) ·
[Claude in Chrome product page](https://claude.com/claude-in-chrome)

E4 — third-party permission-list reports, used for the manifest permission set
only and not for behaviour.

## What would resolve the unknowns

Installing the extension and observing it. One session settles Gap-2 entirely,
replaces the E4 permission list with the shipped manifest, and enumerates the
`claude-in-chrome` tool surface through `/mcp`. Nothing short of that will.
