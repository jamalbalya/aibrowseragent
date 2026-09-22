# §85 — Mandatory acceptance tests

Six sub-tests, A–F. Read [README.md](README.md) first: the three verdicts, and
why none of them is `PASS`.

Summary of where this package stands:

| Item | Subject       | Verdict                                                                       |
| ---- | ------------- | ----------------------------------------------------------------------------- |
| A    | Basic browser | `AUTOMATED` for every named capability, `MANUAL` for summary quality          |
| B    | Multi-tab     | `AUTOMATED` for discovery and separation, `MANUAL` for a three-tab comparison |
| C    | Debugging     | `AUTOMATED` for DOM, console and network capture, `MANUAL` for the diagnosis  |
| D    | Connector     | `NOT POSSIBLE HERE` — no Jira connector exists                                |
| E    | QA workflow   | `NOT POSSIBLE HERE` — four of its six services do not exist here              |
| F    | Provider swap | `AUTOMATED` against local servers, `MANUAL` against real vendor endpoints     |

---

## A. Basic browser

> Open a test website, search for "QA", open a result, and summarize it.
>
> Must prove: navigation; read; type; click; result extraction.

**Verdict: `AUTOMATED` for all five named capabilities. `MANUAL` for whether
the summary is any good.**

Each capability the item names is established by a test that drives a real
Chromium with the built extension loaded, against a page served over real HTTP:

- EVIDENCE: tests/e2e/agent-task.spec.ts :: navigates to a real page and reads it
- EVIDENCE: tests/e2e/agent-task.spec.ts :: reads a real page and reports a summary with evidence
- EVIDENCE: tests/e2e/agent-task.spec.ts :: types into a real field and clicks a real button
- EVIDENCE: tests/e2e/extension-load.spec.ts :: the agent works across more than one real tab

The prompt differs from the specification's in one respect worth stating: the
local test site sells widgets rather than answering a search for "QA", so the
automated trajectory searches for `small` and opens the widget details page.
The shape is identical — type into a real field, click a real button, follow a
real link, extract from the resulting page — and the substitution is because
the suite must not depend on a third-party site staying up, not because the
"QA" case is harder.

What no automated test settles is whether the summary is _correct and useful_.
An assertion can require that a summary mentions the widget's weight; it
cannot require that a person reading it would be satisfied. That is the manual
part.

### Procedure A-1 — manual (summary quality)

Setup as in the README, with a provider configured.

1. Open a real site you can check the answer against — the project's own
   `README.md` rendered on GitHub works, and so does any documentation page.
2. In the side panel, enter: _Search this site for "QA", open the first
   result, and summarise it._
3. Observe:
   - the agent asks before navigating away from the current page;
   - the trajectory shows a read, a type, a click and a second read;
   - the summary names things that are actually on the result page.
4. Read the result page yourself and compare.

Met when the summary is accurate and the trajectory shows the five
capabilities. Not met if the summary contains anything not on the page, which
is a hallucination and is worth recording verbatim in `RESULTS.md`.

---

## B. Multi-tab

> Compare information from three open tabs.
>
> Must prove: tab discovery; tab switching; context separation.

**Verdict: `AUTOMATED` for discovery, switching and separation. `MANUAL` for
the three-tab comparison itself.**

- EVIDENCE: tests/e2e/extension-load.spec.ts :: the agent works across more than one real tab
- EVIDENCE: tests/e2e/agent-task.spec.ts :: groups real tabs through the Chrome tab-group API
- EVIDENCE: tests/e2e/audit.spec.ts :: two tasks stay apart in the one trail
- EVIDENCE: tests/security/exfiltration.test.ts :: requires confirmation when confidential data crosses to another site

Context separation is the part with a security meaning, and it is the part
best covered: a task's taint is per task, and data read in one tab cannot be
carried into a destination belonging to another site without the egress gate
seeing it. The automated coverage is two tabs rather than three; nothing about
the third tab is different in kind, which is why the gap is a manual item
rather than a defect.

