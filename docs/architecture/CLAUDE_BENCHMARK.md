# Claude Extension behaviour benchmark

The locked product goal names the Claude Extension as the benchmark for
capability **and behaviour**. Until now this repository measured itself against
`docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`, which is a
specification, not an observation. This file records what the comparison
product is actually documented to do, so a parity claim has something to be
checked against.

## What this document is not

**Sections 1–17 rest on documentation, not observation.** They were gathered
from published sources on 2026-09-24 and are labelled with where each fact came
from. A reader deciding what to build should treat the UNKNOWN rows as the most
important ones in the file.

**Section 0 is different, and it is new.** A shipping copy of the extension is
installed on the machine this repository is developed on, and its shipped files
were read directly. That is E0 for the _artefacts_ — the manifest Chrome
loaded and the interface strings the build carries — and it is **not** E0 for
behaviour: nobody has signed into it, run a task in it, or watched it act on a
page. The two are kept apart throughout, because a string proves a surface
exists and says nothing about what happens when it is used.

### Evidence classes

| Class   | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| **E0a** | The shipping extension's own files, read from an installed copy (§0) |
| **E0b** | The shipping extension observed running — **none held**              |
| **E1**  | Official documentation about Claude in Chrome specifically           |
| **E2**  | Official documentation about a directly related product              |
| **E3**  | Official product or blog documentation                               |
| **E4**  | Reliable third-party evidence                                        |
| **E5**  | Inference                                                            |

E2–E5 is never promoted to E1, and E0a is never promoted to E0b. Where two
surfaces disagree the conflict is preserved rather than resolved.

An earlier revision of this table had a single **E0** row reading "**none
held**". That was true when it was written and is now wrong for half of what E0
meant, so the row was split rather than relabelled: collapsing an artefact read
and a behavioural observation into one class is exactly the promotion the
classes exist to prevent.

---

## 0. What an installed copy shows (E0a)

Read on 2026-10-02 from the extension Chrome had already unpacked on this
machine, at
`~/Library/Application Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.97_0/`.
Two files: the `manifest.json` Chrome loads, and `i18n/en-US.json`, the build's
own 941 interface strings. Extension id `fcoeoabgfenejglbffodgkkbkcdhcgfn`,
name `Claude`, version **1.0.97**, manifest version 3.

Nothing was signed into, started or driven. Every statement here is about a
file's contents.

### 0.1 The manifest, against this build's

`minimum_chrome_version: 116`, an `options_page`, one command
(`toggle-side-panel`), `externally_connectable` restricted to `claude.ai` and a
managed-storage schema.

| Permission                                                                                                                       | Claude 1.0.97 | This build                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- |
| `sidePanel`, `storage`, `activeTab`, `scripting`, `debugger`, `tabGroups`, `tabs`, `alarms`, `notifications`, `unlimitedStorage` | yes           | yes                         |
| `downloads`                                                                                                                      | required      | **optional**                |
| `webNavigation`                                                                                                                  | yes           | no                          |
| `declarativeNetRequestWithHostAccess`                                                                                            | yes           | no                          |
| `offscreen`                                                                                                                      | yes           | no                          |
| `nativeMessaging`                                                                                                                | yes           | no — **prohibited**         |
| `identity`                                                                                                                       | yes           | no                          |
| Host access                                                                                                                      | `<all_urls>`  | `http://*/*`, `https://*/*` |

Content scripts: an accessibility-tree script on `<all_urls>` with
`all_frames: true` at `document_start`, a visual-indicator script on
`<all_urls>` with `all_frames: false` at `document_idle`, and a third script on
`claude.ai` only.

Three things this settles that were previously inference or E4:

- **The E4 permission list is replaced by the shipped manifest.** "What would
  resolve the unknowns" named this as one of the things only an installed copy
  could settle. It is settled.
- **`nativeMessaging` is really there.** §13 inferred it from how the MCP
  surface must be carried. The inference was right, and divergence 2 in the
  table below — _Claude can spawn a local MCP process; this build cannot_ —
  now rests on the manifest rather than on reasoning about it.
