# Browser Workspace — Architecture Review

Status: **design review, now partly implemented.** Steps W-1 to W-5 and W-7 of
§22 are built and validated; **W-6 (workspace routes and side-panel UI) is
not**. The audit in §2 is from the tree at `a3cafad`, before any of it was
built; the Chrome API findings in §3 were measured in real Chromium.

| Step                                                         | State           |
| ------------------------------------------------------------ | --------------- |
| W-1 model and membership predicate                           | **done**        |
| W-2 store: durable record, session-scoped binding            | **done**        |
| W-3 reconciliation from real Chrome events                   | **done**        |
| W-4 the guard, narrowed enumeration, `AgentTask.workspaceId` | **done**        |
| W-5 agent-created tab lifecycle                              | **done**        |
| W-6 `workspace.*` routes and side-panel UI                   | **not started** |
| W-7 security suite, mutations, real Chromium                 | **done**        |

Because W-6 is absent, a workspace is created implicitly from the tab the user
activates the agent on (§9), and there is no UI yet to switch workspaces,
re-attach a detached one, or add the current tab deliberately. The boundary is
live and enforced; what is missing is the user's control surface over it.

---

## 1. Executive summary

The agent currently has **no browser context boundary at all**.
`ChromeBrowserAdapter.listTabs()` is `chrome.tabs.query({})` — every tab in
every window — and `requireTab()` acts on whatever tab id the model supplies.
A task started from a CRM tab can enumerate and act on the user's bank tab in
another window, and nothing in the authorization stack is designed to stop it,
because every control in that stack answers _"may this action happen"_ and
none answers _"is this tab even in scope"_.

Workspaces close that gap. A workspace is a durable `workspaceId` owned by the
extension, bound at runtime to one Chrome tab group. Membership **narrows**
which tabs are eligible context; it never widens what may be done to them.
Every existing control stays exactly where it is and runs exactly as often.

Two design decisions carry most of the weight:

- **Chrome is authoritative for current membership; the stored record is
  authoritative for identity.** The guard performs a _live_ `chrome.tabs.get()`
  and compares `groupId` on every browser operation. A cached record can never
  grant access, which is what makes a dragged-out tab stop being context
  immediately rather than at the next event.
- **Agent-created tabs are created blank, grouped, verified, and only then
  navigated.** Measured: `chrome.tabs.create` returns `groupId: -1`, so the
  race is real — but if nothing has loaded yet, the race window contains no
  page.

---

## 2. Current architecture audit

Files inspected, with what each actually does today.

### 2.1 Tab management abstraction

`src/tools/browser/chrome-adapter.ts` — `BrowserAdapter` (18 methods) and
`ChromeBrowserAdapter`. This is the single abstraction; a fake implements it
in tests.

```ts
listTabs()  →  chrome.tabs.query({})                              // line 87
getActiveTab() → chrome.tabs.query({active:true,lastFocusedWindow:true}) // 100
getTab(id)  →  chrome.tabs.get(id)                                // 93
createTab() →  chrome.tabs.create({url, active, windowId})        // 105
```

`TabInfo` already carries `groupId: number` (line 20). `CreateTabOptions`
does **not** accept a group (line 23–27).

### 2.2 Every `chrome.tabs` use

