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

The `claude-in-chrome` MCP server is blockable by the `deniedMcpServers` managed
setting, with tools viewable through `/mcp`. MCP tools marked
`requiresUserInteraction` prompt on every call. **Where that server actually
runs is not the extension** — see §13, which corrects an earlier reading of this
paragraph and decides Gap-5's server half.

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

## 8. Form filling (E1 for the principle, UNKNOWN per control)

Searched deliberately during the P-006 audit, because P-006 is a parity row and
the matrix needed to know what it was being measured against.

**What is documented (E1).** Claude _"fills out forms the way a person would"_,
and the capability is described as clicking, typing, navigating and filling
forms. Before something consequential — _"like submitting a form"_ — a separate
check reviews the action.

**What is not documented (UNKNOWN), and was checked.** Nothing published names
which individual controls are supported, and nothing describes what happens at
a **read-only**, disabled or invalid field. The help centre describes forms
generically and does not go below that level. So there is no benchmark
behaviour to match per control type, and this repository's per-control choices
are its own.

**The one sentence that does bear on a control-level decision** is _"the way a
person would"_. A person cannot edit a read-only field: `readonly` is a
constraint on user interaction, and the browser enforces it against typing
while leaving the IDL value setter open. So refusing to write into one is the
reading of that sentence, not a divergence from it — which is the reasoning
this repository's fix rests on, stated here rather than left implicit.

**A related failure in another product (E4, and not evidence about Claude).**
A public issue against `vercel-labs/agent-browser` records `fill` clearing a
read-only or disabled input with a value assignment, failing to write, and
reporting success — the same class of defect this audit found here, in a worse
form. It is cited because it shows the failure mode is real in shipping browser
agents, not because it says anything about the comparison product.

## 9. Recording, shortcuts and scheduling (E1)

Searched during the Wave 9 parity audit, because P-021 and P-022 are parity
rows whose reach limits were stated against no benchmark at all.

- **Recording.** _"In the classic side panel, you can teach Claude a workflow
  by recording the steps yourself, and Claude learns to repeat them."_ Record
  icon, perform the steps, stop. Unavailable in the Cowork side panel.
- **Shortcuts are saved prompts.** _"After crafting a prompt that works well,
  save it as a shortcut."_ Invoked by _"typing '/' in the chat"_; edited and
  deleted in extension settings.
- **Shortcuts are schedulable.** _"You can schedule your Claude in Chrome
  shortcuts to run automatically by clicking the clock icon."_ Daily, weekly,
  monthly, annually.

The third is a **behaviour difference**, not an unknown. This build schedules
skills and workflows and deliberately does not schedule shortcuts — P-021 says
so and gives the reason (adding a target kind is a P-020 change, and P-020 is
frozen). The benchmark schedules exactly the object this build will not. The
shape also differs: there a shortcut _is_ a saved prompt, so scheduling one
schedules a prompt; here a shortcut is a _name for an already-reviewed target_
and a saved-prompt target was added later as the narrow exception.

The first two match. This build accepts `/name` in the composer
(`TaskComposer.tsx`) and supports a saved-prompt target.

## 10. Multi-tab is a tab group (E1)

_"Drag tabs into Claude's designated tab group to enable Claude to view and
interact with all grouped tabs at once."_ From the Claude Code side:
_"The extension collects the tabs Claude opens into a Chrome tab group tied to
your session."_

Same design as this build's browser workspace, arrived at independently, and
one of the closest behavioural matches in the file. Drag-in and drag-out are
covered here by real-Chromium tests.

## 11. Notifications (E1)

_"Enable notifications to receive alerts when Claude requires permission or
completes a task, allowing you to focus on other work while Claude processes
tasks in the background."_

**Two triggers are named, and this build has one and a half.** `Notifier`
notifies on a permission request, and on a _scheduled_ run starting, finishing,
failing or stopping at the confirmation boundary. An ordinary interactive task
finishing notifies nothing — which is precisely the case the benchmark sentence
describes, because it is the case where the user has gone to do something else.

**Closed, and bounded to what the sentence actually says.** A task reaching a
terminal state now notifies. The evidence establishes _that_ the comparison
product notifies on completion and nothing whatever about what its notification
contains, how it behaves when several tasks finish at once, or whether it
suppresses one while the panel is in front of the user. None of that was
invented here: the message says what ended and nothing else, which is the
narrowest thing that satisfies the sentence, and it is a security position in
its own right rather than a guess at the benchmark.