### Procedure B-1 — manual (three tabs)

1. Open three tabs on pages with comparable content — three product pages,
   three documentation pages for different versions.
2. Ask: _Compare these three tabs and tell me how they differ._
3. Observe:
   - the agent lists all three tabs, by title, before acting;
   - it reads each one, and the trajectory shows three separate reads;
   - the comparison mentions something from each of the three.
4. Now close one tab **while the task is running** and observe that the task
   reports the tab is gone rather than acting on a different one.

Met when all three are read and the closed-tab case is reported rather than
silently substituted. Step 4 overlaps §89's `tab closed` item deliberately;
record it under both.

---

## C. Debugging

> Find why the current page's Save action is failing.
>
> Must inspect: DOM; console; network; relevant UI state.

**Verdict: `AUTOMATED` for the capture of all four. `MANUAL` for the
diagnosis.**

- EVIDENCE: tests/e2e/mv3-lifecycle.spec.ts :: the debugger captures real console and network activity
- EVIDENCE: tests/e2e/mv3-lifecycle.spec.ts :: a closed tab does not leave the debugger in a broken state
- EVIDENCE: tests/e2e/security.spec.ts :: the debugger surface never receives a model-named CDP method
- EVIDENCE: tests/e2e/agent-task.spec.ts :: reads a real page and reports a summary with evidence

DOM and UI state come from the page model (the read above); console and
network come from the debugger attaching to a real tab and receiving real
events. The allowlist test is cited because the debugger's value here is
inseparable from its limit: the agent can read console and network, and cannot
be talked into executing anything through the same surface.

Whether the agent correctly _diagnoses_ a failure is a model-quality question.
It is not assertable and is not claimed.

### Procedure C-1 — manual (a real diagnosis)

You need a page with a genuinely broken action. Any of these works:

- a form posting to a URL that 500s;
- a page whose Save button calls a function that throws;
- a page whose request is blocked by CORS.

1. Open the broken page and attempt the Save yourself, so you know what
   actually happens.
2. Ask: _Find why this page's Save action is failing._
3. Approve the debugger attachment when asked. Chrome shows its own "started
   debugging this browser" banner — confirm it appears, because that banner is
   the user-facing part of this capability.
4. Observe that the agent reports the console error **and** the network status,
   not one or the other.
5. Confirm the reported cause matches what you saw in step 1.

Met when console and network are both inspected and the reported cause is the
real one. Record the actual failure you staged, so the result can be read
later by someone who was not there.

---

## D. Connector

> Get PROJ-123 and summarize its requirements. Must prefer Jira connector if
> configured.

**Verdict: `NOT POSSIBLE HERE`.**

- REASON: This repository implements one connector, GitHub
  (`src/connectors/adapters/github.ts`). There is no Jira connector, so there
  is nothing to prefer and nothing to configure. `PROJ-123` cannot be fetched.

This is a capability gap, not an external blocker. Nothing outside the
repository prevents a Jira connector being written; it has not been written.
`PARITY_MATRIX.md` is where that gap is tracked, and it is not softened here.

The _shape_ the item is really testing — that a configured connector is
preferred over scraping the same information out of a web page — is covered
for the connector that does exist:

- EVIDENCE: tests/e2e/connector.spec.ts :: connector tools are in the registry the model is offered
- EVIDENCE: tests/e2e/connector.spec.ts :: a model-driven connector call is refused while the connector is not connected
- EVIDENCE: tests/e2e/connector.spec.ts :: reading needs no scope and writing does

That is evidence about connector _mechanism_, and it is not evidence for item
D. Item D stays `NOT POSSIBLE HERE` until a Jira connector exists.

---

## E. QA workflow

> Analyze PROJ-123, check Confluence and Figma, create test cases in Google
> Sheets, execute them on staging, and create Jira bugs for confirmed defects.
>
> Must exercise: Jira; Confluence; Figma; skill; Sheets; browser; debugger;
> evidence; Jira write; permission system.

