# Testing

Every capability claim in this repository is backed by an executed test. A
capability with no test is listed as untested in
[PARITY_MATRIX.md](../PARITY_MATRIX.md) rather than claimed.

## Running

```bash
npm test                  # unit, integration and security
npm run test:unit         # unit
npm run test:integration  # integration
npm run test:security     # security
npm run test:e2e          # end-to-end, in a real Chromium
npm run test:coverage     # with coverage
npm run verify            # everything except E2E
npm run verify:full       # verify + E2E
```

`npm run test:e2e` loads `dist/`, so run `npm run build` first. The fixtures use
the Chromium at `/opt/pw-browsers/chromium`; set `E2E_CHROMIUM_PATH` to another
binary, or to an empty string to let Playwright resolve its own.

## Layout

```text
tests/
├── unit/          component behaviour in isolation
├── integration/   several real components wired together
├── security/      adversarial: tries to defeat a control
├── e2e/           the built extension in a real Chromium
└── fixtures/      fakes that model real behaviour, not convenient behaviour
```

### Fixtures are faithful, not convenient

A fake that behaves more simply than the real thing produces tests that pass
while the product is broken. Two examples from this repository:

- `FakeBrowserAdapter` converts a content-script failure into the same
  structured `MessagingError` the real bus produces. An earlier version threw a
  plain `Error`, and a test asserted an error code the production path never
  actually returned.
- `FakeProvider` records every request it receives, which is how the security
  tests assert that no secret and no raw page instruction reached the provider.

## What each suite proves

### `tests/security/`

Adversarial. Each test tries to break a control rather than confirm it works on
its happy path.

Two kinds of evidence appear here and are not interchangeable. **Deterministic
regression vectors** pin an exact input to an exact outcome, so a failure names
the case. **Sampled coverage** runs a property over many generated inputs, which
is how the redaction defects were found in the first place — a bug that appears
on one draw in ten is invisible to fixed vectors. Neither is exhaustive, and no
claim of exhaustiveness is made anywhere in this repository.

| File                         | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secret-redaction.test.ts`   | Two kinds of coverage, kept separate. **Deterministic vectors:** nine secret formats redacted and fourteen identifier shapes preserved byte-for-byte — the exact evidence id and epoch timestamp that were once corrupted, task/tool-call/session ids, UUIDs, URLs, log lines, a git sha and a base64 head — plus two gate tests that isolate the issuer-prefix and Luhn constraints one at a time. **Sampled:** 5000 generated ids and 5000 timestamps survive while 5000 synthesised Visa numbers are redacted, which is how the original defects were found. Also: idempotence, stability across calls, deep objects, cycles and depth bombs |
| `prompt-injection.test.ts`   | A page cannot close the data envelope early, forge a trust attribute, or escape via a forged system tag; detection is advisory and never changes trust                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `origin-validation.test.ts`  | Dangerous schemes are refused; a lookalike subdomain is not treated as the same site; every non-same-origin transition forces re-evaluation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `exfiltration.test.ts`       | Credentials are blocked to any destination; cross-site movement of private data requires elevated confirmation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `debugger-allowlist.test.ts` | No script-execution method is reachable; no tool accepts a CDP method name; console and network data is redacted at collection time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `screenshot-capture.test.ts` | A blocked scheme is refused before the debugger attaches, so a `file://` page is never instrumented; an origin change after authorisation stops the capture; a failed, empty or non-PNG capture yields an error and no evidence, never a silent success; the shipped manifest does not request `<all_urls>`                                                                                                                                                                                                                                                                                                                                     |

### `tests/unit/`