- **Six permissions and `<all_urls>` are a real difference, not a cautious
  guess about one.** This build refuses `nativeMessaging` outright and takes
  `downloads` only when asked for it. `webNavigation`, `declarativeNetRequest`,
  `offscreen` and `identity` were never requested. None of that changes here on
  the strength of the comparison: a wider permission set is not a capability
  the benchmark has and this build lacks, it is a wider permission set.

The `all_frames: true` accessibility script is the one difference worth naming
as a capability rather than a posture. This build injects into the top frame
only, so a control inside a cross-origin iframe is outside what it can read.
That is a narrower reach, recorded here and not closed by this pass.

### 0.2 The interface strings, counted

The build ships 941 strings. The counts below are of the whole file, keys and
values together, case-insensitive.

| Term        | Occurrences | What the strings are                                                              |
| ----------- | ----------- | --------------------------------------------------------------------------------- |
| `plugin`    | **0**       | —                                                                                 |
| `mcp`       | **0**       | —                                                                                 |
| `connector` | 3           | `Connectors`, `Manage connectors`, `This connector has known issues`              |
| `skill`     | 4           | `Loaded skill`, `Loading skill`, `Used a skill`, `Used {count} skills`            |
| `cowork`    | 4           | including `Embed claude.ai Cowork in the side panel instead of the classic chat.` |
| `shortcut`  | 25          | including `Type / in the chat to use shortcuts or run them on schedule`           |

**This is direct evidence for §4b's adjudication, and it agrees with it.** The
shipping extension's own interface has no word for a plugin and no word for
MCP. §4b concluded on E2 that plugins are a Cowork-side surface and that the
extension is neither an MCP client nor an MCP server (Gap-5); 941 strings
containing neither term is what that conclusion predicts. It remains an
_absence_ and is recorded as one: a build can reach a capability through
strings that do not name it, and these files do not rule that out. What they do
rule out is a **plugin management surface inside the extension**, which is the
thing P-025 would have had to match.

The `connector` and `skill` counts are the same kind of fact. Three connector
strings are a management entry point — a list, a way in, one error — and not a
connector framework's worth of interface. Four skill strings are all activity
indicators: _loading_, _loaded_, _used_. Neither set describes authoring,
editing or configuring. On E0a the extension **surfaces** connectors and skills
that live somewhere else, which is what §4a says on E1.

### 0.3 Workflow recording, and the one capability this file did not know about

Thirty strings concern recording. Two groups matter.

**A step list, collapsible, with a position indicator.** `Steps ({count})`,
`Hide steps`, `Steps`, `Step {currentStep} of {totalCount}`,
`{collapsedCount, plural, one {# step} other {# steps}}`, and
`Click through your task to record each step`.

§9 recorded recording as E1 and said nothing about what a recording shows while
it runs, because no documentary source does. This build had a step **count** and
nothing else, and its own panel said so in a comment: _"While a recording runs,
the step count is the only feedback that anything is being captured."_ A count
cannot answer the question the person recording actually has — _was that last
thing the step I meant?_ — and it is worse than neutral here, because this
recorder drops steps it cannot write down and keeps counting, so the number
rises whether or not the right thing was captured.

**Closed in this pass.** `workflow.recordStatus` now carries the ordered steps
and the gaps between them, described by the same `digestStep` the saved review
list uses, and the panel renders them under a `Steps (n)` / `Hide steps`
control. A step that could not be recorded reaches the user while the step
could still be taken again, instead of only in the result of stopping. Covered
by `tests/unit/workflow-step-digest.test.ts`,
`tests/unit/workflow-recording.test.ts` and, in real Chromium,
`tests/e2e/workflows.spec.ts :: a running recording reports its steps, and its
gaps, before it is saved`.

**Voice narration — observed, and not built.** Eleven strings:
`Turn on voice narration`, `Turn off voice narration`, `Toggle voice
narration`, `Voice narration active`, `Voice narration paused`, and the
microphone-permission flow around them — `Claude needs microphone access to
hear your voice narration while you demonstrate workflows`, `Enable microphone
access to use your browser's speech-to-text functionality for voice narration
during workflow recording`, and `Recording workflow without speech` for the
case where it is declined.

