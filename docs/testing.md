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

| File                         | Proves                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `secret-redaction.test.ts`   | 15 credential formats are removed; redaction is idempotent and stable across calls; deep objects, cycles and depth bombs are handled                   |
| `prompt-injection.test.ts`   | A page cannot close the data envelope early, forge a trust attribute, or escape via a forged system tag; detection is advisory and never changes trust |
| `origin-validation.test.ts`  | Dangerous schemes are refused; a lookalike subdomain is not treated as the same site; every non-same-origin transition forces re-evaluation            |
| `exfiltration.test.ts`       | Credentials are blocked to any destination; cross-site movement of private data requires elevated confirmation                                         |
| `debugger-allowlist.test.ts` | No script-execution method is reachable; no tool accepts a CDP method name; console and network data is redacted at collection time                    |

### `tests/unit/`

| File                         | Proves                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy-engine.test.ts`      | Ordering: each stage only tightens. Prohibitions hold in every mode. Skip still confirms at R3+                                                                           |
| `permission-engine.test.ts`  | A DENY is never put to the user; a prompter failure is a denial; site approval is scoped to the registrable site                                                          |
| `permission-broker.test.ts`  | An unanswered prompt resolves as denial, not approval; concurrent prompts stay independent                                                                                |
| `tool-registry.test.ts`      | Invalid arguments never reach an implementation; a denied call never executes; secrets are stripped from results and prompts; raw exception text does not reach the model |
| `task-model.test.ts`         | Every live state can reach CANCELLED, FAILED and PAUSED; terminal states are absorbing                                                                                    |
| `storage.test.ts`            | 50 concurrent read-modify-writes all land; namespaces are isolated; a rejected transaction does not poison the key                                                        |
| `loop-detection.test.ts`     | Repeated failure, identical repetition and cycles are caught — and normal `read → act → read` progress is **not**                                                         |
| `budget-retry.test.ts`       | Every budget dimension fires; only transient codes retry; jitter is applied                                                                                               |
| `openai-compatible.test.ts`  | Wire translation both ways; every HTTP status maps to a canonical code; SSE frames split across chunk boundaries reassemble                                               |
| `capability-doctor.test.ts`  | AGENT_READY is reported only when tool calling actually worked; quick mode refuses to claim it at all                                                                     |
| `semantic-tree.test.ts`      | Roles and accessible names follow the accname precedence; password values never enter the page model; truncation is reported honestly                                     |
| `interaction-engine.test.ts` | Framework-controlled inputs receive the change; stale handles are refused with a reason; clicks survive a missing `PointerEvent`                                          |
| `browser-tools.test.ts`      | Origin drift stops an action; typed text is never echoed back; screenshots go to evidence, not into context                                                               |
| `tab-tools.test.ts`          | A user's own tab is R3 and always confirms; the agent's own tab is R1 and does not                                                                                        |
| `evidence-store.test.ts`     | Text payloads are redacted before storage; base64 is not corrupted; eviction leaves no orphaned payloads                                                                  |
| `context-builder.test.ts`    | Oldest tool results are trimmed before turns are dropped; recent turns are never dropped                                                                                  |

### `tests/e2e/`

Loads the built extension into a real Chromium and drives it. Nothing is
stubbed except the model's choice of tool call: the pages are served over real
HTTP, the content script is really injected, and the provider is a real HTTP
server whose received bytes are inspected.

This is what proves the extension _works_, as opposed to proving its modules
behave.

| File                           | Proves                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension-load.spec.ts`       | Chrome accepts the package, the service worker starts and registers 25 tools, the side panel mounts, and the composer stays disabled until tool calling is verified                                                                                                                       |
| `provider-integration.spec.ts` | Real HTTP to a real endpoint: the doctor's probes are genuine round trips, the API key travels only as a bearer header, HTTP status maps to the right canonical code, and a rate limit is retried while a 500 storm is not retried forever                                                |
| `agent-task.spec.ts`           | Full trajectories against a live page — read, type, click, navigate, screenshot — plus cancellation, stale-handle refusal, and a task outliving the side panel                                                                                                                            |
| `security.spec.ts`             | A genuinely hostile page cannot escape the data envelope; a credential on the page never reaches the provider; a password field value reaches neither the provider nor evidence; refused schemes do not navigate; unknown tools and malformed arguments are rejected before anything runs |
| `mv3-lifecycle.spec.ts`        | A real Chrome service-worker kill, after which an interrupted task is parked, the provider configuration still works, a new task runs, and the debugger recovers from a closed tab                                                                                                        |

