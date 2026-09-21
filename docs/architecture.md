# Architecture

## The invariant

> Changing the AI brain must not remove the agent body's capabilities.

Everything below follows from that. The AI provider is a reasoning engine
behind a narrow interface. The browser controls, tool registry, policy engine,
permission model, task state and evidence model belong to the extension and
know nothing about any particular provider.

Concretely: `src/agent/`, `src/tools/`, `src/policy/`, `src/security/`,
`src/tasks/` and `src/evidence/` contain no provider-specific code. The only
place a provider's wire format exists is `src/providers/adapters/`.

## Runtime boundaries

```text
                              USER
                                │
                    ┌───────────▼───────────┐
                    │      SIDE PANEL       │   presentation only
                    │   src/sidepanel/      │   holds no authoritative state
                    └───────────┬───────────┘
                                │  typed message bus
                                │  src/messaging/
                    ┌───────────▼───────────┐
                    │    SERVICE WORKER     │   authoritative orchestration
                    │    src/background/    │   ephemeral, so state is persisted
                    └───────────┬───────────┘
                                │
        ┌───────────┬───────────┼───────────┬────────────┐
        │           │           │           │            │
   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌────▼────┐ ┌─────▼─────┐
   │ AGENT   │ │  TOOL   │ │ POLICY  │ │  TASK   │ │ EVIDENCE  │
   │ RUNTIME │ │REGISTRY │ │ ENGINE  │ │  STORE  │ │   STORE   │
   └────┬────┘ └────┬────┘ └─────────┘ └─────────┘ └───────────┘
        │           │
   ┌────▼────┐      │
   │ PROVIDER│      │
   │ ADAPTER │      └──────────┬──────────┬─────────────┐
   └─────────┘                 │          │             │
                        ┌──────▼───┐ ┌────▼─────┐ ┌─────▼──────┐
                        │ CONTENT  │ │chrome.tabs│ │  chrome.   │
                        │  SCRIPT  │ │           │ │  debugger  │
                        └──────────┘ └───────────┘ └────────────┘
```

### Side panel — `src/sidepanel/`

Renders state; owns none of it. Every task, permission decision and provider
setting lives in the service worker. Closing the panel does not stop a task,
and reopening it re-reads current state rather than replaying a local copy.

This is what makes background execution work: if the panel owned task state,
closing it would kill the task.

### Service worker — `src/background/`

The authoritative layer. Owns task lifecycle, tool routing, permission
brokering, provider connection and Chrome event handling.

MV3 evicts service workers without warning, so nothing important lives only in
this module's closure. `LifecycleManager` reconciles persisted state on every
startup: a task that was mid-flight is moved to `PAUSED` rather than silently
resumed, because the page it was working on may have moved.

`service-worker.ts` is composition only. It wires the dependency graph once,
top-down; every collaborator receives its dependencies explicitly.

### Content scripts — `src/content/`

Deliberately thin. Extracts a semantic page model and performs DOM
interactions. No planning, no provider calls, no policy decisions.

Content scripts run in an isolated world, so page JavaScript cannot call into
them — but the page fully controls the DOM they read. Everything produced here
is untrusted data and is labelled as such before it reaches the model.

## The execution gate

This is the core of the design. Model output reaches a real effect through
exactly one path, in `src/tools/registry/tool-registry.ts`:

```text
  model proposes a tool call
            │
            ▼
  1. lookup            unknown tool → refused
            ▼
  2. schema validation Zod parse; the implementation never sees raw model output
            ▼
  3. classification    argument-aware risk; may raise, never lowers the floor
            ▼
  4. policy            hard prohibitions → site rules → origin → exfiltration
            ▼                             → risk → permission mode
  5. permission        ALLOW / ALLOW_WITH_CONFIRMATION / DENY
            ▼
  6. execution         bounded by the tool's timeout and the task's abort signal
            ▼
  7. sanitisation      secrets redacted before the result enters model context
            ▼
  8. evidence          payload redacted, hashed and persisted; the reference
                       returned carries provenance back to this tool call
```

The runtime holds no direct reference to any tool implementation, so there is
no second path. A model that is confused, or being driven by an injected page,
is bounded by the same rules in every case.

Each policy stage can only make the outcome stricter. This is enforced by
tests, not just convention — see `tests/unit/policy-engine.test.ts`.

## Data flow for one turn

