# Changelog

## 0.1.0 — unreleased

**Not released.** This version has never been submitted to or published on the
Chrome Web Store. It is the version in `package.json` and in the manifest, and
a production artifact has been built and hashed from it locally — that is all.
See [`docs/release/chrome-web-store-submission-checklist.md`](docs/release/chrome-web-store-submission-checklist.md)
for what publishing would still require.

The version number is deliberately still `0.1.0`. Seven capabilities are
PARTIAL and three are NOT-STARTED (see [`PARITY_MATRIX.md`](PARITY_MATRIX.md)),
and `0.1.0` says so to anyone reading a listing. Bumping it to `1.0.0` would be
a cosmetic change to a number people read as a claim.

### What the extension does

A provider-agnostic browser agent, as a Chrome MV3 side panel. The user
supplies the AI model — OpenAI-compatible, Anthropic or Gemini, with their own
API key — and the extension supplies the browser capabilities and the safety
controls. Changing the model changes how the agent reasons; it cannot change
what the agent is permitted to do.

### Implemented

- **Browser control** — reading a page as a semantic model, typing, clicking,
  selecting, setting structured form controls, multi-select, checkboxes and
  radios, scrolling, waiting, navigation, screenshots as stored evidence.
- **Tabs** — per-task tab ownership, tab groups, and a refusal to act on a tab
  the task does not own.
- **Diagnostics** — console, network and rendered markup through the debugger,
  over a fixed allowlist that holds no evaluator.
- **Files** — upload through the user's own file picker, and download behind an
  optional permission with filename validation.
- **Skills** — bundled, hashed, and run over the one tool registry.
- **Workflows** — recording a real task and replaying it, with page-derived
  element bindings that fail closed when the page has changed.
- **Shortcuts** — a naming layer over skills and workflows, invisible to the
  model.
- **Connectors** — a framework and one connector, GitHub, over OAuth with PKCE
  and a token vault that exposes no bare token.
- **Audit trail** — one record per dispatch, sequence-chained, exportable
  locally, carrying decisions and never page text.
- **Security** — prompt-injection envelope, taint-based egress gate, redaction
  at collection time, origin revalidation, risk model with hard prohibitions,
  route trust over every message, and fail-closed persistence health.

### Not implemented

Tracked in `PARITY_MATRIX.md`: 30 PASS, 7 PARTIAL, 3 NOT-STARTED across the 40
specification capabilities. Notably absent: scheduled tasks (P-020), plugins
(P-025), MCP (P-026), and every connector except GitHub — so the Jira,
Confluence, Figma and Google Sheets flows the specification's acceptance tests
name cannot be run at all.

Web AI inference and provider-specific Web AI enablement are gated by design
and are not implemented.

### Release engineering added in this version

- A deterministic production artifact. Two clean builds produce byte-identical
  archives; the packer pins entry order, timestamps and compression, and adds
  no dependency.
- `web_accessible_resources` is narrowed to https origins in a release build.
  The loopback matches exist so the end-to-end suite's mock authorization
  server can redirect to the OAuth callback, and a shipped build does not need
  them.
- The `alarms` optional permission was removed. It had no code behind it —
  P-020 is NOT-STARTED — and a permission that cannot be justified against
  what the extension does should not be declared.
- `THIRD-PARTY-NOTICES.md`, generated from the installed licences. Four MIT
  packages are bundled into the artifact and MIT requires their notices travel
  with it.
- Acceptance packages for specification §85–§90, with 187 evidence citations
  checked against the repository on every build.

### Verified at this version

|                                       |                        |
| ------------------------------------- | ---------------------- |
| Unit, integration and security        | 2098 tests in 78 files |
| Real Chromium (Playwright)            | 173 tests              |
| Manual acceptance procedures executed | **0 of 15**            |
| Dependency vulnerabilities            | 0                      |

The manual figure is the one worth reading twice. Fifteen procedures are
written; none has been run. See
[`docs/testing/acceptance/RESULTS.md`](docs/testing/acceptance/RESULTS.md).
