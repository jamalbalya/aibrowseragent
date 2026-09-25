# AI Browser Agent

A provider-agnostic browser agent for Chrome.

> **You choose the AI brain. The extension supplies the agent body.**

The AI provider is a replaceable reasoning engine. The browser controls, tool
registry, security policy, permissions, task state and evidence model belong to
the extension. Switching model or provider changes _how the agent reasons_; it
does not change what the agent can do, and it does not weaken any security
control.

## Local-first: nothing to install, nothing to run

```
Install the extension → Connect an AI provider → Use it
```

Everything you make — tasks, workflows, shortcuts, workspaces, settings and
your provider connections — is stored by Chrome, on your computer. There is no
account to create, no server to run and no database of any kind. The extension
uploads nothing.

You never need to install PostgreSQL, run Docker, start a backend, create a
table, execute SQL or run a migration. Neither does anyone developing it:
`npm ci && npm test && npm run build` needs no service running.

There is an optional AI Browser Agent account (Google sign-in), and it is
optional in the strong sense: a build with no backend origin configured has no
sign-in at all, and every feature above works regardless. Signing in identifies
your AI Browser Agent account — it does **not** connect or authorise OpenAI,
Anthropic or Gemini, which stay where they are with their own keys.

Because your data lives in this Chrome profile, deleting the profile deletes
it. Settings → Your data → **Save a copy** writes an export file. It carries
your workflows, shortcuts and settings, and deliberately no API keys.

See [docs/architecture/LOCAL_FIRST_ARCHITECTURE.md](docs/architecture/LOCAL_FIRST_ARCHITECTURE.md).

---

## Status

**Phase 1–2 foundation, implemented and verified in a real browser.** The
extension loads into Chromium, runs agent tasks against live pages, and drives
a full provider exchange over real HTTP — against a local server implementing
the Chat Completions protocol, not a commercial provider. It is not yet at the
full capability
parity described in the specification — see
[PARITY_MATRIX.md](PARITY_MATRIX.md) for the honest per-capability status
(30 of 40 mandatory capabilities PASS), and [docs/testing.md](docs/testing.md)
for what is actually verified and what is not.

What works today:

- Manifest V3 extension: side panel, service worker, content scripts
- Agent runtime: planning loop, tool orchestration, recovery, loop detection,
  resource budgets, cancellation
- Tool registry with schema validation, risk classification and an enforced
  policy/permission gate in front of every call
- 29 canonical tools across browser, tabs, files and DevTools inspection
- Three AI provider adapters — any OpenAI-compatible endpoint, the Anthropic
  Messages API, and the Gemini generateContent API — behind one canonical
  interface, with a capability doctor that verifies rather than assumes
- Security control plane: origin validation, prompt-injection boundary, secret
  redaction, exfiltration policy, hard prohibitions
- File upload and download with no filesystem access: a file arrives only when
  you choose it in a picker, and sending one to a site is a decision separate
  from reading it ([docs/file-handling.md](docs/file-handling.md))
- Task persistence that survives side-panel close and service-worker eviction —
  verified against a real Chrome worker restart, not a simulation

- Connectors: a structured integration with an external service, reached
  through the same egress gate as everything else, with OAuth (authorization
  code + PKCE, no client secret), least-privilege scopes with a stated reason
  for each, and duplicate-write protection that refuses to replay a write
  whose outcome is unknown ([docs/connectors.md](docs/connectors.md)). One
  connector is implemented, for GitHub. **This build registers no OAuth
  application, so nothing can actually be connected** — it says so rather
  than offering a button that cannot work.

- Skills: reusable workflows that run several steps in one go, where every
  step still passes the same gate it would have passed alone — so a workflow
  never turns several approvals into one. A skill is structured data, not code:
  there is no scripting engine, and workflows ship with the extension rather
  than being created at run time ([docs/skills.md](docs/skills.md)).

- Workflow recording: a task you already ran, saved so you can run it again.
  A recording stores intent rather than data — anything credential-shaped or
  page-derived becomes a value you supply at replay — and it is deliberately
  not a skill: it is never registered, never offered to the model, and runs
  only when you press Replay. Replaying re-asks every permission, because
  having recorded a step authorises nothing. A recorded click stores a
  description of the element — a role and an accessible name, tagged with the
  fact that it came from a page — rather than a handle that could never replay,
  and a recording that had to leave a step out cannot be replayed at all
  ([docs/workflows.md](docs/workflows.md)).