Two things about this suite are worth knowing before changing it:

- **The content script only matches `http`/`https`.** `page.setContent` produces
  an `about:blank` document that gets no injection, so fixtures are served from
  a local HTTP server.
- **`chrome.runtime.sendMessage` from inside the service worker is not
  delivered to that worker's own listener.** Messages have to originate from an
  extension page, which is what the `panel` fixture provides.

### `tests/integration/`

| File                       | Proves                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-runtime.test.ts`    | The full loop against real policy and real tools: the required demo flow, capability gating, loop and budget stops, cancellation, provider retry, and that a failed tool is never reported as success |
| `task-persistence.test.ts` | State survives a simulated worker eviction; interrupted tasks are parked, not resumed blind; recovery is idempotent                                                                                   |
| `task-manager.test.ts`     | Create, pause, resume, cancel and retry; a cancel issued immediately after create actually cancels                                                                                                    |
| `messaging.test.ts`        | Errors cross the boundary as data; timeouts are structured; a missing content script maps to a retryable failure                                                                                      |

## Defects this suite has caught

These were found by tests during development and fixed. They are listed because
"the tests pass" means more when you can see what they caught.

| Defect                                                       | Impact                                                                                                                   | Fix                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Loop detector flagged normal page re-reads                   | **Every multi-step task would die at its third page read.** Re-reading after a click is required, since handles go stale | A successful state-changing call resets other calls' streaks                         |
| `cancel()` raced with task startup                           | Pressing Stop right after starting silently did nothing; the task ran to completion                                      | The abort handle is registered synchronously before execution is scheduled           |
| `QUEUED → PAUSED` and `RECOVERING → PAUSED` were illegal     | Pausing aborted the runner but left the record stuck with nothing executing it                                           | Both transitions added; a test now asserts PAUSED is reachable from every live state |
| `Number('')` is `0`, so unset opacity read as invisible      | Every element could be judged invisible                                                                                  | Parse with `Number.parseFloat` and only reject a genuine zero                        |
| Google API key rule required an exact 35-char suffix         | A key of any other length leaked through redaction                                                                       | Length range instead of an exact count                                               |
| `ProviderRequestError` imported from a specific adapter      | Any other adapter's structured errors were flattened to a generic `MODEL_ERROR`, losing the retry classification         | Moved to `providers/core`, detected structurally                                     |
| `tabs.close` floor of R2 outranked its own R1 classification | The agent prompted to close its own scratch tabs, training reflexive approval                                            | Floor lowered to R1; classification escalates to R3 for a user's tab                 |
| `update()` helper's get and set were separate queue entries  | Concurrent task updates could interleave and lose one                                                                    | Per-key mutex with a real transaction                                                |
| ESLint `rules` spread replaced the disabled-rule set         | Lint could not run at all on config files                                                                                | Merge explicitly instead of overwriting                                              |

## Coverage

Coverage is reported but is not the acceptance criterion. A test that asserts a
control cannot be defeated is worth more than one that raises a percentage.
The security suite in particular is written to fail when a control regresses,
not to touch lines.

## Not yet covered

Stated plainly rather than implied by omission:

- **No test against a commercial provider.** The adapter is exercised over real
  HTTP against a local server that implements the Chat Completions protocol.
  That covers sockets, headers, CORS and SSE framing, but not a specific
  vendor's quirks. Running the acceptance suite against OpenAI, Anthropic and
  Gemini is what specification §87 asks for and what P-033 still needs.
- **No React component tests.** The side panel is covered through E2E — it
  really mounts, and its disabled states are asserted — but individual
  components are not rendered in isolation.
- **Notifications are untested.** `chrome.notifications` is called directly in
  the service worker rather than behind an injectable seam, and headless
  Chromium does not surface notifications. The seam is the fix, not an E2E test.
- **No sustained long-running task test.** The longest trajectory under test is
  a handful of turns.
- Connectors, MCP, skills, workflows and scheduling are untested because they
  are unimplemented.