| File                         | Proves                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy-engine.test.ts`      | Ordering: each stage only tightens. Prohibitions hold in every mode. Skip still confirms at R3+                                                                                                                                                |
| `permission-engine.test.ts`  | A DENY is never put to the user; a prompter failure is a denial; site approval is scoped to the registrable site                                                                                                                               |
| `permission-broker.test.ts`  | An unanswered prompt resolves as denial, not approval; concurrent prompts stay independent                                                                                                                                                     |
| `tool-registry.test.ts`      | Invalid arguments never reach an implementation; a denied call never executes; secrets are stripped from results and prompts; raw exception text does not reach the model                                                                      |
| `task-model.test.ts`         | Every live state can reach CANCELLED, FAILED and PAUSED; terminal states are absorbing                                                                                                                                                         |
| `storage.test.ts`            | 50 concurrent read-modify-writes all land; namespaces are isolated; a rejected transaction does not poison the key                                                                                                                             |
| `loop-detection.test.ts`     | Repeated failure, identical repetition and cycles are caught — and normal `read → act → read` progress is **not**                                                                                                                              |
| `budget-retry.test.ts`       | Every budget dimension fires; only transient codes retry; jitter is applied                                                                                                                                                                    |
| `openai-compatible.test.ts`  | Wire translation both ways; every HTTP status maps to a canonical code; SSE frames split across chunk boundaries reassemble                                                                                                                    |
| `capability-doctor.test.ts`  | AGENT_READY is reported only when tool calling actually worked; quick mode refuses to claim it at all                                                                                                                                          |
| `semantic-tree.test.ts`      | Roles and accessible names follow the accname precedence; password values never enter the page model; truncation is reported honestly                                                                                                          |
| `interaction-engine.test.ts` | Framework-controlled inputs receive the change; stale handles are refused with a reason; clicks survive a missing `PointerEvent`                                                                                                               |
| `browser-tools.test.ts`      | Origin drift stops an action; typed text is never echoed back; screenshots go to evidence, not into context, and a pre-existing debugger session is left attached                                                                              |
| `tab-tools.test.ts`          | A user's own tab is R3 and always confirms; the agent's own tab is R1 and does not                                                                                                                                                             |
| `evidence-store.test.ts`     | Text payloads are redacted before storage; base64 is not corrupted; eviction leaves no orphaned payloads                                                                                                                                       |
| `test-identifiers.test.ts`   | Every suite carries a `TEST-<AREA>-<NNN>` identifier and no two suites share one — it happened twice, both times a new suite copying a neighbour's header                                                                                      |
| `notifier.test.ts`           | A notification names the tool and carries nothing else from the call; the setting is read live so disabling it takes effect immediately; a settings-read failure stays quiet; a Chrome refusal never fails the approval the user is waiting on |
| `provider-registry.test.ts`  | With two providers registered: a duplicate id is refused, an unregistered target throws instead of redirecting, a failed connection leaves the working provider active, and disconnect clears only the active one                              |
| `context-builder.test.ts`    | Oldest tool results are trimmed before turns are dropped; recent turns are never dropped                                                                                                                                                       |

### `tests/e2e/`

Loads the built extension into a real Chromium and drives it. Nothing is
stubbed except the model's choice of tool call: the pages are served over real
HTTP, the content script is really injected, and the provider exchange goes
over real HTTP to a local server whose received bytes are inspected.

This is what proves the extension _works_, as opposed to proving its modules
behave.

#### Mock provider, not live provider

The distinction is used strictly throughout this repository:

| Term                  | Meaning                                                                                                                                                                 | Status here                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Mock provider E2E** | A local, deterministic server implementing the Chat Completions protocol. Exercises real sockets, headers, CORS preflight, SSE framing, tool calling and error mapping. | **Implemented** — `provider-integration.spec.ts`                                             |
| **Live provider E2E** | An actual external AI provider endpoint reached with real credentials.                                                                                                  | **Skipped** — no provider credentials are configured for this project, and none are invented |

"Real HTTP" describes the transport, never the counterparty. A mock-provider
result is not evidence that any commercial provider has been exercised.

| File                           | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension-load.spec.ts`       | Chrome accepts the package, the service worker starts and registers 25 tools, the side panel mounts, the composer stays disabled until tool calling is verified, the agent works across more than one real tab, and an anti-vacuity guard proves the browser genuinely hosts the extension rather than silently failing to load it                                                                                                     |
| `provider-integration.spec.ts` | **Mock provider E2E.** Real HTTP to a local Chat Completions server: the doctor's probes are genuine round trips, the API key travels only as a bearer header, HTTP status maps to the right canonical code, and a rate limit is retried while a 500 storm is not retried forever                                                                                                                                                      |
| `agent-task.spec.ts`           | Full trajectories against a live page — read, type, click, navigate, screenshot — plus cancellation, stale-handle refusal, a task outliving the side panel, and real tab grouping through `chrome.tabs.group`                                                                                                                                                                                                                          |
| `file-access.spec.ts`          | The local filesystem stays out of reach: Chrome refuses `scripting.executeScript` on a `file://` tab and injects no content script there (with an http negative control), every browser and debugger tool refuses such a tab without attaching the debugger to it, navigation and tab creation to `file:`/`ftp:` are refused, and a screenshot on an allowed page attaches and detaches cleanly                                        |
| `security.spec.ts`             | A genuinely hostile page cannot escape the data envelope; a credential on the page never reaches the provider; a password field value reaches neither the provider nor evidence; refused schemes do not navigate; unknown tools and malformed arguments are rejected before anything runs; and Chrome itself — not this extension's policy — still refuses `scripting.executeScript` against a `file://` tab under the loaded manifest |
| `mv3-lifecycle.spec.ts`        | A real Chrome service-worker kill, after which an interrupted task is parked, the provider configuration still works, a new task runs, and the debugger recovers from a closed tab                                                                                                                                                                                                                                                     |