This is a capability no documentary source in this file mentioned, and it is a
genuine divergence. It is **not** implemented here, and not for want of effort:
it would require microphone access, which is not in this build's permission set
and is not something to add on the strength of a string file. The benchmark's
own strings show it degrades gracefully when declined, which is the shape a
later implementation should take if one is made — an opt-in that leaves
recording working without it. Recorded as divergence 11 below.

### 0.4 What §0 does not settle

Gap-2 is untouched: scheduled-run semantics are behaviour, and no file read
here describes them. The `claude-in-chrome` tool surface is untouched for the
same reason. Nothing in §0 promotes any E1, E2, E4 or E5 claim in §§1–17, and
nothing in §0 lowers one either — the two kinds of evidence sit side by side.

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

## 4. Plugins, skills, connectors, MCP (E2, with an E1 correction below)

A plugin _"bundles skills, connectors, and sub-agents into a single package"_
and may include _"local MCP servers that run on your computer with the same
permissions as any other program you run."_ Installed from marketplaces, a git
URL or a custom upload; auto-updates; uninstallable except where an
organization requires them. Trust is delegated to the user — _"Only install
plugins from sources you trust"_ — with optional Enterprise scanning.

### 4a. Which mode plugins belong to (E1) — and the correction that produced it

§2 says a single "Claude Extension behaviour" does not exist and that **which
mode is being matched has to be stated**. This section never stated it, and the
P-025 adjudication is what forced the question.

The Claude in Chrome get-started article was read twice during that adjudication.
The first reading reported no mention of plugins and that reading was **wrong**.
A targeted re-read found the sentence _"Your skills, plugins, and connectors work
here."_ It sits under _"Chat with Claude in the browser side panel"_, describing
the **Cowork-session** side panel, available _"On Max and Team plans, on Pro plans
as the rollout reaches you, and on Enterprise plans where your admin has enabled
it."_ The error is recorded rather than quietly fixed, because an absence of
evidence had briefly been treated as evidence of absence — the exact move the
evidence classes exist to prevent.

The two modes carry **different and partly disjoint** capability sets:

| Mode               | Documented capabilities (E1)                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Classic**        | record a workflow, console logs, scheduled tasks, multi-tab, enhanced site navigation, 1Password sign-in, background workflows, visual context, image uploads, shortcuts, contextual suggestions |
| **Cowork session** | skills, plugins and connectors work; sessions saved to history and continued across web, desktop and mobile                                                                                      |

Two facts follow, and they point in opposite directions:

- **Plugins are not listed among classic-mode capabilities.**
- **Recording is not available in Cowork mode** — §2 already quotes _"Recording
  isn't available when the side panel runs as a Cowork session."_

So the modes are not a subset relationship. This project's capability set —
workflow recording (P-022), shortcuts (P-021), scheduled tasks (P-020), console
and network inspection, multi-tab, background continuation — is the **classic**
set, and the specification says so in its own baseline: _"record workflows in the
classic side panel"_ (§1).

**The mechanism by which plugins reach the Cowork side panel is a cloud session.**
The product page places _"The skills, plugins, and connectors you've already built
are there, with nothing to set up in the browser"_ under the heading _"Your whole
setup, in the side panel"_, and the help centre states the side panel **runs as a
Claude Cowork session**. "Already built" and "nothing to set up in the browser"
both locate plugin creation, configuration and lifecycle outside the extension.
This is the same shape §13 established for MCP: the capability is visible in the
side panel while the mechanism is a cloud session, not the extension.

The `claude-in-chrome` MCP server is blockable by the `deniedMcpServers` managed
setting, with tools viewable through `/mcp`. MCP tools marked
`requiresUserInteraction` prompt on every call. **Where that server actually
runs is not the extension** — see §13, which corrects an earlier reading of this
paragraph and decides Gap-5's server half.

### 4b. P-025 adjudication — is a plugin system required for extension parity?

The locked goal measures against **the Claude browser extension**, and §2 requires
the mode to be named. Naming it settles P-025.