| File                                     | Use                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/tools/browser/chrome-adapter.ts`    | query ×2, get ×2, create, remove, reload, update ×2, move, group, ungroup, goBack, goForward, onUpdated, onRemoved |
| `src/messaging/bus.ts`                   | `sendMessage(tabId, …)` — worker → content script                                                                  |
| `src/connectors/oauth/auth-flow-port.ts` | create/remove/onUpdated/onRemoved for the OAuth tab (deliberately outside any workspace)                           |
| `src/content/content-script.ts`          | comment only                                                                                                       |
| `src/background/service-worker.ts`       | `onRemoved` listener, line 2220                                                                                    |

### 2.3 Every `chrome.tabGroups` use

**One call.** `chrome-adapter.ts:194` — `chrome.tabGroups.update(groupId, {title})`,
inside `groupTabs()`. No listeners are registered anywhere.

### 2.4 Every `chrome.windows` use

**One call.** `chrome-adapter.ts:120` — `chrome.windows.update(tab.windowId, {focused:true})`
inside `activateTab()`. No listeners.

### 2.5–2.6 Where `tabId` / `windowId` are persisted

| Location                         | Field                      | Persisted?                           |
| -------------------------------- | -------------------------- | ------------------------------------ |
| `src/tasks/task-model.ts:144`    | `AgentTabContext.tabId`    | in the task record — **but see 2.7** |
| `src/audit/audit-log.ts:189`     | `AuditEvent.tabId?`        | yes, historical record               |
| `src/audit/dispatch-audit.ts:79` | copies observation `tabId` | yes                                  |

`windowId` is **never persisted anywhere.** It exists only on the transient
`TabInfo`.

### 2.7 Task ↔ tab association — **the field is dead**

`AgentTask.tabs: readonly AgentTabContext[]` (`task-model.ts:175`) is set to
`[]` in `createTask` (line 276) and **never written again**. Nothing in
`task-manager.ts`, `agent-runtime.ts` or any tool populates it. The
specification §15 shape exists; the behaviour does not.

**There is therefore no task-to-browser-target model today.** A task does not
record which tabs it touched, and no code consults such a record before
acting.

### 2.8–2.9 Tools that target a tab

27 tools. All take an optional `tabId` through `ToolExecutionContext`
(`tool-registry.ts:48`, `tool-types.ts:26`):

- **query**: `tabs.list`, `tabs.get_active`
- **create/close**: `tabs.create`, `tabs.close`
- **navigate**: `browser.navigate`, `browser.go_back`, `browser.go_forward`, `tabs.reload`, `browser.reload`, `tabs.wait_for_navigation`
- **activate**: `tabs.activate`
- **group**: `tabs.group`, `tabs.ungroup`
- **act on page**: `browser.click`, `browser.type`, `browser.select`, `browser.select_many`, `browser.set_value`, `browser.set_checked`, `browser.scroll`, `browser.wait`, `browser.read_page`
- **screenshot**: `browser.screenshot`
- **debugger**: `debugger.console`, `debugger.dom`, `debugger.network`, `debugger.page_state`, `debugger.detach`

### 2.10 Side-panel active-tab behaviour

**None.** `grep` for `getActiveTab|activeTab|tabId` across `src/sidepanel/`
returns nothing. The panel has no concept of which tab is in front.

### 2.11 Service-worker tab lifecycle

**One listener**, `service-worker.ts:2220`:

```ts
chrome.tabs.onRemoved.addListener((tabId) => {
  lifecycle.handleTabClosed(tabId);
});
```

`LifecycleManager.handleTabClosed` (`lifecycle-manager.ts:75`) detaches the
debugger and nothing else. No `onUpdated`, `onActivated`, `onAttached`,
`onDetached`, `onMoved`, and no `tabGroups` listeners at all.

### 2.12 Worker restart / recovery

`startup()` re-reads settings and restores task state. No browser-target state
is restored, because none is stored.

### 2.14 Stores that could own workspace metadata

`NamespacedStorageArea(local, …)` over `SerializedStorageArea`: `settings`,
`tasks`, `workflows`, `shortcuts`, `audit`, `evidence`, `accounts`,
`identity-profile`, `identity-session`, `health`, `policy`. A `workspaces`
namespace follows the same pattern. `chrome.storage.session` is available for
runtime bindings and is already used for connector tokens.

### 2.15 Audit model for browser-target changes

`AUDIT_EVENT_TYPES` (`audit-log.ts:31`) has 20+ types and **none** for a
browser-target or membership change. `AuditEvent` has an optional `tabId`.

### 2.16 The security boundary that prevents cross-tab targeting

**There is none.** This is the gap. `requireTab()`
(`browser-tools.ts:23–43`) resolves `context.tabId` or falls back to the
browser's active tab, then calls `assertAutomatable()` — which checks the URL
scheme via `checkNavigable`, i.e. _origin_ policy, not _scope_. Every other
control (consent, egress, taint, route trust, ToolRegistry, audit) governs
the action, not the eligibility of the target.

### 2.17 Real Chromium infrastructure for tab groups

Exists. `tests/e2e/agent-task.spec.ts:252–287` already drives `tabs.group`
through the real API and reads back `tab.groupId`, with a comment recording
that the unit fake proves the tool contract and nothing about Chrome. The
`extension` fixture supplies `context`, `serviceWorker`, `panel`, `site`,
`collector` and `killServiceWorker`, which is everything the plan in §17
needs.

---

## 3. Chrome API analysis — measured, not recalled

Run in real Chromium through the extension's own service worker. Two probes,
both since deleted; the findings are reproduced by the tests in §17.

| Question                        | Measured result                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `chrome.tabs.create` group?     | **`groupId: -1`** — created tabs are ungrouped                                                                                             |
| `TAB_GROUP_ID_NONE`             | `-1`                                                                                                                                       |
| `tabs.group({tabIds})`          | returns a new group id (e.g. `835905304`)                                                                                                  |
| `tabs.group({tabIds, groupId})` | joins the **existing** group in one call                                                                                                   |
| `tabs.query({groupId})`         | works — membership is queryable from Chrome                                                                                                |
| after `ungroup`                 | `tab.groupId === -1`                                                                                                                       |
| **group with no tabs left**     | **`tabGroups.get` throws — the group ceases to exist**                                                                                     |
| `tabGroups` events              | `onCreated`, `onUpdated`, `onMoved`, `onRemoved`                                                                                           |
| `tabs` events                   | `onCreated`, `onUpdated`, `onMoved`, `onRemoved`, `onAttached`, `onDetached`, `onActivated`, `onHighlighted`, `onReplaced`, `onZoomChange` |

**The event a drag produces** — the single most important finding, because
requirement 10 depends on it:

```
group a tab:    tabGroups.onCreated{id:97889869}
                tabs.onUpdated{tabId, changeInfo:{groupId:97889869}}

