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
Anthropic or Gemini, which stay where they are with their own keys. They are two
separate acts, in that order of independence: you can use the agent with no
account at all, and signing in grants access to no AI provider.

**What the shipped build can and cannot do here, stated plainly.** The sign-in
is implemented end to end — the flow, session persistence, token refresh,
concurrent refresh, worker restart, logout and server-side revocation are
covered by 34 cases in real Chromium against a controlled backend over real
HTTPS with genuinely signed tokens, and one of those runs the whole journey:
signed in, an AI account connected, verified, selected, and a task actually
run on it. What has **not** happened is a sign-in
against Google's own endpoints: that needs a deployed backend and a Google
OAuth client registered to it, neither of which exists, so the shipped build
compiles in no backend origin and the panel offers no sign-in rather than
offering a button that cannot work. Choosing and using an AI account does not
depend on any of it.

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
(36 of 40 mandatory capabilities PASS), and [docs/testing.md](docs/testing.md)
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
plugins, and OpenAI's Responses API. Their interfaces exist; their
implementations do not, and the code raises `NOT_IMPLEMENTED` rather than faking
a result.

MCP is partly implemented. You can add a remote MCP server in Settings and the
agent can use its tools, each confirmed on every call — including a read, because
the arguments leave your browser either way. Its resources are not implemented,
and no third-party server has been used: the whole path is exercised against a
local one.

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

**There is nothing to sign up for.** The extension opens and works on this
device with no account of its own; what it needs is an AI account _you_ hold.
There is an optional product sign-in, it is absent from every shipped build,
and it grants no access to any AI service.