**Finding: plugin availability is documented Claude-in-Chrome behaviour in
Cowork-session mode only, and the mechanism that delivers it is a cloud session
this project's locks forbid as a runtime dependency.**

Four facts, each with its class:

1. Plugins are documented as working in the Chrome side panel — _"Your skills,
   plugins, and connectors work here."_ **(A)**
2. That sentence describes the **Cowork-session** side panel, not the classic
   one, and plugins are absent from the classic capability list. **(A)**
3. The side panel in that mode **runs as a Claude Cowork session**, and plugin
   creation and configuration happen outside the browser — _"nothing to set up in
   the browser"_. **(A)** for the wording; **(C)** for the inference that the
   extension hosts no plugin runtime of its own.
4. No Claude-in-Chrome source documents plugin installation, a plugin registry, a
   plugin manifest, plugin permissions, plugin trust metadata or a plugin
   lifecycle **as extension behaviour**. The permissions guide and the admin
   controls article do not mention plugins at all. **(A** as documented silence —
   recorded as silence, never as a denial.**)**

What this does **not** say: it does not say Claude in Chrome lacks plugins. It
says the only documented route by which plugins reach that side panel is a cloud
session, and the locked architecture states the backend "must NOT become a
mandatory runtime dependency for normal browser-agent operation".

So there are exactly two ways this project could reach plugin parity, and neither
is a parity obligation:

- **Reproduce the mechanism** — run the agent as a cloud session and surface an
  account's plugins in the panel. Barred by the locks: standalone, local-first, no
  cloud runtime dependency.
- **Reproduce the capability locally** — a local plugin format over
  already-registered tools (`PLUGIN_TRUST_MODEL.md` §9b models B and F). Possible,
  and it would be **this project doing something the Claude extension does not
  do**, rather than matching it.

The second is a product decision, not a parity requirement. That is the
adjudication: **P-025 is an internal specification requirement (§5.10) and is not
demonstrated as Claude-in-Chrome extension behaviour.** The specification keeps
it; the parity critical path does not.

One clause is separate. §5.10's _"bundled MCP servers where supported"_ maps to
plugin content that Claude documents as _"local MCP servers that run on your
computer with the same permissions as any other program you run"_. Running a
local process at user privilege requires native messaging or local process
execution, both on this project's locked prohibition list. The clause's own
_"where supported"_ qualifier is what resolves it: it is not supported here, by
decision. Note that this is a different thing from P-026-C3 local MCP, which is
VERIFIED — this build connects to a local MCP server over Streamable HTTP; what it
does not do is **spawn** one.

**Checked against the shipping extension's own files, after the fact (E0a).**
This adjudication was reached on E2, with the documented silence recorded _as_
silence. §0.2 then read the build's 941 interface strings: `plugin` occurs
**zero** times and `mcp` occurs **zero** times. That is what this adjudication
predicted and it is the strongest evidence available short of running the
extension, but it does not turn the adjudication into a proof. An absence of
strings rules out a plugin management surface **inside the extension** — the
thing P-025 would have had to match — and does not rule out the extension
reaching plugin content through an interface that never names it. The
disposition is unchanged, now on firmer ground: **P-025 stays an internal
specification requirement and off the parity critical path.** Nothing here
argues it to PASS, and §0.2's own caveat is kept rather than dropped.

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

**Extended on E0a, 2026-10-02.** This section rested on one sentence of E1,
which describes recording as _record icon, perform the steps, stop_ and says
nothing about what the recorder shows while it runs. The shipping build's own
strings say more: a collapsible step list with a position indicator, and voice
narration with a microphone-permission flow around it. §0.3 has both, what was
built in response to the first, and why the second is recorded as a divergence
instead. The twenty-five `shortcut` strings are consistent with this section's
E1 account, including scheduling — `Type / in the chat to use shortcuts or run
them on schedule` — so the behaviour difference above stands as written.

## 10. Multi-tab is a tab group (E1)

_"Drag tabs into Claude's designated tab group to enable Claude to view and
interact with all grouped tabs at once."_ From the Claude Code side:
_"The extension collects the tabs Claude opens into a Chrome tab group tied to
your session."_