ungroup a tab:  tabs.onUpdated{tabId, changeInfo:{groupId:-1}}
                tabGroups.onRemoved{id:97889869}
```

There is **no `tabs.onGroupChanged`**. Membership changes arrive on
`tabs.onUpdated` with `changeInfo.groupId`. That is the reconciliation signal.

### Lifecycle limitations, stated plainly

- A tab group id is **not durable**. It dies with its last tab, and Chrome
  does not guarantee id stability across a browser restart even where session
  restore redraws the group.
- A `tabId` is **not durable and is recyclable**. A stored id may later name a
  different page.
- `windowId` is not durable.
- Therefore: **a Chrome tab group is not application identity**, and this
  design never treats it as such.

---

## 4. The `workspaceId` model

```
Workspace (persistent)                Runtime binding (session-scoped)
────────────────────────              ────────────────────────────────
workspaceId   ws_<uuid>               chromeWindowId    number
abaUserId     usr_… | unassigned      chromeTabGroupId  number
title         "Customer research"     boundAt           number
createdAt / lastActiveAt              boundGeneration   number
members[]     { origin, title, … }
taskIds[]
```

`workspaceId` is minted by the extension with `crypto.randomUUID()`, exactly
as `connectionId` is. It is never derived from a Chrome handle.

The runtime binding lives in `chrome.storage.session`, **not** `local`. That
is deliberate: a binding must not outlive the browser session that created it,
because the ids in it will name something else by then.

---

## 5. Task ↔ workspace relationship

Not one-to-one. `workspace = task` is rejected: a research workspace outlives
any single question asked in it, and forcing a new tab group per task would
make the group a task artefact rather than the user's working context.

```
abaUserId
   └── workspaceId ──┬── taskId, taskId, taskId       (many, over time)
                     └── member tabs                   (many, concurrently)
```

A task belongs to exactly **one** workspace, recorded as
`AgentTask.workspaceId` at creation and never changed. A task may act on
several tabs **within** that workspace. `AgentTask.connectionId` (from the
multi-account wave) and `AgentTask.workspaceId` are independent fields; see
§14.

Legacy tasks have no `workspaceId`. See §14 for why they fail closed.

---

## 6. Tab membership — the authoritative rule

> **Chrome is authoritative for _current_ membership. The stored record is
> authoritative for _identity_ and survives restarts. The guard reads Chrome
> live, every time.**

A pure conjunction of "record says yes AND Chrome says yes" fails requirement
4: a tab the user has just dragged in is in the Chrome group before any record
mentions it, and would be refused. A record-only rule fails requirement 5: a
dragged-out tab would stay a member until an event was processed.

So the deterministic predicate is:

```
isMember(workspaceId W, tabId T) :=
      runtime = sessionBinding(W)
      runtime ≠ null                                   else FAIL CLOSED
  ∧   tabGroups.get(runtime.chromeTabGroupId) resolves  else FAIL CLOSED (unbind)
  ∧   tab = tabs.get(T) resolves                        else FAIL CLOSED
  ∧   tab.groupId ≠ TAB_GROUP_ID_NONE                   else FAIL CLOSED
  ∧   tab.groupId = runtime.chromeTabGroupId            else FAIL CLOSED