For **Google Gemini** you can authorize your Google account instead of pasting
a key — see [Connect with Google](#connect-with-google) below. Every other
provider takes a key you create, and the reasons are per-vendor rather than
arbitrary: [docs/account-integration.md](docs/account-integration.md) has the
table with each vendor's own source.

1. In the side panel, click **Settings**.
2. Choose a provider. The panel states what that provider actually accepts
   before the form that asks for a key.
3. Enter your API key and a model id. The base URL is needed only for the
   OpenAI-compatible adapter, which is the one you point wherever you like;
   the other two default to their own documented endpoint.

   For the OpenAI-compatible adapter there is a **Known endpoint** list that
   fills the base URL for you — Kimi (Moonshot, both regions), DeepSeek,
   OpenRouter, Groq, Mistral, xAI, Together, and Ollama or LM Studio on this
   computer. It is a convenience and nothing more: it prefills one editable
   field, and you can type any other base URL instead.

   | Provider               | Base URL                     | Example model      |
   | ---------------------- | ---------------------------- | ------------------ |
   | Anthropic API          | _(default)_                  | a Claude model id  |
   | Google Gemini API      | _(default)_                  | a Gemini model id  |
   | OpenAI-compatible      | `https://api.openai.com/v1`  | `gpt-4o-mini`      |
   | Kimi (Moonshot)        | `https://api.moonshot.ai/v1` | a Kimi model id    |
   | Local (Ollama)         | `http://localhost:11434/v1`  | `qwen2.5:14b`      |
   | Local (LM Studio)      | `http://localhost:1234/v1`   | whatever is loaded |
   | Any compatible gateway | its `/v1` base URL           | its model id       |

   A key from one provider is never sent to another, and an API key is not the
   same thing as a subscription to a provider's consumer product. API keys go
   over https only; plain `http` is accepted for `localhost` alone, so a local
   model runner works and a plain-http remote endpoint is refused with a reason.

4. Click **Connect**, then **Run capability check**.

The capability check issues real requests and reports what the endpoint
actually does. The agent is enabled only when **tool calling** passes, because
a model that cannot call tools cannot operate a browser. A model that fails
that check is reported as _Chat only_ rather than being quietly allowed to run
and fail later.

Your API key is stored by the extension and sent only to that provider's
endpoint, as a request header. It never appears in a URL, and it is never
written to logs, evidence, audit records, task records, or model prompts.

### Connect with Google

For **Google's Gemini API only**, you can authorize your Google account rather
than paste a key. Press **Connect with Google** under that provider in
Settings. Chrome asks for one optional permission — you can decline it, and
withdraw it later — and Google's own consent screen opens. What comes back is
an access token stored as that one account's credential, renewed before it
expires.

Three things it is not:

- **not a sign-in.** No account here is created, no session starts, and
  nothing about it is required to use the extension.
- **not a way to find your other AI accounts.** No provider offers an API that
  lists the accounts a Google identity holds elsewhere, and this extension does
  not imply one. Models _are_ discovered — from the endpoint, once the account
  has a credential.
- **not a way to use a consumer subscription.** Gemini API usage is billed to a
  Google Cloud project whether you authorize or paste a key. A Google One AI
  Premium plan is not an API entitlement.

Only Google works this way, and the reasons are specific: OpenAI's
plan-sharing flow needs a loopback redirect an extension cannot serve,
Anthropic's terms prohibit a third party routing a Claude subscription, and the
rest issue keys only. The panel shows each reason with a link to the vendor's
page.

**In the published build this option reports itself unavailable**, because the
artifact carries no Google OAuth client id. It says so and points at the key
path instead of offering a button that cannot work. Registering a client is
owner step G-6 in
[docs/release/OWNER-CHECKLIST.md](docs/release/OWNER-CHECKLIST.md).

### Choose which account the agent uses

Connect as many accounts as you like, including two on the same provider — a
personal key and a work key are two accounts, not one setting. Each gets its
own credential, its own model selection and its own capability measurement.

One of them is the **AI brain**: the account every task runs on until you
change it. Pick it under **Connected accounts**, where you can also see which
one is active, switch, disconnect one, or re-run its capability check.

What that selection guarantees:

- every request goes to the selected account's endpoint with the selected
  account's key, and switching changes every subsequent request;
- a follow-up turn or a tool-use cycle stays on the same account;
- the selection survives closing the browser;
- if the selected account cannot be used — no model chosen, a model the
  provider no longer offers, a key missing on this device, a key the provider
  refused — the task is **refused and says why**. It is never quietly run on
  another account you happen to have connected.

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

Details: [docs/security.md](docs/security.md). The threat model itself —
§82's eighteen mandatory threats, one item each, with cited evidence and stated
gaps — is [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

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

Specification §81 names twelve mandatory documents. Eight of them live here
under a different filename, and the mapping below is checked on every CI run by
`scripts/check-acceptance.mjs` — including a minimum length, so a file that
exists and says nothing does not satisfy the requirement by filename alone.
Renaming them to match §81 would break every inbound link in a heavily
cross-referenced tree in order to satisfy a filename; a reviewer who needs to
find the twelve needs a map, which a rename does not give them.

| §81 requires         | This project keeps it at                                                           |
| -------------------- | ---------------------------------------------------------------------------------- |
| `README.md`          | [README.md](README.md)                                                             |
| `ARCHITECTURE.md`    | [docs/architecture.md](docs/architecture.md)                                       |
| `SECURITY.md`        | [docs/security.md](docs/security.md)                                               |
| `THREAT_MODEL.md`    | [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                                       |
| `PROVIDER_GUIDE.md`  | [docs/provider-architecture.md](docs/provider-architecture.md)                     |
| `CONNECTOR_GUIDE.md` | [docs/connectors.md](docs/connectors.md)                                           |
| `SKILL_GUIDE.md`     | [docs/skills.md](docs/skills.md)                                                   |
| `PLUGIN_GUIDE.md`    | [docs/architecture/PLUGIN_TRUST_MODEL.md](docs/architecture/PLUGIN_TRUST_MODEL.md) |
| `MCP_GUIDE.md`       | [docs/MCP_GUIDE.md](docs/MCP_GUIDE.md)                                             |
| `WORKFLOW_GUIDE.md`  | [docs/workflows.md](docs/workflows.md)                                             |
| `PARITY_MATRIX.md`   | [PARITY_MATRIX.md](PARITY_MATRIX.md)                                               |
| `TESTING.md`         | [docs/testing.md](docs/testing.md)                                                 |

Two of those did not exist at all until this wave — `MCP_GUIDE.md` and
`THREAT_MODEL.md` — and nothing noticed, because no parity clause covers §81:
the clause inventory runs over P-001…P-040, and §81 is a project-structure
requirement. That is the argument for the check rather than the table.

| Document                                                                                                       | Contents                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)                                                                   | Runtime boundaries, data flow, module map              |
| [docs/security.md](docs/security.md)                                                                           | Threat model, controls, known limitations              |
| [docs/testing.md](docs/testing.md)                                                                             | Test strategy and what each suite proves               |
| [docs/provider-architecture.md](docs/provider-architecture.md)                                                 | Adding a provider adapter                              |
| [docs/account-integration.md](docs/account-integration.md)                                                     | How an AI account is connected, and what Google does   |
| [docs/tool-architecture.md](docs/tool-architecture.md)                                                         | Adding a tool                                          |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)                                                                   | §82's eighteen threats, one item each, with evidence   |
| [docs/MCP_GUIDE.md](docs/MCP_GUIDE.md)                                                                         | What P-026 is, and where an MCP tool's risk comes from |
| [docs/architecture/PLUGIN_TRUST_MODEL.md](docs/architecture/PLUGIN_TRUST_MODEL.md)                             | Design gate for P-025. Nothing implemented             |
| [PARITY_MATRIX.md](PARITY_MATRIX.md)                                                                           | Per-capability implementation status                   |
| [docs/repository-state.md](docs/repository-state.md)                                                           | Repository-level issues that code cannot fix           |
| [CHANGELOG.md](CHANGELOG.md)                                                                                   | What this version is, and what it is not               |
| [docs/release/OWNER-CHECKLIST.md](docs/release/OWNER-CHECKLIST.md)                                             | The twenty-four steps from here to a public listing    |
| [docs/release/README.md](docs/release/README.md)                                                               | How the production artifact is built and hashed        |
| [docs/release/chrome-web-store-submission-checklist.md](docs/release/chrome-web-store-submission-checklist.md) | What publishing needs, and who can do each part        |
| [docs/release/store-listing.md](docs/release/store-listing.md)                                                 | Listing copy, permission justifications, disclosures   |
| [docs/release/data-flows.md](docs/release/data-flows.md)                                                       | Every data category: kept where, leaves when           |
| [docs/PRIVACY.md](docs/PRIVACY.md)                                                                             | What the extension does with data                      |

## Chrome permissions

Every permission is requested for a specific reason. See
[docs/security.md](docs/security.md#chrome-permission-justification) for the
per-permission justification, including which are optional and why `debugger`
is requested despite its cost.

## Status

**`0.1.0` is published. `0.2.0` is prepared and has not been uploaded.** The
listing is live at
<https://chromewebstore.google.com/detail/hlhcfmlgoojeoapmijopmicdmmhealhl>,
showing `0.1.0`, last updated 3 October 2026, and declaring _"Website content"_
as the data it handles. The item id came from the account owner and the listing
was then read, so this is verified rather than reported.

**The published build cannot complete a tool call on Gemini.** The package was
downloaded from the store and unpacked: it carries none of the 3 October 2026
provider fixes. That is the reason `0.2.0` exists. The API-key path for
OpenAI-compatible providers is unaffected.

The published artifact is therefore **not** the artifact a fresh build produces
now. See
[docs/release/README.md](docs/release/README.md#two-artifacts-and-which-one-is-which)
for the distinction and
[docs/release/chrome-web-store-submission-checklist.md](docs/release/chrome-web-store-submission-checklist.md)
for the pre-submission checklist and which parts only an account owner can
do.

## Licence

MIT. See [LICENSE](LICENSE).

Four MIT-licensed packages are bundled into the distributed artifact — React,
React DOM, Scheduler and Zod — and their notices travel with it in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated from the installed
licences and checked on every build.