- Shortcuts: a name for a workflow you already have, typed as `/qa-regression`.
  A shortcut holds a name and a reference — never steps, arguments or code — so
  it adds no execution path: what it names runs through the same route, with
  the same permission prompts. Names that collide, or merely look alike, are
  refused rather than merged ([docs/shortcuts.md](docs/shortcuts.md)).

- An audit trail: one stream across every task of what was proposed and what
  was decided, holding identifiers and decisions rather than arguments,
  results or page content. Order and corruption are checkable; eviction says
  what it removed; export writes a local file and needs no permission. The
  model cannot read, write or export it ([docs/audit.md](docs/audit.md)).

Not yet implemented: further connectors (Jira, Confluence, Figma, Sheets),
MCP, plugins, scheduling, and OpenAI's Responses API. Their interfaces exist;
their implementations do not, and the code raises `NOT_IMPLEMENTED` rather than
faking a result.

The three adapters have been exercised against local servers implementing each
provider's documented wire format, including over real sockets in real
Chromium. None has been run against a commercial endpoint — no project
credentials are configured — so nothing here should be read as a claim that
one has.

---

## Quick start

Requires Node.js 20.11+ and Chrome 116+.

```bash
git clone https://github.com/jamalbalya/aibrowseragent.git
cd aibrowseragent
npm install
npm run build
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` directory.
4. Click the extension's toolbar icon to open the side panel.

### Connect a provider

1. In the side panel, click **Settings**.
2. Choose a provider.
3. Enter your API key and a model id. The base URL is needed only for the
   OpenAI-compatible adapter, which is the one you point wherever you like;
   the other two default to their own documented endpoint.

   | Provider               | Base URL                    | Example model      |
   | ---------------------- | --------------------------- | ------------------ |
   | Anthropic API          | _(default)_                 | a Claude model id  |
   | Google Gemini API      | _(default)_                 | a Gemini model id  |
   | OpenAI-compatible      | `https://api.openai.com/v1` | `gpt-4o-mini`      |
   | Local (Ollama)         | `http://localhost:11434/v1` | `qwen2.5:14b`      |
   | Local (LM Studio)      | `http://localhost:1234/v1`  | whatever is loaded |
   | Any compatible gateway | its `/v1` base URL          | its model id       |

   A key from one provider is never sent to another, and an API key is not the
   same thing as a subscription to a provider's consumer product.

4. Click **Connect**, then **Run capability check**.

The capability check issues real requests and reports what the endpoint
actually does. The agent is enabled only when **tool calling** passes, because
a model that cannot call tools cannot operate a browser. A model that fails
that check is reported as _Chat only_ rather than being quietly allowed to run
and fail later.

Your API key is stored by the extension and sent only to that provider's
endpoint, as a request header. It never appears in a URL, and it is never
written to logs, evidence, audit records, task records, or model prompts.

### Run a task

Open any ordinary web page, then in the side panel type:

> Read this page and summarise it.

You will see the task status, each tool call as it runs, and the final result
with its evidence references.

---

## How it works

```text
                        SIDE PANEL (presentation only)
                                   │
                          typed message bus
                                   │
                    SERVICE WORKER / AGENT RUNTIME
                                   │
        ┌──────────────┬───────────┼───────────┬──────────────┐
        │              │           │           │              │
   AI PROVIDER    TOOL REGISTRY  POLICY     TASK STATE     EVIDENCE
   (replaceable)       │         ENGINE     (persisted)
                       │           │
                       └─── every call passes through ───┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              CONTENT SCRIPT   chrome.tabs   chrome.debugger
```

The model never touches a Chrome API. It can only request a canonical tool, and
every request passes through the same gate:

```text
schema validation → risk classification → policy → permission
    → execution → sanitisation → evidence
```

Full detail: [docs/architecture.md](docs/architecture.md).

---

## Security posture

The security control plane is independent of the AI provider. Changing model
or provider cannot weaken it.

- **Page content is data, never instructions.** Everything read from a page,
  console, or network response is wrapped in a labelled envelope that it cannot
  escape. The defence is structural, not a heuristic that can be phrased around.
- **Secrets are redacted at collection time**, before anything is logged,
  stored as evidence, or sent to a provider.
