# §90 — MV3 failure acceptance tests

> Simulate: service worker restart; side panel close; browser restart;
> extension reload; network interruption. Task state must remain recoverable.

Five items. Read [README.md](README.md) first.

**"Recoverable" is not "resumed".** This repository draws the line
deliberately, and every verdict below depends on it: a task interrupted by an
eviction is _parked_, not continued. The reason is that the extension cannot
know what happened during the gap. A click may have been dispatched and its
navigation lost; a form may have been submitted and the response never seen.
Resuming from the last recorded step would repeat whatever was in flight. So
the state survives, the user is told, and the user decides.

Four of the five are covered by killing a real Chrome service worker in a
real browser, which is the only way this can honestly be tested — a mocked
eviction proves that the code handles the event it was written for.

| Item                   | Verdict                                                      |
| ---------------------- | ------------------------------------------------------------ |
| Service worker restart | `AUTOMATED` in real Chromium                                 |
| Side panel close       | `AUTOMATED` in real Chromium                                 |
| Browser restart        | `MANUAL` — Playwright cannot restart its own browser         |
| Extension reload       | `MANUAL` — same reason                                       |
| Network interruption   | `AUTOMATED` for the classification, `MANUAL` for a real drop |

---

## Service worker restart

**Verdict: `AUTOMATED`, against a real Chrome service-worker termination.**

- EVIDENCE: tests/e2e/mv3-lifecycle.spec.ts :: a task interrupted by a real worker restart is parked, not resumed blind
- EVIDENCE: tests/e2e/mv3-lifecycle.spec.ts :: settings and provider configuration survive a real restart
- EVIDENCE: tests/e2e/mv3-lifecycle.spec.ts :: a task can still run after the worker has restarted
- EVIDENCE: tests/e2e/egress.spec.ts :: taint survives a real worker restart, so the refusal survives with it
- EVIDENCE: tests/e2e/audit.spec.ts :: the trail keeps its sequence across a real worker termination
- EVIDENCE: tests/e2e/skills.spec.ts :: a real worker termination does not reduce a skill task's security state
- EVIDENCE: tests/e2e/persistence-health.spec.ts :: a persistence failure survives a real worker termination
- EVIDENCE: tests/e2e/route-trust.spec.ts :: RC-7 — route trust is back before anything else is, after a worker restart
- EVIDENCE: tests/integration/task-persistence.test.ts :: parks an interrupted task instead of resuming it blind

Seven separate things are asserted to survive an eviction, and they are listed
individually because each is a different way the same restart could go wrong:

| What survives        | Why it is its own assertion                                    |
| -------------------- | -------------------------------------------------------------- |
| Task state           | The item's own requirement                                     |
| Settings             | Losing these silently logs the user out of their own provider  |
| Taint                | State that _restricts_; losing it is a security regression     |
| Audit sequence       | A gap or a reset would break the integrity chain               |
| Skill security state | A multi-step run must not gain permission by being interrupted |
| Persistence health   | A recorded failure that evaporates is worse than none          |
| Route trust          | Restored _before_ routes are served, not alongside them        |

The ordering claim in the last row is the subtle one. If routes became
reachable a moment before the sender check was reinstalled, a restart would be
a window rather than an event.

`a real worker termination does not reduce a skill task's security state` is
the assertion to read if you read only one: it rules out the shape where
interrupting something is a way to get a weaker version of it back.

---

## Side panel close

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/agent-task.spec.ts :: tasks survive the side panel closing and reopening
- EVIDENCE: tests/e2e/route-trust.spec.ts :: RC-6 — reloading the panel does not lock the user out
- EVIDENCE: tests/e2e/route-trust.spec.ts :: RC-8 — an answer to a prompt that is gone still changes nothing
- EVIDENCE: tests/unit/permission-broker.test.ts :: denies a request that is never answered

Closing the panel is not the same failure as killing the worker: the worker
keeps running, and what is lost is the surface the user answers prompts on. So
the case that matters is a prompt that was open when the panel closed, and it
resolves as a **denial** — silence is never consent.

