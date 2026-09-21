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

**This is the part of the Stage 3 vision that is not yet cleared to build.**
Three findings have to be resolved by the owner before any design work starts.

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

The `debugger` permission is the most likely review obstacle: it is powerful,
it drives `browser.screenshot` and the four inspection tools, and it will need
a specific, honest justification. The alternative — dropping the debugger tools
— is a product decision, not a technical one. Review outcomes cannot be
predicted here and must not be assumed. Current Chrome Web Store program
policies must be read at the time of submission; nothing in this document
should be treated as a summary of them.

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

| Permission                      | Purpose                                    | Narrower alternative | Notes                                      |
| ------------------------------- | ------------------------------------------ | -------------------- | ------------------------------------------ |
| `sidePanel`                     | primary UI                                 | none                 | required                                   |
| `storage`, `unlimitedStorage`   | task/session/evidence persistence          | none                 | evidence exceeds default quota             |
| `tabs`, `tabGroups`             | tab read, grouping                         | drop grouping tools  | `tabGroups` is droppable at a feature cost |
| `scripting`                     | inject into pre-existing tabs              | none                 | required                                   |
| `debugger`                      | inspection tools and screenshot capture    | drop those tools     | **highest review risk**                    |
| `notifications`                 | approval prompts while the panel is closed | none                 | silent stalls otherwise                    |
| `activeTab`                     | act on the current tab                     | none                 |                                            |
| `host_permissions`              | `http://*/*`, `https://*/*`                | —                    | **`<all_urls>` must not return**           |
| optional: `alarms`, `downloads` | unimplemented features                     | —                    | not granted                                |

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

Phases 6–9, all out of Stage 2 and all currently NOT-STARTED or
INTERFACES-ONLY. `src/connectors/core/types.ts` holds interfaces only (§33,
§34, §88); calls raise `NOT_IMPLEMENTED`.

Common prerequisites, which is why they cluster: an OAuth credential store
distinct from provider credentials, per-connector scope and least-privilege
enforcement, write-action consent, connector-specific evidence, cancellation
that is safe mid-write, and §88 acceptance per connector (connect, scope
validation, read, write, auth expiry, revocation, rate limit, permission
denied, least privilege).

Skills (Phase 7) depend on connectors. Workflow, recording, shortcuts and
scheduling (Phase 8) depend on skills and on background execution. MCP and
plugins (Phase 9) depend on a plugin trust model that does not exist and is
the single largest new security surface in the remaining plan.

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

| ID    | Capability                  | Current Status  | Spec Reference                          | Missing Work                                                           | Dependencies           | External Dependency             | Security Impact                 | Test Requirements                     |
| ----- | --------------------------- | --------------- | --------------------------------------- | ---------------------------------------------------------------------- | ---------------------- | ------------------------------- | ------------------------------- | ------------------------------------- |
| P-006 | Forms                       | PARTIAL         | §83                                     | complex control coverage                                               | none                   | none                            | low                             | unit, integration, E2E                |
| P-009 | Image upload                | NOT-STARTED     | §83                                     | implementation                                                         | P-010                  | none                            | file-origin, redaction          | unit, security, E2E                   |
| P-010 | File upload                 | NOT-STARTED     | §83                                     | implementation                                                         | permission review      | none                            | file-origin, redaction, consent | unit, security, E2E                   |
| P-011 | Download                    | NOT-STARTED     | §83                                     | implementation                                                         | `downloads` permission | none                            | side-effect consent             | unit, security, E2E                   |
| P-020 | Scheduled tasks             | NOT-STARTED     | §83, Phase 8                            | implementation                                                         | P-022, background exec | none                            | unattended autonomy             | unit, integration, E2E, manual        |
| P-021 | Shortcuts                   | NOT-STARTED     | §83, Phase 8                            | implementation                                                         | P-022                  | none                            | consent                         | unit, E2E                             |
| P-022 | Workflow recording          | NOT-STARTED     | §83, Phase 8                            | implementation                                                         | P-024                  | none                            | replay safety, evidence         | unit, integration, E2E                |
| P-023 | Connector framework         | INTERFACES-ONLY | §33, §34, §88                           | implementation                                                         | OAuth store, consent   | provider APIs, OAuth apps       | credential isolation, scopes    | unit, integration, security, E2E, §88 |
| P-024 | Skills                      | NOT-STARTED     | §43, Phase 7                            | implementation                                                         | P-023                  | connector access                | inherits connector risk         | unit, integration, E2E                |
| P-025 | Plugins                     | NOT-STARTED     | Phase 9                                 | implementation                                                         | trust model            | none                            | third-party code execution      | unit, security, E2E                   |
| P-026 | MCP                         | NOT-STARTED     | Phase 9                                 | implementation                                                         | P-025 trust model      | MCP servers                     | third-party tool surface        | unit, security, E2E                   |
| P-033 | Provider switching          | PARTIAL         | §85 F, §87                              | ≥2 further adapters + shared suite                                     | Phase 5                | provider API credentials        | credential isolation            | unit, integration, E2E, §87           |
| P-038 | Audit trail                 | PARTIAL         | §83                                     | unified cross-task log, export                                         | none                   | none                            | export data exposure            | unit, integration, security           |
| —     | Authenticated web providers | not in matrix   | no phase; constrained by §3.3, §15, §42 | architecture, trust boundary, per-provider validation                  | Q1, Q2                 | provider terms and UI stability | inverted trust model            | manual acceptance only                |
| —     | End-user distribution       | not in matrix   | no phase                                | store listing, privacy docs, permission justification, release process | packaged build         | Chrome Web Store review         | permission scrutiny             | release verification                  |

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

