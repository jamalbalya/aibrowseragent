# Testing

Every capability claim in this repository is backed by an executed test. A
capability with no test is listed as untested in
[PARITY_MATRIX.md](../PARITY_MATRIX.md) rather than claimed.

## Running

```bash
npm test                  # everything
npm run test:unit         # unit
npm run test:integration  # integration
npm run test:security     # security
npm run test:coverage     # with coverage
npm run verify            # format, lint, typecheck, test, build, package check
```

## Layout

```text
tests/
├── unit/          component behaviour in isolation
├── integration/   several real components wired together
├── security/      adversarial: tries to defeat a control
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

- **No end-to-end browser test.** Playwright is in the recommended stack but no
  E2E suite exists yet. Content-script behaviour is tested against jsdom, which
  has no layout engine — `getBoundingClientRect` is shimmed, so real-browser
  layout behaviour is not exercised.
- **No live provider test.** The OpenAI-compatible adapter is tested against a
  stubbed `fetch`. It has not been run against a live endpoint in CI.
- **No React component tests.** The side panel's logic is covered through the
  hook it calls into, not through rendering.
- Connectors, MCP, skills, workflows and scheduling are untested because they
  are unimplemented.