Same design as this build's browser workspace, arrived at independently, and
one of the closest behavioural matches in the file. Drag-in and drag-out are
covered here by real-Chromium tests.

**Per-tab operations: UNKNOWN, and checked.** Nothing published describes the
benchmark's tab handling at the level of individual operations. There is no
documented counterpart for _reordering_ a tab (this build's `tabs.move`) and
none for _describing one named tab_ (`tabs.get`). What the published material
says is that grouped tabs can be viewed and interacted with collectively; it
does not say whether the benchmark can reorder a tab, whether it can address
one tab by identity, or whether it exposes any per-tab operation to its model
at all.

So this is recorded as UNKNOWN rather than as parity or as a divergence. Both
tools were built because **specification §10 lists them**, which is this
project's own requirement, and §10 is met whatever the benchmark does. No
inference runs the other way either: the absence of documentation is not
evidence that the benchmark lacks the capability. A tab-group UI that lets a
person drag tabs around has reordering by definition — what is unknown is
whether its _agent_ can do it.

Resolving it needs E0 — direct observation of the extension — which nobody on
this project holds. It is listed under "What would resolve the unknowns".

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

## Every divergence, classified

The final audit's ninth part asked for each divergence from the benchmark to be
put in a category rather than left as prose: documented, tested, intentional,
security-mandated, external, or unresolved. Two rules governed it. **Do not
invent parity** — a divergence is not closed by describing it well. And **do not
downgrade a capability because the benchmark's behaviour is undocumented** —
absence of evidence about Claude is a gap in what is known, not a deficiency
here.

| #   | Divergence                                                               | Category                                           | Where it is settled                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Sessions live with the account vs local-first                            | **Intentional** — locked product decision          | `LOCAL_FIRST_ARCHITECTURE.md`; tested by the local-first suite                                                                                                                          |
| 2   | Claude can spawn a local MCP process; this build cannot                  | **Security-mandated**                              | Native messaging is on the locked prohibition list. Local MCP itself is _not_ divergent — see the note under Gap-6                                                                      |
| 3   | MCP client in a cloud session vs in the extension                        | **Intentional** — there is no session to host it   | `MCP_GUIDE.md` §1, and tested against a real server                                                                                                                                     |
| 4   | Claude models vs an interchangeable provider                             | **Intentional** — the locked product goal          | Provider conformance suite across three adapters                                                                                                                                        |
| 5   | User-driven reconnect vs automatic reconciliation on startup             | **Intentional**, and stricter here                 | MV3 lifecycle suite                                                                                                                                                                     |
| 6   | Claude has a plan → approve → execute step (Gap-3)                       | **Documented and built**                           | The Classic plan; nineteen real-Chromium cases                                                                                                                                          |
| 7   | Claude's declared prohibitions (purchases, account creation, card entry) | **Documented and built** (Gap-1, partially closed) | Nine hard prohibitions, refused in every mode including Skip                                                                                                                            |
| 8   | Chrome's scheduled-run semantics have no Claude answer (Gap-2)           | **Unresolved — and not this project's to resolve** | Three questions with no published Chrome answer. Answered here by decision, and the decisions are written down                                                                          |
| 9   | Credential-manager boundary (Gap-4)                                      | **Half intentional, half unresolved**              | The open half is stated as open rather than argued closed                                                                                                                               |
| 10  | No action-by-action trail in Claude (§12, E1 absence)                    | **Divergence in this project's favour**            | The audit trail exists here. Not a gap to close                                                                                                                                         |
| 11  | Voice narration while recording a workflow (§0.3, E0a)                   | **Unbuilt — and named rather than quietly absent** | Eleven shipped strings describe it. It needs microphone access, which is not in this build's permission set; adding one on the strength of a string file is not a trade this pass makes |
| 12  | `all_frames: true` accessibility injection (§0.1, E0a)                   | **Divergence against this build, narrower reach**  | Claude reads every frame; this build reads the top frame only, so a control in a cross-origin iframe is out of reach. Recorded, not closed                                              |

**On category "external".** No divergence in this table is external in the sense
Part 11 uses — none is waiting on a credential or an account. The external
blockers are about _evidence for capabilities_, not about differences from the
benchmark, and conflating the two would let an unresolved divergence hide behind
a blocker that has nothing to do with it.

**On category "unresolved".** Two entries are unresolved and both are unresolved
_about Claude_, not about this build: Chrome's scheduled-run semantics, and half
of the credential-manager boundary. Neither can be closed by work here, and
neither is recorded as a deficiency — the evidence classes exist precisely so
that "we do not know what Claude does" reads differently from "this is missing".

**On entries 11 and 12, which are the first two in this table that are
divergences against this build.** They were found by reading the shipping
extension's own files (§0), and neither is unresolved in the sense above: what
Claude does is known in both cases, and this build does not do it. Entry 11 is
not built and entry 12 is a narrower reach, and both are named rather than
argued away. Writing them down in the same table as the intentional divergences
is the point — a table that only recorded differences in this project's favour
would be a worse table.

Neither is closed by this pass, and the reason is the same in both cases: each
would cost a permission. Voice narration needs the microphone, and reading
every frame needs `all_frames: true` on `<all_urls>`. The locked goal makes the
Claude Extension the benchmark for capability; it does not make its permission
set the benchmark for this one, and a string file is not a reason to widen a
boundary. A decision to pay either cost is the owner's to make, with the cost
stated, which is what these rows are for.

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

### Gap-5 — MCP (closed; neither half is a gap against the extension)

Re-audited in Wave 29 and closed. `docs/MCP_GUIDE.md` carries the full record;
what belongs here is the benchmark evidence, because it turned out to say
something different from what this section assumed.

**The comparison extension is not an MCP client** (E1/E3). The side panel "runs
the same Claude Cowork session you use on desktop, web, and mobile", and that is
why "your skills and connectors work in the browser". The connectors themselves
are remote MCP reached **from the vendor's cloud, not from the browser**: a
custom connector's "MCP server must be reachable over the public internet from
Anthropic's IP ranges", and private-network servers must allowlist those
addresses. Local MCP servers configured on the desktop "aren't available in
Cowork or claude.ai".

**And it is not an MCP server**, per §13: `claude-in-chrome` is a reserved
built-in server name inside the coding agent, reaching the extension over a
native messaging host.

So MCP lives entirely in the runtime behind the extension, in both directions,
and the extension is the surface that runtime is displayed in. Against the
parity floor — the comparison **extension** — there is no MCP gap at all.

That does not make P-026 optional, and the reason is worth keeping straight:
§5.11 asks for an `MCP client` as a component of _this_ project, so the
specification is the authority for it rather than parity. It also means the
client has to live in the extension or nowhere, because this build has no cloud
session to delegate it to — the brain is an interchangeable provider API and
browser-agent operation must not depend on the backend.

**The server half stays settled against implementing it**, now on two grounds
rather than one. §13's is unchanged: the benchmark carries that direction over a
native messaging host plus a vendor cloud relay, both on the locked prohibition
list. The new one is that §5.11 never asked for it — it names a client and lists
no server component — so this is not a deferred requirement anybody is owed.

**What the vendor's own MCP client does** (E1), usable as evidence of careful
practice though it sets no parity obligation, because it is the coding agent and
not the extension: an MCP tool call prompts by default; the escape is a rule the
**user** writes, at `mcp__<server>` or `mcp__<server>__<tool>` scope; deny and
ask rules may use unanchored globs but an **allow** glob must name a literal
server, and `mcp__*` as an allow "is skipped with a warning and doesn't
auto-approve anything"; a settings rule matching an MCP tool's arguments is
skipped as invalid, so argument-level allows do not exist; a server-declared
`requiresUserInteraction` forces a prompt that no allow rule, hook or permission
mode can silence; and an organization setting a connector tool to `ask`
overrides user rules the same way. Every channel by which a server or an org
influences authority runs **toward more confirmation, never less**. `MCP_GUIDE.md`
§5 adopts that asymmetry.

One row of that evidence is a hazard rather than a model: `list_changed`
refreshes a server's tool set "without requiring you to disconnect and
reconnect", so a previously written server-scoped allow rule silently covers
tools that did not exist when it was written. This project's R3 classification
makes the situation unreachable, which is recorded in `MCP_GUIDE.md` §5.1 as the
reason the earlier per-server ceiling was withdrawn.

**Re-checked on E0a, 2026-10-02.** The shipping build's interface strings
contain the word `mcp` zero times in 941 strings (§0.2). Gap-5 concluded on four
W29 sources that the extension is neither an MCP client nor an MCP server; this
is consistent with it, and is an absence rather than a proof, for the reason
§0.2 gives. The conclusion is unchanged.

### Gap-6 — deliberate divergences, recorded as such

Not gaps to close:

| Behaviour                    | Claude                              | This project                             |
| ---------------------------- | ----------------------------------- | ---------------------------------------- |
| Session storage              | _"sessions live with your account"_ | Local-first, by locked decision          |
| Spawning a local MCP process | Supported (E1)                      | Refused — extension-only, no native host |
| MCP client                   | In the cloud session (E1)           | In the extension — no session to host it |
| Provider                     | Claude models                       | Interchangeable brain, by locked goal    |
| Worker-eviction recovery     | User-driven reconnect (E2)          | Automatic reconciliation on startup      |

That first row said "Local MCP / native process … Refused" until the final
audit's parity pass read it against what the product now does. It conflated two
things, and the conflation had already cost something: it is the same reading
that kept `P-026-C3` classified as external.

**Local MCP is not refused and is not a divergence.** This build connects to an
MCP server on loopback over Streamable HTTP, and
`tests/integration/mcp-interop.test.ts` does exactly that against the MCP
project's reference server on every run. What is refused is _spawning_ one —
launching a local process and speaking stdio to it, which needs native messaging
and is on this project's locked prohibition list. A person who runs a server
themselves can point this extension at it today.

So the divergence is narrower than the row claimed: Claude can start a local MCP
process for you; this extension requires you to start it yourself. That is a
convenience difference, not a capability one, and it is security-mandated rather
than merely chosen — native messaging would give the extension arbitrary local
process execution, which no approved design here has.

---

## Sources

Sections 1–8 and the gaps were gathered on 2026-09-24. Sections 9–17 were added
on 2026-09-25 by the Wave 9 parity audit; the new citations are marked below.
Gap-5 was re-gathered on 2026-09-27 by the Wave 29 P-026 scope audit, against
the four sources marked **W29**. Section 0 was read on 2026-10-02 from the
installed copy and cites no published source at all, which is the point of it.

E0a — `Claude` 1.0.97, extension id `fcoeoabgfenejglbffodgkkbkcdhcgfn`, as
Chrome unpacked it on the development machine: `manifest.json` and
`i18n/en-US.json`. Not a download, not a decompiled bundle, and not the
extension running — the files Chrome loads, read where Chrome put them. A
reader on another machine can repeat it only if they have the extension
installed; the version is pinned here so a later copy that disagrees is
recognisable as a different build rather than as this one being wrong.

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
[Skills, connectors and plugins directory](https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory) ·
**W29** [Custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) ·
**W29** [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp) ·
**W29** [Configure permissions](https://code.claude.com/docs/en/permissions)

E3 — [Piloting Claude for Chrome](https://claude.com/blog/claude-for-chrome) ·
**W29** [Cowork in the Chrome side panel](https://claude.com/blog/cowork-chrome-side-panel) ·
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
browser was closed, and whether the browser must be open at all (Gap-2). A
fourth joined them with §10: whether the benchmark exposes any _per-tab_
operation to its model — reordering a tab, or addressing one tab by identity —
as against the collective view of a group that the documentation describes.

Installing the extension and observing it. Half of that has now happened and
is §0: the extension is installed, and its shipped manifest has replaced the E4
permission list. The other half has not. Gap-2 and the `claude-in-chrome` tool
surface are both **behaviour**, and reading a build's files establishes neither
— they need a session that is signed in and driven, which is E0b and is still
none held.