RC-8 covers the mirror image: an answer that arrives for a prompt that no
longer exists changes nothing. A panel reloaded mid-prompt can legitimately
answer twice, so this is reported rather than thrown.

---

## Browser restart

**Verdict: `MANUAL`.**

Playwright drives the browser it launched; it cannot restart it and reattach
to the same profile mid-test. The closest automated coverage is the worker
termination above, which is a strictly weaker event — a browser restart also
clears session storage, and connector tokens live there deliberately.

That difference is the point of running this manually: after a browser
restart, the connector should require re-authorization while the provider
configuration should survive, because the two are stored differently on
purpose.

### Procedure B-1 — manual

1. Start a task and let it get several steps in. Note its id.
2. Quit Chrome completely — not just the window. On macOS, Quit; on Linux and
   Windows, confirm no Chrome process remains.
3. Reopen Chrome and open the side panel.
4. Observe:
   - the task is listed, with its steps, in a parked state;
   - it is **not** running, and did not resume on its own;
   - the provider configuration is intact;
   - a connected connector reports that authorization is needed again.
5. Resume the task and confirm it continues correctly from where it parked.

Met when all five hold. The fourth is the one most likely to surprise, and it
is correct: session storage does not survive a browser restart, and that is
where connector tokens live so that a content script can never read them.

---

## Extension reload

**Verdict: `MANUAL`.**

Reloading an unpacked extension from `chrome://extensions` assigns a fresh
runtime and tears down every context at once — worker, panel and content
scripts. Playwright's extension fixture cannot do this to itself and remain
connected.

### Procedure E-1 — manual

1. Start a task and let it get several steps in.
2. Go to `chrome://extensions` and press **Reload** on the extension.
3. Reopen the side panel.
4. Observe the same five things as B-1, plus:
   - open tabs the agent had claimed are no longer claimed by the old task
     (the content scripts are gone until each tab is reloaded);
   - acting on such a tab reports that the page must be reloaded, rather than
     failing obscurely.

Met when the task is parked and recoverable and no action is attempted against
a tab whose content script is gone. The second half is the part worth watching
— a torn-down content script is exactly the `page not loaded` case in §89,
arriving from a different direction.

---

## Network interruption

**Verdict: `AUTOMATED` for the classification and the retry. `MANUAL` for a
genuine network drop mid-task.**

- EVIDENCE: tests/unit/openai-compatible.test.ts :: maps a network failure to NETWORK_ERROR without leaking the raw message
- EVIDENCE: tests/unit/budget-retry.test.ts :: retries transient failures with growing backoff
- EVIDENCE: tests/unit/budget-retry.test.ts :: stops at the attempt limit
- EVIDENCE: tests/unit/write-guard.test.ts :: treats a timeout as unknown
- EVIDENCE: tests/unit/write-guard.test.ts :: treats an abort as unknown
- EVIDENCE: tests/unit/write-guard.test.ts :: treats an unclassified transport failure as unknown
- EVIDENCE: tests/e2e/provider-integration.spec.ts :: a server error that never clears fails the task cleanly

Three shapes of network failure — a timeout, an abort, and something
unclassifiable — all resolve to **unknown** rather than to failed. That
distinction is what stops a retry duplicating a write that actually landed;
see §86's Duplicate write item.

What is not covered automatically is a drop at an arbitrary moment: the
covered cases are the ones a transport can be asked to produce.

### Procedure N-1 — manual

1. Start a task that will take several turns.
2. Mid-task, disable networking — DevTools' offline mode, or pull the
   interface.
3. Observe the task reports a network failure and retries rather than failing
   immediately.
4. Restore networking within the retry window and confirm the task continues.
5. Repeat, and this time leave the network down past the attempt limit.
   Confirm the task fails cleanly and is recoverable rather than wedged.

Met when 4 continues and 5 stops cleanly. A task that neither continues nor
stops — spinning indefinitely — is not met, and is worth recording with how
long you waited.