Still UNKNOWN, and not assumed either way: notification content, batching,
suppression while visible, and whether the benchmark notifies for a cancelled
task. This build says nothing for a cancelled one, by decision.

## 12. There is no action-by-action trail (E1 absence / E4)

Nothing in the published documentation describes a record of what the extension
did. The nearest thing is session history: _"Side panel sessions are saved to
your history and can be reopened on your other devices"_ — a conversation, not
an action log.

A feature request against the vendor's own tracker asked for exactly that
— _"There is no supported way to retrieve a log of what Claude in Chrome did in
a session"_ — and was **closed as not planned**
([claude-code#35110](https://github.com/anthropics/claude-code/issues/35110)).

So P-038 is not a parity gap in either direction that this file can find. It is
a **superset**: an append-only per-action trail with a digest chain, integrity
verification and local export has no counterpart in the benchmark. Its PARTIAL
is §84 condition 3 and the three limits P-038 already states, and nothing here
suggests otherwise.

## 13. How the MCP surface is actually carried (E1/E2)

The earlier note in §4 — that the extension "is itself an MCP server" — is
correct about the capability and misleading about the mechanism, which turns out
to decide P-026 entirely.

`claude-in-chrome` is an MCP server **inside Claude Code**, not inside the
extension. It reaches the extension through a **native messaging host**
(`com.anthropic.claude_code_browser_extension.json`, installed under the
browser's `NativeMessagingHosts` directory), and the documented failure mode for
a blocked corporate network names **`bridge.claudeusercontent.com`** — a vendor
cloud relay.

Both mechanisms are on this project's locked prohibition list: no native
messaging, and do not make the machine a server. See Gap-5.

## 14. Worker eviction is handled by asking the user (E1)

_"The Chrome extension's service worker can go idle during extended sessions,
which breaks the connection. If browser tools stop working after a period of
inactivity, run `/chrome` and select 'Reconnect extension'."_

Previously recorded as an E2 inference in Gap-6. It is E1, and it is a
troubleshooting entry rather than a design note. This build reconciles
automatically on worker startup and has nine real-Chromium terminations proving
it. Divergence kept, and it is the divergence in this build's favour.

## 15. Login, CAPTCHA and JavaScript dialogs (E1/E2)

_"When Claude encounters a login page or CAPTCHA, it pauses and asks you to
handle it manually."_ And: _"JavaScript dialogs block browser events and prevent
Claude from receiving commands. Dismiss the dialog manually, then tell Claude to
continue."_

Two different things, and this build's position differs on each:

- **Credentials.** Stricter here, by decision: a password or one-time-code field
  is refused outright rather than handed over. But refusing is not the same act
  as _parking the task and telling the person to take over_ — the benchmark's
  behaviour is a handover, and this build has the machinery for one
  (`WAITING_FOR_USER`, used by the file-selection broker) without wiring it to
  this case. A **behaviour gap inside a stricter control.**
- **CAPTCHA.** `bot_protection_bypass` is a declared prohibition here, which
  matches the refusal half and, again, not the handover half.
- **JavaScript dialogs.** Neither product handles them; the benchmark documents
  the failure and the workaround. This build has **no coverage at all** for an
  `alert`/`confirm` blocking a page — an evidence gap rather than a parity gap,
  and one §89 never asked for.

## 16. One conflict, preserved rather than resolved (E1 vs E3)

The permissions guide lists purchases and financial transactions among actions
Claude will not take. The product page says _"Purchases, financial actions…wait
for you"_ — which is confirmation, not prohibition.

Two official surfaces, two different models, and the file's own rule applies:
the conflict is recorded, not resolved. This build treats purchase and financial
transaction as prohibitions denied at R5 before any prompt. That is at least as
strict as either reading, so nothing here is weakened to match — but a parity
claim against "the benchmark's" behaviour cannot be made while the benchmark
documents two.

## 17. Capabilities outside the forty rows (E1)

Named in the Claude Code integration and absent here, in neither the
specification's forty rows nor this matrix:

| Benchmark capability                                       | Here                                            |
| ---------------------------------------------------------- | ----------------------------------------------- |
| Record browser interactions as a GIF                       | Absent. Not a spec row                          |
| Screenshot saved to a local file path                      | Absent — screenshots are evidence, never a file |
| Plan-before-execution with a site allowlist in Manual mode | Absent. See Gap-3                               |
| Password-manager credential boundary                       | Absent by decision. See Gap-4                   |

Listed so that "forty rows at PASS" is not mistaken for "everything the
benchmark does". It would not be.

## Gaps this benchmark opened

### Gap-1 — declared prohibitions with no producer (partially closed)

Claude documents purchases, account creation, card/ID entry and permanent
deletion as blocked. This repository declares the equivalent categories and
enforces them in the policy engine, but originally **no tool raised five of
them**, so the guarantee was about a call nobody constructs.

Gate 1 closed one of the five. `payment_instrument_entry` now has a producer in
`browser.type` and `browser.set_value`, from a page-derived field signal and a
page-independent value signal. Card and bank-detail entry is denied before
permission mode, site policy or any standing grant is consulted.

Four remain open, and the reason is specific: they need **action**-intent
detection — knowing that a button completes a purchase, creates an account,
deletes something permanently or places a trade — whereas Gate 1 detects the
sensitivity of a _field_. Those are different problems and the second is much
the easier one. Nothing in this build infers what a control does from what it
is called, and nothing here should be read as claiming otherwise.

`credential_submission_to_third_party` sits between the two. Its field half
exists and its destination half is observed, but password entry is refused
before the destination is ever consulted, so the third-party condition has
never had to be correct. It is not counted as closed.

Recorded in `PROHIBITION_ENFORCEMENT` and in `../security.md`.

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

### Gap-4 — credential-manager boundary (half closed, half deliberately open)

The _refusal_ half is now closed and, by product decision, is stricter than a
confirmation would be: `browser.type` and `browser.set_value` refuse a password
or one-time-code field outright, in Manual, Auto and Skip alike. An agent that
can be talked into typing a credential behind a prompt is an agent that can be
talked into typing a credential; the prompt only moves who is blamed.

The _manager_ half is open and stays open. The comparison product documents a
password-manager boundary (E1); this build has no password-manager integration
and does not claim one. Credential entry belongs to the person until that
changes, which is a separate design with its own trust questions.

### Gap-5 — outbound MCP (server half now settled, by evidence)

P-026 has been scoped as "consume external tools". The comparison product also
**exposes** browser capability over MCP.

The client half stands as it was: remote MCP over HTTPS fits this architecture,
and what is undecided is per-tool approval granularity — a product decision, not
a blocker.

The server half is **settled against implementing it**, and §13 is why. The
benchmark carries that direction over a native messaging host plus a vendor
cloud relay. Both are on the locked prohibition list. So this is not "a
transport decision nobody has taken": the only transport the benchmark is
documented to use is one this project has already refused, twice, for reasons
that have nothing to do with MCP. Reopening it means reopening "do not make the
machine a server", which is a product decision and not an engineering one.

`PLUGIN_TRUST_MODEL.md` §9 reached the same conclusion from the manifest alone.
This is the external corroboration it did not have.

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

Sections 1–8 and the gaps were gathered on 2026-09-24. Sections 9–17 were added
on 2026-09-25 by the Wave 9 parity audit; the new citations are marked below.

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

E4 — third-party permission-list reports, used for the manifest permission set ·
[`claude-code` #35110, session activity log, **closed as not planned**](https://github.com/anthropics/claude-code/issues/35110)
— the vendor's own tracker, cited in §12 for the _absence_ of an action trail ·
[`agent-browser` #1920, `fill` on a read-only or disabled input](https://github.com/vercel-labs/agent-browser/issues/1920)
— a different product, cited in §8 only as evidence that the failure mode is real
only and not for behaviour.

## What would resolve the unknowns

Eight of the seventeen sections above still rest on documentation alone, and
three questions have no published answer in any surface: what a scheduled run
does when it needs approval, what happens to an occurrence missed while the
browser was closed, and whether the browser must be open at all (Gap-2).

Installing the extension and observing it. One session settles Gap-2 entirely,
replaces the E4 permission list with the shipped manifest, and enumerates the
`claude-in-chrome` tool surface through `/mcp`. Nothing short of that will.