```

Every clause is a live read. Nothing cached grants membership, so:

- a **stale tabId** fails, because the live `groupId` won't match (and a
  recycled id names a tab in no group, or another group);
- a **dragged-out tab** fails on the next operation, without waiting for an
  event;
- an **ungrouped tab** fails on `groupId === -1`;
- a **deleted group** fails when `tabGroups.get` throws.

The stored `members[]` list is a **mirror**, maintained by events, used for the
panel's display, for recovery, and for audit. It is never consulted to grant.

### Reconciliation

`tabs.onUpdated{changeInfo.groupId}` is the primary signal (§3). Also handled:
`tabs.onRemoved` (drop member), `tabGroups.onRemoved` (unbind the workspace),
`tabs.onAttached`/`onDetached` (window moved — update `chromeWindowId`),
`tabs.onReplaced` (id changed under a prerender swap). Inconsistency between
mirror and Chrome is always resolved **in Chrome's favour**, and a mirror
entry that Chrome does not confirm is dropped rather than trusted.

---

## 7. Runtime vs persistent identifiers

| Identifier                              | Class       | Storage   | Synced?        |
| --------------------------------------- | ----------- | --------- | -------------- |
| `abaUserId`                             | persistent  | `local`   | yes (identity) |
| `workspaceId`                           | persistent  | `local`   | eligible       |
| workspace title, `createdAt`, `taskIds` | persistent  | `local`   | eligible       |
| member **origin/title**                 | persistent  | `local`   | eligible       |
| `taskId`                                | persistent  | `local`   | eligible       |
| `connectionId` + `modelId`              | persistent  | `local`   | eligible       |
| **`chromeTabId`**                       | **runtime** | `session` | **never**      |
| **`chromeTabGroupId`**                  | **runtime** | `session` | **never**      |
| **`chromeWindowId`**                    | **runtime** | `session` | **never**      |

---

## 8. Lifecycle and rebinding

| Event                       | Runtime binding                                                                       | Workspace | Behaviour                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker restart**          | survives (`storage.session` outlives worker eviction — measured in the identity wave) | intact    | re-verify with `tabGroups.get`; unbind if it throws                                                                                                                                             |
| **Browser restart**         | gone (`storage.session` cleared)                                                      | intact    | workspace is **detached**: it exists, has no live members, and the panel offers to re-attach. Chrome ids are _not_ guessed from URLs — matching a restored tab by URL could bind the wrong page |
| **Extension reload**        | gone                                                                                  | intact    | same as browser restart                                                                                                                                                                         |
| **Group ungrouped/deleted** | `tabGroups.onRemoved`                                                                 | intact    | unbind; workspace detached, nothing deleted                                                                                                                                                     |
| **Last member closed**      | group ceases to exist (measured)                                                      | intact    | unbind on `tabGroups.onRemoved`                                                                                                                                                                 |
| **Tab closed**              | —                                                                                     | intact    | drop from mirror; tasks and history untouched                                                                                                                                                   |

A detached workspace is a normal state, not an error. Re-attaching is an
explicit user action that creates a fresh Chrome group and binds it.

---

## 9. Multiple workspaces

Supported, and **not** limited to one per window. A user may keep Workspace A
(CRM, email, portal) and Workspace B (GitHub, Jira, docs) as two tab groups in
one window; Chrome allows it and forbidding it would be an arbitrary
restriction. `chromeWindowId` is recorded for display and focus, never used as
the membership key.

**Active workspace selection is explicit and is never inferred from the active
tab.** Deriving it from the front tab would mean a stray click on a Workspace B
tab silently re-points a Workspace A task — exactly the cross-workspace
targeting this design exists to prevent. The active workspace changes only when
the user selects one, or when activating the agent from an ungrouped tab
creates one.

Cross-workspace isolation is §6 plus §14: a task carries its own
`workspaceId`, and the guard compares against that, not against whatever is
active now.

---

## 10. User drag and drop

| User action                       | Chrome events                                                | Result                                                      |
| --------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| drag outside tab **in**           | `tabs.onUpdated{groupId:W}`                                  | mirror gains the member; it is already eligible by §6       |
| drag member tab **out**           | `tabs.onUpdated{groupId:-1}`, possibly `tabGroups.onRemoved` | mirror drops it; already ineligible by §6                   |
| drag between two workspace groups | `tabs.onUpdated{groupId:B}`                                  | leaves A, joins B; a running A task can no longer target it |

This is real browser behaviour, detected from real events, and the §17 tests
drive it through `chrome.tabs.group`/`ungroup` against real Chromium rather
than simulating state.

---

## 11. Agent-created tabs

The measured race: `chrome.tabs.create` returns `groupId: -1`, so between
creation and grouping the tab is outside every workspace.

```
1. tabs.create({ active:false })            ← no url: about:blank
2. tabs.group({ tabIds:[id], groupId: W })  ← single call, joins existing group
3. tabs.get(id).groupId === W ?             ← verify, do not assume
4. record the member, authorize the target, navigate
5. on any failure at 2 or 3: tabs.remove(id), fail the tool
```

Navigating **after** grouping is what makes the race harmless: during the
window the tab holds `about:blank`, so there is no page, no content script, no
origin and nothing for another workspace to observe. The existing authorization
path (policy → consent → egress) then runs on the navigation exactly as it does
today.

---

## 12. Navigation

A tab stays a member when it navigates — membership is a property of the tab,
not of the page. Chrome confirms this: `groupId` is unchanged by navigation.

Everything security-relevant is re-evaluated for the new page, unchanged from
today: `assertAutomatable`/`checkNavigable` on the live URL before every
action (the §31 origin-drift check), taint on what is read, consent and the
egress gate on what is sent. **Membership never overrides origin policy** — a
member tab that navigates to a blocked scheme is still refused.

---

## 13. Side-panel behaviour

Today the panel is tab-unaware (§2.10). It gains:

- the active workspace, its title and member count;
- switching between **member** tabs: no change;
- switching to a **non-member** tab: a clear, non-blocking notice — _"This tab
  is not in <workspace>"_ — plus a deliberate **Add current tab to workspace**
  action. The agent context does **not** silently follow;
- a detached workspace shows as detached with a **Re-attach** action.

---

## 14. Security boundary

The guard, run inside `ToolRegistry.dispatch` before any tool that targets a
tab:

```
assertWorkspaceMember(task, tabId):
    task.workspaceId  = undefined  → REFUSE  ("start the task again")
    tabId             = undefined  → resolve from the workspace, never from
                                     the browser's active tab
    isMember(task.workspaceId, tabId) = false → REFUSE