Three things about this suite are worth knowing before changing it:

- **The launch must pin the `chromium` channel.** A plain `headless: true`
  resolves `chrome-headless-shell`, which cannot load extensions at all. That
  configuration does not fail loudly: the extension is simply absent and every
  test times out waiting for a service worker, which reads as flakiness. It
  shipped that way and CI was red for the entire suite while the same tests
  passed locally against an explicit binary. `extension-load.spec.ts` carries
  an assertion that only a real Chromium with the extension installed can
  satisfy, so the regression fails fast instead of timing out.

- **The content script only matches `http`/`https`.** `page.setContent` produces
  an `about:blank` document that gets no injection, so fixtures are served from
  a local HTTP server.
- **`chrome.runtime.sendMessage` from inside the service worker is not
  delivered to that worker's own listener.** Messages have to originate from an
  extension page, which is what the `panel` fixture provides.

### `tests/integration/`

| File                       | Proves                                                                                                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-runtime.test.ts`    | The full loop against real policy and real tools: the required demo flow, capability gating, loop and budget stops, cancellation, provider retry, and that a failed tool is never reported as success                              |
| `sustained-task.test.ts`   | An 18-turn trajectory completes without tripping a budget or the loop detector; usage accounting equals the work performed exactly; every step is recorded once and in order; a model that never finishes is stopped by the budget |
| `task-persistence.test.ts` | State survives a simulated worker eviction; interrupted tasks are parked, not resumed blind; recovery is idempotent                                                                                                                |
| `task-manager.test.ts`     | Create, pause, resume, cancel and retry; a cancel issued immediately after create actually cancels                                                                                                                                 |
| `messaging.test.ts`        | Errors cross the boundary as data; timeouts are structured; a missing content script maps to a retryable failure                                                                                                                   |

## Defects this suite has caught

These were found by tests during development and fixed. They are listed because
"the tests pass" means more when you can see what they caught.

| Defect                                                       | Impact                                                                                                                                                                         | Fix                                                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Loop detector flagged normal page re-reads                   | **Every multi-step task would die at its third page read.** Re-reading after a click is required, since handles go stale                                                       | A successful state-changing call resets other calls' streaks                                                                         |
| `cancel()` raced with task startup                           | Pressing Stop right after starting silently did nothing; the task ran to completion                                                                                            | The abort handle is registered synchronously before execution is scheduled                                                           |
| `QUEUED → PAUSED` and `RECOVERING → PAUSED` were illegal     | Pausing aborted the runner but left the record stuck with nothing executing it                                                                                                 | Both transitions added; a test now asserts PAUSED is reachable from every live state                                                 |
| `Number('')` is `0`, so unset opacity read as invisible      | Every element could be judged invisible                                                                                                                                        | Parse with `Number.parseFloat` and only reject a genuine zero                                                                        |
| Google API key rule required an exact 35-char suffix         | A key of any other length leaked through redaction                                                                                                                             | Length range instead of an exact count                                                                                               |
| `ProviderRequestError` imported from a specific adapter      | Any other adapter's structured errors were flattened to a generic `MODEL_ERROR`, losing the retry classification                                                               | Moved to `providers/core`, detected structurally                                                                                     |
| `tabs.close` floor of R2 outranked its own R1 classification | The agent prompted to close its own scratch tabs, training reflexive approval                                                                                                  | Floor lowered to R1; classification escalates to R3 for a user's tab                                                                 |
| `update()` helper's get and set were separate queue entries  | Concurrent task updates could interleave and lose one                                                                                                                          | Per-key mutex with a real transaction                                                                                                |
| ESLint `rules` spread replaced the disabled-rule set         | Lint could not run at all on config files                                                                                                                                      | Merge explicitly instead of overwriting                                                                                              |
| `browser.screenshot` needed the `<all_urls>` host permission | Measured: under `<all_urls>` the extension could read local files through `scripting.executeScript`; Chrome refuses under `http` + `https`                                     | Capture through `Page.captureScreenshot`, which needs no host permission; the manifest stays narrow and the build fails if it widens |
| The E2E suite resolved `chrome-headless-shell` in CI         | The headless shell cannot load extensions, so all 38 tests timed out waiting for a service worker — while passing locally, where an explicit binary was used                   | The launch pins the `chromium` channel, and the fixture now names the cause instead of timing out                                    |
| Card-number redaction matched on shape alone                 | An evidence id whose tail is all digits had that tail replaced, breaking the reference the model cites — roughly one identifier in five hundred                                | The match must also satisfy the Luhn checksum                                                                                        |
| Luhn alone still matched timestamps and some UUID tails      | About one digit string in ten passes Luhn by chance, and an epoch-millisecond timestamp is 13 digits, so `capturedAt 1758441192004` was redacted on every record that drew one | A candidate must also stand alone as a token and carry a published issuer prefix; the regression samples rather than fixing vectors  |

## Coverage

Coverage is reported but is not the acceptance criterion. A test that asserts a
control cannot be defeated is worth more than one that raises a percentage.
The security suite in particular is written to fail when a control regresses,
not to touch lines.

## Not yet covered

Stated plainly rather than implied by omission:

- **Live provider E2E is skipped, not passing.** The adapter is exercised over
  real HTTP against a local server implementing the Chat Completions protocol.
  That covers sockets, headers, CORS and SSE framing, but not a specific
  vendor's quirks. No provider credentials are configured for this project and
  none are invented, so the live suite has never run. Executing it against
  OpenAI, Anthropic and Gemini is what specification §87 asks for and what
  P-033 still needs.
- **No React component tests.** The side panel is covered through E2E — it
  really mounts against the extension origin, its disabled states are
  asserted, and it reflects a connected provider — but individual components
  are not rendered in isolation. This is a deliberate limit rather than a
  pending task: standing up a component renderer to assert markup that the
  end-to-end suite already exercises in a real browser would add a testing
  stack without adding a guarantee.
- **Wall-clock duration is not tested in wall-clock time.** A sustained run is
  covered by turns rather than seconds (`sustained-task.test.ts`, 18 turns and
  36 tool calls, with usage accounting and step ordering asserted exactly),
  and the duration budget is covered with an injected clock. A test that
  really slept would be slower, flakier, and would prove less.
- Connectors, MCP, skills, workflows and scheduling are untested because they
  are unimplemented.