- **Origin is re-validated before every action.** A page that redirects between
  planning and execution stops the action rather than acting on the wrong site.
- **Private data does not silently leave its source.** Credentials are blocked
  outright; other cross-site movement requires explicit elevated approval.
- **Some actions are never permitted**, in any permission mode: payments,
  entering payment or identity details, account creation, permanent deletion,
  and defeating bot protection.
- **The DevTools surface is allowlisted.** There is no tool through which the
  model can name a CDP method, and no script-execution method is reachable.

Details and the threat model: [docs/security.md](docs/security.md).

---

## Permission modes

| Mode               | Behaviour                                                      |
| ------------------ | -------------------------------------------------------------- |
| **Manual**         | Confirms every action that changes anything. Reads run freely. |
| **Auto** (default) | Low-risk actions run automatically; changes are confirmed.     |
| **Skip**           | No approval prompts for ordinary actions.                      |

No mode disables the hard safety rules. In every mode, an action with a
sensitive external side effect (R3 and above) still requires explicit
approval, and prohibited actions are refused outright.

---

## Development

```bash
npm run dev            # rebuild on change
npm run typecheck      # strict TypeScript
npm run lint           # ESLint with type-aware rules
npm test               # unit, integration and security (472 tests)
npm run test:security  # security suite only
npm run test:e2e       # end-to-end in a real Chromium (38 tests)
npm run build          # production build into dist/
npm run verify         # everything CI runs except E2E
npm run verify:full    # verify plus the E2E suite
```

The E2E suite loads the built extension into Chromium, drives real pages, and
runs the agent against a local server speaking the Chat Completions protocol.
Run `npm run build` first.

See [docs/development.md](docs/development.md) for the project layout and the
conventions to follow when adding a tool, a provider, or a connector.

## Documentation

| Document                                                                                                       | Contents                                             |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                                                                   | Runtime boundaries, data flow, module map            |
| [docs/security.md](docs/security.md)                                                                           | Threat model, controls, known limitations            |
| [docs/testing.md](docs/testing.md)                                                                             | Test strategy and what each suite proves             |
| [docs/provider-architecture.md](docs/provider-architecture.md)                                                 | Adding a provider adapter                            |
| [docs/tool-architecture.md](docs/tool-architecture.md)                                                         | Adding a tool                                        |
| [docs/architecture/PLUGIN_TRUST_MODEL.md](docs/architecture/PLUGIN_TRUST_MODEL.md)                             | Design gate for P-025/P-026. Nothing implemented     |
| [PARITY_MATRIX.md](PARITY_MATRIX.md)                                                                           | Per-capability implementation status                 |
| [docs/repository-state.md](docs/repository-state.md)                                                           | Repository-level issues that code cannot fix         |
| [CHANGELOG.md](CHANGELOG.md)                                                                                   | What this version is, and what it is not             |
| [docs/release/OWNER-CHECKLIST.md](docs/release/OWNER-CHECKLIST.md)                                             | The twenty-four steps from here to a public listing  |
| [docs/release/README.md](docs/release/README.md)                                                               | How the production artifact is built and hashed      |
| [docs/release/chrome-web-store-submission-checklist.md](docs/release/chrome-web-store-submission-checklist.md) | What publishing needs, and who can do each part      |
| [docs/release/store-listing.md](docs/release/store-listing.md)                                                 | Listing copy, permission justifications, disclosures |
| [docs/release/data-flows.md](docs/release/data-flows.md)                                                       | Every data category: kept where, leaves when         |
| [docs/PRIVACY.md](docs/PRIVACY.md)                                                                             | What the extension does with data                    |

## Chrome permissions

Every permission is requested for a specific reason. See
[docs/security.md](docs/security.md#chrome-permission-justification) for the
per-permission justification, including which are optional and why `debugger`
is requested despite its cost.

## Status

**Not released.** This extension has never been submitted to or published on
the Chrome Web Store. A production artifact is built and hashed locally; see
[docs/release/chrome-web-store-submission-checklist.md](docs/release/chrome-web-store-submission-checklist.md)
for what submission would still require and which parts only an account owner
can do.

## Licence

MIT. See [LICENSE](LICENSE).

Four MIT-licensed packages are bundled into the distributed artifact — React,
React DOM, Scheduler and Zod — and their notices travel with it in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated from the installed
licences and checked on every build.