```text
  buildRequest()                  src/agent/context/context-builder.ts
    ├─ system instruction         trust hierarchy, tool list, permission mode
    ├─ trimmed history            oldest tool results replaced first
    └─ canonical tool schemas     derived from Zod via z.toJSONSchema
            │
            ▼
  provider.generate()             src/providers/adapters/
            │                     the only place a wire format exists
            ▼
  CanonicalResponse               text + toolCalls, provider-neutral
            │
            ├── no tool calls ──► task completes with the model's summary
            │
            └── tool calls ─────► registry.dispatch() per call
                                       │
                                       ▼
                                  ToolResultEnvelope
                                       │
                                       ▼
                                  appended as role:"tool"
                                       │
                                       ▼
                                  loop detection, budget check, next turn
```

## Module map

| Path                               | Responsibility                                                 |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/agent/runtime/`               | The agent loop: plan, call, dispatch, recover, terminate       |
| `src/agent/context/`               | System instruction, history trimming, request assembly         |
| `src/agent/loop-detection/`        | Identical repetition, repeated failure, cycles                 |
| `src/agent/budget/`                | Duration, tool call, token and write budgets                   |
| `src/agent/recovery/`              | Retry classification and backoff                               |
| `src/providers/core/`              | Canonical message format, adapter interface, errors            |
| `src/providers/registry/`          | Which adapters exist, which is active                          |
| `src/providers/capability-doctor/` | Verifies capabilities by exercising them                       |
| `src/providers/adapters/`          | Wire-format translation. The only provider-aware code          |
| `src/tools/core/`                  | Tool contract, execution context, result envelope              |
| `src/tools/registry/`              | The execution gate                                             |
| `src/tools/browser/`               | Canonical browser tools + the Chrome adapter seam              |
| `src/tools/tabs/`                  | Tab tools and per-task tab ownership                           |
| `src/tools/debugger/`              | CDP manager with a method allowlist, and its tools             |
| `src/policy/`                      | Risk, policy engine, permission engine, site rules             |
| `src/security/`                    | Redaction, origin validation, injection boundary, exfiltration |
| `src/tasks/`                       | Task model, state machine, persistence                         |
| `src/evidence/`                    | Evidence model, store, provenance                              |
| `src/connectors/core/`             | Connector interfaces. Foundation only; no adapters yet         |
| `src/messaging/`                   | Typed protocol and bus                                         |
| `src/storage/`                     | Storage abstraction with atomic read-modify-write              |
| `src/logging/`                     | Structured, categorised, redacting logger                      |
| `src/config/`                      | Settings and the isolated credential store                     |

## Chrome-specific vs portable

The specification requires the agent core to survive a future desktop or cloud
runtime. The boundary is drawn at `BrowserAdapter`
(`src/tools/browser/chrome-adapter.ts`) and `DebuggerPort`
(`src/tools/debugger/debugger-manager.ts`).

Chrome-specific: those two interfaces' implementations, plus `chrome.sidePanel`
and `chrome.notifications` use in the service worker.

Portable: everything else — agent state, tool registry, policy, permissions,
evidence, task state, provider adapters.

A different browser runtime supplies its own `BrowserAdapter` and
`DebuggerPort`. Nothing else changes. The same seam is what makes the tools
unit-testable without a browser.

## State persistence

MV3 eviction means anything not written down is lost. The storage layer
(`src/storage/storage-area.ts`) provides atomic read-modify-write through a
per-key mutex, because two tool executions completing simultaneously would
otherwise read-modify-write the same task record and lose one update.

Composition in the service worker:

```text
chrome.storage.local
  └─ SerializedStorageArea      per-key mutex; transactions
       └─ NamespacedStorageArea  "tasks:", "evidence:", "policy:", "credentials:"
            └─ TaskStore / EvidenceStore / SettingsStore / CredentialStore
```

Credentials live in their own namespace behind their own type, so code holding
a `SettingsStore` cannot read them. Nothing in `CredentialStore` is ever passed
to the logger.

## Deliberate non-goals for this phase

- **No backend.** The extension is Chrome-local. It cannot continue work while
  Chrome is closed, and the UI does not claim otherwise.
- **No provider fallback.** If the configured provider fails, the failure is
  surfaced. Silent substitution would change the security characteristics of a
  running task without the user knowing.
- **No `browser.execute_script`.** The specification lists it as a high-risk,
  policy-controlled capability. It is not implemented, because arbitrary script
  execution from model output would make the entire tool gate bypassable. If it
  is added later it needs its own threat model, not just a policy flag.
