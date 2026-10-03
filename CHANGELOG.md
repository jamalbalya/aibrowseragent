# Changelog

## 0.2.0 — prepared, not submitted

**This version has not been uploaded, submitted or published.** It is built,
validated and waiting on the account owner's decision. `0.1.0` remains the
published version until that happens.

### Why this update exists

**The published build cannot run a tool call on Gemini.** That is not inferred
from the commit history — the published package was downloaded from the Chrome
Web Store and read. Its `service-worker.js` contains none of the fixes made on
3 October 2026: no `thoughtSignature`, no `retryDelay`, no
`insufficient_quota`, no `x-goog-user-project`, and none of the retired-model
message. Two of those absences are the blocking pair. Canonical tool schemas
carry a field Google's schema type rejects by name, so every tool request was
refused; and a conversation that got past that could make exactly one tool call
before Google refused the turn carrying the tool's result.

So a user who installs `0.1.0` today and connects Gemini gets an agent that
cannot use a tool. The API-key path for OpenAI-compatible providers is
unaffected.

### Fixed

- **Gemini tool calling works at all.** Tool schemas are translated to Google's
  documented `Schema` type instead of being sent as-is, and the
  `thoughtSignature` a model returns beside a function call is carried back into
  the next turn, which is what lets a conversation make more than one tool call.
- **A retired model says so.** Google's model list leads with three models it
  has retired; they are offered and answer `404`. The message now names the
  cause instead of sending the user back to the list that just offered it.
- **`Retry-After` is read**, including Google's body-only `RetryInfo`, so a
  rate-limited request waits the interval the provider asked for rather than a
  guess — and refuses rather than sleeping past a ceiling.
- **An unfunded account is terminal, not retried.** An OpenAI-compatible 429
  that means "no credit" is reported as such, with the fact that waiting will
  not help, instead of being retried as congestion.
- **An unreadable reply is an error, not an empty answer.** A response whose
  parts carry no readable text no longer returns as a successful empty reply.
- **A credential is renewed against the caller's horizon.** A task resolves its
  credential once at the start, so a token valid now but expiring mid-run is
  renewed up front rather than failing partway through with a terminal 401.
- **Disconnecting a Google-authorized account revokes the grant.** The refresh
  token is posted to Google's revocation endpoint before it is deleted locally,
  because deleting it first destroys the token revocation needs. A disconnect
  still always disconnects, whatever Google answers.

### Changed

- **`identity` is declared only when it can be used.** The permission exists for
  one flow, authorizing a Google account for the Gemini API, and nothing else in
  the build requests it — connectors deliberately use a tab watcher instead. A
  release build with no Google OAuth client id compiled in now drops it from
  `optional_permissions`, because a permission no code path can reach is a
  least-privilege defect and something a reviewer would be right to ask about.
  `validate-release.mjs` asserts the rule in both directions. This build ships
  without the client id, so it declares `downloads` alone — which is what the
  published `0.1.0` listing already declares.

### Not in this update

- No Google OAuth client id, so _Connect with Google_ reports itself
  unavailable with a reason and the Gemini API key path is offered instead. The
  flow is implemented and unit-tested; no real grant has ever been performed.
- Plugins (P-025) remain NOT-STARTED.

---

## 0.1.0 — published

**Published on the Chrome Web Store.** The listing is live at
<https://chromewebstore.google.com/detail/hlhcfmlgoojeoapmijopmicdmmhealhl>,
showing version `0.1.0`, last updated 3 October 2026, 266 KiB, and declaring
_"Website content"_ as the data it handles. The item id was supplied by the
account owner and the listing was then read directly, so this is verified
rather than reported.

**It predates the fixes above**, and the evidence is the published package
itself rather than an inference from dates: downloaded from the Store,
unpacked, and found to contain none of the 3 October markers. Whoever reads
this should assume the published build and `HEAD` behave differently on Gemini.

`0.1.0` is also still the version in `package.json` and the manifest, and work
has continued since the submission — so the artifact a build produces from
`HEAD` today is **not** the artifact under review, even though both carry this
version number.