**Verdict: `NOT POSSIBLE HERE`.**

- REASON: Four of the services this item names — Jira, Confluence, Figma and
  Google Sheets — have no connector in this repository. The item cannot be
  executed end to end, and no part of it can be reported as met.

Six of the ten things it must exercise do exist and are covered:

| Must exercise     | Status here                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| Jira              | No connector                                                                      |
| Confluence        | No connector                                                                      |
| Figma             | No connector                                                                      |
| Sheets            | No connector                                                                      |
| Jira write        | No connector                                                                      |
| skill             | Implemented; `tests/e2e/skills.spec.ts`, 18 tests                                 |
| browser           | Implemented; `tests/e2e/agent-task.spec.ts`, 10 tests                             |
| debugger          | Implemented; `tests/e2e/mv3-lifecycle.spec.ts`                                    |
| evidence          | Implemented; `tests/unit/evidence-store.test.ts`                                  |
| permission system | Implemented; `tests/e2e/security.spec.ts`, `tests/unit/permission-engine.test.ts` |

- EVIDENCE: tests/e2e/skills.spec.ts :: a skill drives the real browser through several steps
- EVIDENCE: tests/e2e/skills.spec.ts :: approving the run does not approve a step inside it
- EVIDENCE: tests/e2e/agent-task.spec.ts :: a screenshot is captured, stored and never inlined into model context

The multi-service orchestration this item is really about — a skill spanning
several systems, each step re-entering the permission system — is exercised
with the services that exist. That is a weaker claim than the item makes, and
it is recorded as the weaker claim.

---

## F. Provider swap

> Run the same workflow with OpenAI, Anthropic and Gemini. Expected: same
> tools, same browser layer, same connectors, same policy, same task state;
> different provider adapter only.

**Verdict: `AUTOMATED` against local servers implementing each provider's
documented wire format. `MANUAL` against the real vendor endpoints, which
this repository holds no credentials for.**

- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the registry offers all three API providers and no web provider
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the Anthropic adapter completes a real round trip over sockets
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the Gemini adapter completes a real round trip and sends no key in a URL
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: a tool call from each provider drives the same browser action
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: switching provider mid-session does not carry the previous authorization
- EVIDENCE: tests/e2e/provider-switching.spec.ts :: switching model re-runs the capability check rather than inheriting one
- EVIDENCE: tests/e2e/provider-integration.spec.ts :: the canonical tool schemas reach the provider in its native format

"A tool call from each provider drives the same browser action" is the item's
central claim, and it is asserted directly rather than inferred from the
adapters looking similar.

What a local server cannot establish is a specific vendor's quirks: it answers
exactly what it was told to. So the wire format is proved and the vendor's
conformance to its own documentation is not.

### Procedure F-1 — manual (real endpoints)

Requires an API key for each of the three vendors. **Account owner action** —
this repository has none and invents none.

For each of OpenAI, Anthropic and Gemini:

1. In settings, select the provider, enter the key, connect.
2. Confirm the capability doctor reports `AGENT_READY` rather than
   `CHAT_ONLY`. If it reports `CHAT_ONLY`, the selected model cannot call
   tools; pick one that can, and record which.
3. Run the identical prompt on the local test site: _Search for "small", open
   the widget details, and tell me what the medium widget weighs._
4. Record: the tools offered, the steps taken, the permission prompts raised,
   and the answer.

Met when all three produce the same tool set, the same permission prompts and
the same answer, differing only in wording. Any difference in _which tools
exist_ or _which prompts appear_ is a defect in the adapter layer and is
recorded as not met.

A fourth run is worth doing and is not required by the specification: switch
provider **mid-task** and confirm the task's own state — its taint, its
approvals, its steps — is unchanged, matching what
`switching provider mid-session does not carry the previous authorization`
asserts against a local server.
