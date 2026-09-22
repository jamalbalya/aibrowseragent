# AI Browser Agent

A provider-agnostic browser agent for Chrome.

> **You choose the AI brain. The extension supplies the agent body.**

The AI provider is a replaceable reasoning engine. The browser controls, tool
registry, security policy, permissions, task state and evidence model belong to
the extension. Switching model or provider changes _how the agent reasons_; it
does not change what the agent can do, and it does not weaken any security
control.

---

## Status

**Phase 1–2 foundation, implemented and verified in a real browser.** The
extension loads into Chromium, runs agent tasks against live pages, and drives
a full provider exchange over real HTTP — against a local server implementing
the Chat Completions protocol, not a commercial provider. It is not yet at the
full capability
parity described in the specification — see
[PARITY_MATRIX.md](PARITY_MATRIX.md) for the honest per-capability status
(25 of 40 mandatory capabilities PASS), and [docs/testing.md](docs/testing.md)
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

Not yet implemented: connectors (Jira, Confluence, Figma, Sheets), MCP, skills,
workflows, scheduling, and OpenAI's Responses API. Their
interfaces exist; their implementations do not, and the code raises
`NOT_IMPLEMENTED` rather than faking a result.

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

| Document                                                       | Contents                                     |
| -------------------------------------------------------------- | -------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                   | Runtime boundaries, data flow, module map    |
| [docs/security.md](docs/security.md)                           | Threat model, controls, known limitations    |
| [docs/testing.md](docs/testing.md)                             | Test strategy and what each suite proves     |
| [docs/provider-architecture.md](docs/provider-architecture.md) | Adding a provider adapter                    |
| [docs/tool-architecture.md](docs/tool-architecture.md)         | Adding a tool                                |
| [PARITY_MATRIX.md](PARITY_MATRIX.md)                           | Per-capability implementation status         |
| [docs/repository-state.md](docs/repository-state.md)           | Repository-level issues that code cannot fix |

## Chrome permissions

Every permission is requested for a specific reason. See
[docs/security.md](docs/security.md#chrome-permission-justification) for the
per-permission justification, including which are optional and why `debugger`
is requested despite its cost.

## Licence

MIT. See [LICENSE](LICENSE).