Classified by dependency, not by preference. Ordering within a wave is not
implied; waves are defined by what must exist first.

| Wave | Classification                              | Contents                                                                                                           | Gate to start                |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| A    | independent, productization                 | Packaged build, release versioning, update path, privacy documentation, permission justification, store submission | none — can start immediately |
| B    | independent, incremental                    | P-006 forms; P-038 unified audit and export                                                                        | none                         |
| C    | foundational, external-dependency           | Phase 5 providers (Anthropic, Gemini, generic compatible); §87 per provider; then P-033                            | provider API credentials     |
| D    | architectural, security-critical, **gated** | Authenticated web provider architecture: registry kind, state model, detection, pause/resume, trust boundary       | **Q1 and Q2 answered**       |
| E    | dependent, security-critical                | P-009/010/011 upload and download                                                                                  | permission review            |
| F    | dependent, external-dependency              | Phase 6 connectors; §88 per connector                                                                              | OAuth apps per connector     |
| G    | dependent                                   | Phase 7 skills                                                                                                     | Wave F                       |
| H    | dependent                                   | Phase 8 workflow, recording, shortcuts, scheduling                                                                 | Wave G                       |
| I    | architectural, security-critical            | Phase 9 MCP and plugins                                                                                            | plugin trust model           |
| J    | certification                               | §85–§89 executed and recorded; §99 claim                                                                           | Waves C, F, G, H, I          |

Waves A, B and C have no dependency on the unresolved web-provider questions
and are the only waves that can begin without an owner decision.

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

## 25. Explicitly Deferred Work

Deferred by this roadmap, with nothing started: connectors, skills, workflow,
recording, shortcuts, scheduling, MCP, plugins, additional provider adapters,
upload and download, unified audit export, advanced forms, authenticated web
providers, and store publication.

---

## 26. Future Stage Handoff

Implementation is not authorised by this document. Three questions need owner
decisions, and two of them gate Wave D entirely.

**Q1 — policy.** Does the owner accept that driving a consumer AI web UI for
model inference is consistent with §3.3's prohibition on bypassing
subscription/API boundaries, and with each provider's terms? A per-provider
answer is required; a general one is not sufficient.

**Q2 — security architecture.** What is the trust boundary for model output
read from a DOM, given that the entire Phase 4 injection defence assumes page
content is untrusted and model output is not?

**Q3 — distribution scope.** Public or unlisted listing first, and is the
`debugger` permission retained through store review, or are the inspection
tools dropped to reduce review risk?

Until Q1 and Q2 are answered, Waves A, B and C are the available work, and
none of them touches the web-provider design.