```

**Defined behaviour for every ambiguous case:**

| Case                                    | Behaviour                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task has no workspace                   | **refuse.** Legacy tasks are migrated at upgrade (§19); one that reaches execution without a workspace fails closed with "start the task again" — the same shape as `UNKNOWN` taint |
| tab has no workspace (`groupId === -1`) | **refuse.** Never auto-assigned into the caller's workspace                                                                                                                         |
| tab in another workspace                | **refuse**                                                                                                                                                                          |
| workspace unbound / detached            | **refuse**                                                                                                                                                                          |
| group deleted mid-task                  | **refuse** on the next operation                                                                                                                                                    |
| mirror and Chrome disagree              | **refuse**, and reconcile to Chrome                                                                                                                                                 |

**This filter can only subtract.** It runs _before_ policy, permission, consent,
egress and taint, and never returns "allow" where any of them would return
"deny" — the same relationship route trust has to policy. A member tab gets no
privilege from membership: consent, origin safety, egress checks, taint, route
trust, credential rules and tool permissions all run exactly as they do now.

`listTabs()` is narrowed to the workspace, which also stops the model
_enumerating_ tabs it may not touch — closing an information leak, not only an
action path.

The OAuth tab from `auth-flow-port.ts` is deliberately outside every workspace
and remains so; it is not agent context and no tool may reach it.

---

## 15. Local / Cloud classification

Extends the table in `IDENTITY_AND_SYNC.md`. New `PersistedDataKind` values —
and the total `Record` means they do not compile unclassified:

| Kind                                                                              | Class             | Why                                                                          |
| --------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `workspace-metadata` (`workspaceId`, title, timestamps, task links)               | `USER_SELECTABLE` | portable; no page content                                                    |
| `workspace-membership` (member **origins and titles**)                            | `USER_SELECTABLE` | browsing-adjacent, so it rides the E2EE path when tasks do — never plaintext |
| `workspace-runtime-binding` (`chromeTabId`, `chromeTabGroupId`, `chromeWindowId`) | `LOCAL_ONLY`      | meaningless on another device and dangerous if restored as if valid          |

Member **page content** is not workspace data and is never persisted by this
feature at all.

---

## 16. Reinstall behaviour

`workspaceId`, title and task links return from Cloud Sync. All three Chrome
ids are absent. The workspace restores **detached**, with its history intact
and no live members, and the panel says so:

> _"Customer research was restored. Its tabs are from a previous session —
> open them to continue."_

Old tab ids are never re-used, and a restored member origin is never silently
bound to a tab that happens to be showing that origin now.

---

## 17. Real Chromium test matrix

`TEST-E2E-021`, using the existing `extension` fixture.

| #   | Case                                                         | Automatable               |
| --- | ------------------------------------------------------------ | ------------------------- |
| 1   | active tab becomes the initial member                        | yes                       |
| 2   | agent-created tab joins the workspace                        | yes                       |
| 3   | outside tab is not context; `tabs.list` omits it             | yes                       |
| 4   | drag in (`tabs.group`) → member                              | yes                       |
| 5   | drag out (`tabs.ungroup`) → refused immediately              | yes                       |
| 6   | move between two workspaces → A refused, B allowed           | yes                       |
| 7   | two workspaces isolated                                      | yes                       |
| 8   | navigation preserves membership                              | yes                       |
| 9   | origin policy re-evaluated after navigation                  | yes                       |
| 10  | member tab closed → task survives                            | yes                       |
| 11  | group ungrouped → workspace detached, nothing deleted        | yes                       |
| 12  | **worker restart** → binding re-verified                     | yes (`killServiceWorker`) |
| 13  | **browser restart** → detached, data intact                  | **partial** — see below   |
| 14  | stale tab id refused after close                             | yes                       |
| 15  | cross-workspace targeting refused                            | yes                       |
| 16  | provider switch does not change workspace                    | yes                       |
| 17  | workspace switch does not change provider                    | yes                       |
| 18  | no cross-workspace page content reaches the provider         | yes (`collector`)         |
| 19  | agent-created tab never observable ungrouped **with a page** | yes                       |
| 20  | task/workflow/history intact when a tab disappears           | yes                       |

**Human-only, recorded as `BLOCKED — HUMAN/ENVIRONMENT`, never PASS:**

- **True browser restart with session restore.** Playwright can relaunch a
  persistent context, which proves `storage.session` was cleared and the
  workspace detached — that part is automated as 13a. What it cannot reproduce
  is Chrome's _session restore_ redrawing tab groups with fresh ids, because
  the relaunch does not restore tabs. 13b is manual.
- **Genuine mouse drag** of a tab between groups. The tests drive
  `chrome.tabs.group`/`ungroup`, which produce the identical events (measured
  in §3) — but that is the API, not a human dragging. Recorded as such.

---

## 18. Mutation test matrix

Against production code, per the repository's methodology. Each must be killed.

| #   | Mutation                                                         | Killed by      |
| --- | ---------------------------------------------------------------- | -------------- |
| W1  | remove the `assertWorkspaceMember` call from dispatch            | 3, 15          |
| W2  | remove the `tab.groupId === runtime.chromeTabGroupId` comparison | 6, 15          |
| W3  | accept a cached member without the live `tabs.get`               | 5, 14          |
| W4  | accept a binding without re-verifying `tabGroups.get`            | 11, 12         |
| W5  | treat `groupId === -1` as a member                               | 3, 5           |
| W6  | treat a closed tab's id as still valid                           | 14             |
| W7  | allow a task with no `workspaceId` to proceed                    | dedicated case |
| W8  | derive the active workspace from the active tab                  | 3, 7           |
| W9  | couple workspace switching to provider switching                 | 16, 17         |
| W10 | skip `checkNavigable` for member tabs                            | 9              |
| W11 | ignore `tabs.onUpdated.changeInfo.groupId`                       | 4, 5           |
| W12 | navigate the agent-created tab before grouping it                | 19             |

W12 is the one worth stating: it is the race in §11, and it is only killable
because the test asserts no _page_ is ever observable outside the group.

---

## 19. Migration impact

- `AgentTask` gains `workspaceId?: string`. Optional, because existing records
  do not have it.
- **`AgentTask.tabs` is currently dead (§2.7).** It is either populated for
  real as the workspace mirror or removed. Leaving a declared-but-never-written
  field while adding a second tab model beside it would be the worst of both.
  Recommendation: populate it, since it is the natural home for the mirror.
- Existing **terminal** tasks need nothing — they will not run again.
- Existing **resumable** tasks are refused browser operations until restarted.
  That is a visible behaviour change and belongs in release notes; the
  alternative is leaving the boundary open for in-flight tasks, which defeats
  the feature on precisely the tasks that already touched the browser.
- `AUDIT_EVENT_TYPES` gains `workspace.membership`. The type list is exhaustive
  and adding a member is a compile-time-checked change.

---

## 20. Release impact

New permission required: **none.** `tabs` and `tabGroups` are both already in
`manifest.json`. `tabGroups` is presently used for a single `update()` call, so
its justification in the store listing strengthens rather than changes.

The release artifact and its SHA-256 are superseded by any implementation
commit. Store-listing copy gains a line on workspace scoping, which is a
_narrowing_ of what the extension does and is worth stating.

---

## 21. Known limitations

1. **Tab groups are a desktop Chrome feature.** Where unavailable the
   workspace cannot bind, and the honest behaviour is to refuse browser
   operations rather than silently fall back to unrestricted targeting.
2. **`chrome.tabs.create` cannot create directly into a group** (measured).
   §11 mitigates the race; it does not remove it.
3. **A group dies with its last tab** (measured), so a workspace can become
   detached without the user doing anything they would recognise as closing it.
4. **Session restore ids are not knowable in advance**, so re-attachment after
   a browser restart is a user action, not an inference.
5. **`all_frames: false` is unchanged.** Iframe content remains unreachable;
   workspaces do not alter that and must not be described as if they did.
6. The mirror can briefly lag Chrome between an event and its handler. The
   live-read guard (§6) means this affects display, never authorization.

---

## 22. Implementation plan

Seven steps, each green before the next. No backend, no Cloud Sync, no
authentication — those remain after this.

| Step    | Content                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W-1** | `workspace-model.ts` (`workspaceId`, record, membership predicate as a pure function) + unit tests                                                                                |
| **W-2** | `workspace-store.ts` — persistent record in `local`, runtime binding in `session`; rebinding and detach logic                                                                     |
| **W-3** | Reconciliation: register `tabs.onUpdated/onRemoved/onAttached/onDetached/onReplaced` and `tabGroups.onRemoved/onUpdated`; mirror maintenance; `workspace.membership` audit events |
| **W-4** | **The guard.** `assertWorkspaceMember` in `ToolRegistry.dispatch`; narrow `listTabs`; `AgentTask.workspaceId`; resolve the dead `tabs` field                                      |
| **W-5** | Agent-created tab lifecycle (§11) in `BrowserAdapter.createTab`, with the blank-then-group-then-navigate ordering                                                                 |
| **W-6** | Routes (`workspace.*`), worker wiring, side-panel workspace UI and the _Add current tab_ action                                                                                   |
| **W-7** | Security suite + 12 mutations + `TEST-E2E-021`; full gate; commit; push; CI                                                                                                       |

**Ordering note:** W-4 lands the guard before W-6 exposes any UI, so the
boundary exists before anything invites the user to rely on it.

---

## Account-owner decisions — confirmed

1. **Legacy tasks without a `workspaceId`: REFUSE browser operations.** The
   task, its history, workflows and every other persistent record are kept
   untouched; only live browser targeting is refused. Continuing requires an
   explicit migration or restart into a valid workspace. This closes the
   boundary on exactly the tasks most likely to have used it, which exempting
   them would not.

2. **Tab or group removal DETACHES, it never deletes.** Removing a tab from a
   workspace removes that tab's _live membership_ and nothing else. The
   workspace, its tasks, history, workflows and persistent data all survive.
   A workspace whose group was ungrouped or whose last tab closed is
   `detached` — a normal state with a **Re-attach** action, never an implicit
   close.

3. **Multiple workspaces may share one Chrome window.** Two independent
   workspaces coexisting in one window is supported and not an error.
   `chromeWindowId` is recorded for display and focus only: **window identity
   is never workspace identity**, and no membership decision reads it.

These three confirm §14 (the guard's ambiguous cases), §8 (detach semantics)
and §9 (multiple workspaces). Implementation proceeds per §22.
