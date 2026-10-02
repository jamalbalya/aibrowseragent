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

**Verdict: `MANUAL`.**

**This item used to be impossible here,** on the grounds that _"this repository
implements one connector, GitHub"_ and that item D would stay that way _"until
a Jira connector exists"_. It exists
(`src/connectors/adapters/jira.ts`), so the verdict changes on the condition
this document itself set. What is left is a credential, which is an owner
action rather than a capability gap.

- PROCEDURE:
  1. Create an Atlassian API token at
     <https://id.atlassian.com/manage-profile/security/api-tokens>.
  2. Connect Jira in Settings → Connectors with your email address and your own
     site address.
  3. Open a web page showing one of your issues, and ask the agent to get that
     issue and summarise its requirements.
  4. Watch which tool it uses.
- CRITERION: the agent reads the issue through `jira.search_issues` or
  `jira.read_issue` rather than scraping the page it has open.
- FAILS IF: it scrapes the page while a configured connector could have
  answered, or it reaches any origin other than the site you entered.
- HUMAN_EXECUTION_REQUIRED: an API token from a real Atlassian account, which
  this repository holds none of.
- WHY AUTOMATION IS INSUFFICIENT: the preference is between two routes to the
  same fact, and only one of them exists without a credential. Everything
  underneath is automated — the connector's registration, its binding, its
  tools in the model's registry, and the refusal when it is not connected.

`PROJ-123` itself is a placeholder for whichever issue key the executor has.
The specification's literal key is not fetchable by anybody.

The _shape_ the item is really testing — that a configured connector is
preferred over scraping the same information out of a web page — is covered by
mechanism, and that is still not the same as executing item D:

- EVIDENCE: tests/e2e/connector.spec.ts :: connector tools are in the registry the model is offered
- EVIDENCE: tests/e2e/connector.spec.ts :: a model-driven connector call is refused while the connector is not connected
- EVIDENCE: tests/e2e/connector.spec.ts :: reading needs no scope and writing does

---

## E. QA workflow

> Analyze PROJ-123, check Confluence and Figma, create test cases in Google
> Sheets, execute them on staging, and create Jira bugs for confirmed defects.
>
> Must exercise: Jira; Confluence; Figma; skill; Sheets; browser; debugger;
> evidence; Jira write; permission system.

**Verdict: `NOT POSSIBLE HERE`.**

- REASON: Google Sheets, one of the four services this item names, has no
  connector in this repository, and the item needs all four at once. It cannot
  be executed end to end. The other three now exist, which is a correction to
  the previous wording here — it said all four were missing, and that stopped
  being true when Jira, Figma and Confluence were written.

A second reason survives the connectors: the item requires a **Jira write**,
and the Jira connector is read-only because Basic authentication reports no
scopes, so a declared write could never be established. That is not waiting on
a credential.

Nine of the ten things it must exercise now exist; one of them cannot be
executed and one is read-only by design:

| Must exercise     | Status here                                                                       |
| ----------------- | --------------------------------------------------------------------------------- |
| Jira              | Implemented (`src/connectors/adapters/jira.ts`); needs an owner token             |
| Confluence        | Implemented (`src/connectors/adapters/confluence.ts`); needs an owner token       |
| Figma             | Implemented (`src/connectors/adapters/figma.ts`); needs an owner token            |
| Sheets            | No connector                                                                      |
| Jira write        | Not offered: Basic auth reports no scopes, so a write could never be established  |
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

- EVIDENCE: tests/e2e/provider-switching.spec.ts :: the registry offers every API provider and no web provider
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