**That difference now matters, and it is worth being blunt about.** On 3
October 2026 the three provider adapters were exercised against real endpoints
for the first time, and five defects came out that every mocked test in this
repository had passed. Two of them, together, meant **the browser agent could
not run on Gemini at all**: every tool request was refused because canonical
tool schemas carry a field Google's schema type rejects by name, and a
conversation that got past that could make exactly one tool call before Google
refused the turn carrying the tool's result. The artifact under review predates
both fixes, so whatever its review outcome, it should not be the artifact that
is published. `docs/testing/integration-readiness.md` has the five. See
[`docs/release/README.md`](docs/release/README.md#two-artifacts-and-which-one-is-which)
for that distinction and
[`docs/release/chrome-web-store-submission-checklist.md`](docs/release/chrome-web-store-submission-checklist.md)
for what publishing still requires.

The version number is deliberately still `0.1.0`. Three capabilities are
PARTIAL and one is NOT-STARTED (see [`PARITY_MATRIX.md`](PARITY_MATRIX.md)),
and `0.1.0` says so to anyone reading a listing. Bumping it to `1.0.0` would be
a cosmetic change to a number people read as a claim.

**Those two numbers were wrong here until 3 October 2026**, and they had been
wrong for a while: this file said _"seven capabilities are PARTIAL and three
are NOT-STARTED"_ long after the matrix had moved to three and one. Nothing
read it — `release-claims.test.ts` sweeps `README.md`, `PARITY_MATRIX.md` and
everything under `docs/`, and this file is at the repository root, so it was
the one claim document outside every guard. It is inside one now, and the
guard derives the counts from `parity-evidence.json` rather than restating
them.

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

Tracked in `PARITY_MATRIX.md`: **36 PASS, 3 PARTIAL, 1 NOT-STARTED** across the
40 specification capabilities. The one NOT-STARTED is plugins (P-025); the three
PARTIAL are workflow recording (P-022), the connector framework (P-023) and
skills (P-024).

**These three numbers were wrong here until 4 October 2026**, and the reason is
worth recording because it is the second time on this file. `release-claims.test.ts`
was added to stop exactly this drift, and it did catch the word-form sentence
higher up — but its regex matched only _"N capabilities are PARTIAL and M are
NOT-STARTED"_, so this numeric restatement sat outside it and went stale: it
still said 30/8/2, still called MCP (P-026) absent when it had earned PASS, and
still said "every connector except GitHub" when Confluence, Figma and Jira all
ship. The guard now reads numeric claims too.

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

### Two defects found by executing the acceptance procedures

Both were invisible to the automated suite, because both were gaps in what it
asked rather than bugs in what it checked.

**A click that reached a button nobody could have clicked.** Asked to click a
control underneath a full-screen cookie dialog, the extension did so and
reported success. A synthetic click reaches the node whatever is painted over
it, and `isVisible` answers a question about the element rather than about
what is on top of it. Interactions now hit-test after scrolling and refuse an
obscured element, naming the likely cause. This is a security property rather
than polish: an agent that acts on what a person could not see can be steered
by page layout.

**A corrupt health record that read as a healthy one.** A truncated value took
the same code path as an absent one, and an absent one means a clean profile —
so the control whose whole purpose is to fail closed reported HEALTHY over
unreadable bytes. The container shape is now checked, and an unreadable record
blocks work with a reason distinct from a read that threw.

### Verified at this version

|                                       |                               |
| ------------------------------------- | ----------------------------- |
| Unit, integration and security        | 2128 tests in 79 files        |
| Real Chromium (Playwright)            | 189 tests                     |
| Manual acceptance procedures executed | **3 of 15** — 1 failed, fixed |
| Further procedures executed           | 2, not on the original list   |
| Dependency vulnerabilities            | 0                             |

Three of the fifteen written manual procedures were executed — §89's popup,
SPA-navigation and modal cases — and the modal one failed. Two further
procedures were executed that were not on that list: the iframe exclusion,
and §90's malformed persisted state, which is where the second defect came
from.

Twelve remain unexecuted: nine need a credential this repository does not
hold, and three need a person at a machine rather than a headless container.

Executing them turned each into an automated test, so they run on every build
rather than waiting for somebody to remember. See
[`docs/testing/acceptance/RESULTS.md`](docs/testing/acceptance/RESULTS.md).
