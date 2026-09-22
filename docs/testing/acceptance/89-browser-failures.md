# §89 — Browser failure acceptance tests

> Test: page not loaded; element missing; element disabled; tab closed;
> navigation timeout; iframe; popup; redirect; SPA navigation; modal; stale
> element; debugger unavailable.

Twelve items. Read [README.md](README.md) first.

The theme running through all of them is that a browser failure must reach the
model as a _stated_ failure. The dangerous shape is not an error — it is a
tool that quietly does something adjacent to what was asked and reports
success: clicking a different element because the intended one is gone,
reading a page that is not the page the model read, filing an empty screenshot
as evidence.

Eleven items are now `AUTOMATED` and one is `NOT POSSIBLE HERE`. Four of the
eleven — popup, SPA navigation, modal and the iframe exclusion — were gaps
until 2026-09-22, when the procedures written here were executed against the
built extension in real Chromium.

**The modal procedure failed.** It is the reason the others were worth
executing too: the extension reported a successful click on a button
underneath a full-screen overlay, which is the exact shape this package was
written to catch. The defect is fixed and the procedure now passes; see
[RESULTS.md](RESULTS.md) for what the failure was.

| Item                 | Verdict                                      |
| -------------------- | -------------------------------------------- |
| Page not loaded      | `AUTOMATED`                                  |
| Element missing      | `AUTOMATED`                                  |
| Element disabled     | `AUTOMATED`                                  |
| Tab closed           | `AUTOMATED`                                  |
| Navigation timeout   | `AUTOMATED`                                  |
| Iframe               | `NOT POSSIBLE HERE` — `all_frames` is false  |
| Popup                | `MANUAL` — not covered by any automated test |
| Redirect             | `AUTOMATED`                                  |
| SPA navigation       | `MANUAL` — not covered by any automated test |
| Modal                | `MANUAL` — not covered by any automated test |
| Stale element        | `AUTOMATED`                                  |
| Debugger unavailable | `AUTOMATED`                                  |

---

## Page not loaded

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/browser-tools.test.ts :: refuses to read a non-automatable page
- EVIDENCE: tests/unit/browser-tools.test.ts :: waits for page load when no selector is given
- EVIDENCE: tests/unit/browser-tools.test.ts :: navigates and waits for the load to complete
- EVIDENCE: tests/e2e/file-access.spec.ts :: no content script is injected into a local file

A page with no content script is not a page this extension can act on, and
saying so is different from returning an empty page model — which a model
would read as "this page has nothing on it" and act accordingly.

---

## Element missing

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/browser-tools.test.ts :: requires an element id
- EVIDENCE: tests/unit/browser-tools.test.ts :: reports a retryable failure when the selector never appears
- EVIDENCE: tests/unit/browser-tools.test.ts :: waits for a selector and reports when it appears
- EVIDENCE: tests/e2e/workflows.spec.ts :: a renamed element fails the replay closed, with nothing clicked
- EVIDENCE: tests/e2e/workflows.spec.ts :: a duplicated element fails the replay closed, with nothing clicked

The two workflow cases are the interesting ones, because a missing element
during _replay_ is where a system is most tempted to guess. Both fail closed
with nothing clicked: a renamed element is not resolved to the nearest match,
and a duplicated one is not resolved to the first.

---

## Element disabled

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/advanced-form-controls.test.ts :: refuses a disabled control
- EVIDENCE: tests/unit/advanced-form-controls.test.ts :: refuses a read-only control
- EVIDENCE: tests/unit/advanced-form-controls.test.ts :: refuses a disabled option rather than silently skipping it
- EVIDENCE: tests/e2e/advanced-forms.spec.ts :: the worker really sets a date through the content script, in a real page

Refusing a disabled _option_ rather than skipping it is the case worth
calling out: skipping would apply a selection the caller never asked for and
never hear about it. The E2E test drives the disabled case against real
Chromium as part of its exercise.

---

## Tab closed

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/browser-tools.test.ts :: reports a closed tab rather than guessing another one
- EVIDENCE: tests/e2e/mv3-lifecycle.spec.ts :: a closed tab does not leave the debugger in a broken state
- EVIDENCE: tests/unit/tab-tools.test.ts :: does not treat another task’s tab as its own

"Rather than guessing another one" is the whole item. A tool that fell back to
the active tab would act on whatever the user happened to be looking at.

---

## Navigation timeout

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/browser-tools.test.ts :: reports a navigation timeout as retryable
- EVIDENCE: tests/unit/budget-retry.test.ts :: retries transient failures with growing backoff
- EVIDENCE: tests/unit/budget-retry.test.ts :: stops at the attempt limit

Classified as retryable, retried with backoff, and eventually stopped. All
three are needed: the first two without the third is an infinite loop.

---

## Iframe

**Verdict: `NOT POSSIBLE HERE`.**

- REASON: The content script declares `all_frames: false`, so it is not
  injected into frames at all. There is no iframe behaviour to test, because
  the extension does not reach inside one.

**Executed 2026-09-22.** The exclusion is now demonstrated rather than
asserted from the manifest, and against the harder case: the child document is
_same-origin_, which the browser would otherwise allow. Frame 0 answers a
content-script message and frame 1 does not; the page model holds the outer
document's button and nothing from the child; an invented handle is refused
and the child's field is untouched.

- EVIDENCE: tests/e2e/browser-failures.spec.ts :: the page model holds the outer document and nothing from the frame
- EVIDENCE: tests/e2e/browser-failures.spec.ts :: Chrome injected the content script into exactly one frame
- EVIDENCE: tests/e2e/browser-failures.spec.ts :: the frame really loaded, so the exclusion is not an empty page

The third is the control: without it, a broken page that loaded nothing would
produce the same result as a correct exclusion.

This is a deliberate security position, not an oversight. Widening
`all_frames` would inject the content script into every cross-origin frame on
every page — including ad frames and embedded third-party widgets — which is a
materially larger attack surface than the feature would repay. It is asserted
as a standing invariant so it cannot be widened quietly:

- EVIDENCE: tests/security/security-invariants.test.ts :: holds exactly the permissions this build justifies
- EVIDENCE: tests/e2e/advanced-forms.spec.ts :: advanced controls added no permission and no host access

The consequence for a user is real and is stated in `PARITY_MATRIX.md`: a form
field inside a cross-origin iframe is out of reach. The agent reports it
cannot see the element rather than failing in some other way, which is the
`element missing` path above.

---

## Popup

**Verdict: `AUTOMATED`. Executed 2026-09-22 — MET.**

- EVIDENCE: tests/e2e/browser-failures.spec.ts :: a target=_blank link really opens a second tab, and the agent sees both
- EVIDENCE: tests/e2e/browser-failures.spec.ts :: the content script is injected into the popup, so it is automatable

Both routes into a second tab are exercised — a `target=_blank` link and a
`window.open` call — and the tab count is read from `chrome.tabs` before and
after, so the popup is established as real rather than assumed.

The second assertion is the one worth having. A popup the agent can _see_ but
cannot _act on_ is a worse state than one it cannot see, because the failure
arrives later and further from its cause. The content script really is
injected, and answers a page read inside the new tab.

## Redirect

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/security/origin-validation.test.ts :: requires revalidation after a cross-site redirect
- EVIDENCE: tests/security/origin-validation.test.ts :: requires revalidation for a same-site subdomain move
- EVIDENCE: tests/security/origin-validation.test.ts :: does not require revalidation for a same-origin move
- EVIDENCE: tests/unit/browser-tools.test.ts :: stops an action when the tab moved to another site after authorisation
- EVIDENCE: tests/unit/browser-tools.test.ts :: allows an action when the page stayed on the same origin

Both directions are asserted, which is what makes this more than a blanket
refusal: a same-origin move does _not_ demand re-authorisation, so the control
is a boundary rather than an obstacle. The same-site subdomain case requires
revalidation, which is stricter than same-site alone and is deliberate.

See also §86's Redirect item, which covers the same mechanism from the
security side.

---

## SPA navigation

**Verdict: `AUTOMATED`. Executed 2026-09-22 — MET.**

- EVIDENCE: tests/e2e/browser-failures.spec.ts :: a handle from before a client-side route change is refused, not resolved
- EVIDENCE: tests/e2e/browser-failures.spec.ts :: a fresh read after the route change sees the new route and not the old

The question was whether the page model goes stale _silently_ when the URL
changes but the document does not — the `stale element` failure arriving
through a door nothing watched. It does not: a handle issued before the
`pushState` is refused with `ELEMENT_NOT_FOUND` and a message telling the
caller to read the page again, which is what makes it recoverable rather than
a dead end.

Both directions are asserted. A build that refused everything after any route
change would satisfy the first and fail the second.

## Modal

**Verdict: `AUTOMATED`. Executed 2026-09-22 — **failed**, defect fixed,
re-executed MET.**

- EVIDENCE: tests/e2e/browser-failures.spec.ts :: clicking the obscured element: what the extension actually does
- EVIDENCE: tests/e2e/browser-failures.spec.ts :: what the browser itself says about the obscured element
- EVIDENCE: tests/e2e/browser-failures.spec.ts :: dismissing the modal first makes the element reachable
- EVIDENCE: tests/unit/occlusion.test.ts :: reports obscured when an overlay is topmost at every point
- EVIDENCE: tests/unit/occlusion.test.ts :: throws when the element is covered, naming the cause and the way out

**This is the item that found something.** On first execution the extension
reported a successful click on a "Buy now" button underneath a full-screen
overlay, and the page recorded the click. A synthetic click reaches the node
whatever is painted over it, and nothing hit-tested. `isVisible` answered
correctly and answered a different question: the button was displayed, opaque,
had a box and passed `checkVisibility`, none of which notice what is on top.

The engine now samples the element's centre and four inset corners after
scrolling, through `scrollIntoViewAndAssertReachable`, and refuses with
`ELEMENT_NOT_INTERACTABLE` naming the likely cause. Five points rather than
one, so a tooltip clipping a corner does not make a large control
unreachable; an ancestor or descendant counts as the element, so a `<label>`
or a button's own `<span>` is not mistaken for an obstruction.

The positive control matters as much as the refusal: dismissing the dialog
first makes the same button clickable. A build that simply refused everything
would pass the first assertion and fail that one.

## Stale element

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/e2e/agent-task.spec.ts :: a stale element handle is refused and reported to the model
- EVIDENCE: tests/unit/interaction-engine.test.ts :: refuses a handle from an earlier snapshot and says why
- EVIDENCE: tests/e2e/workflows.spec.ts :: replaying a recorded click acts on the element that was originally clicked

An element handle is only valid against the page read that issued it. The
third citation is the positive control: refusing everything would satisfy the
first two, and does not satisfy this one.

---

## Debugger unavailable

**Verdict: `AUTOMATED`.**

- EVIDENCE: tests/unit/browser-tools.test.ts :: reports a Chrome refusal to attach in terms the user can act on
- EVIDENCE: tests/unit/browser-tools.test.ts :: leaves a pre-existing debugger session attached
- EVIDENCE: tests/unit/browser-tools.test.ts :: detaches the debugger it attached, leaving no session behind
- EVIDENCE: tests/unit/browser-tools.test.ts :: never reports success when the capture was rejected
- EVIDENCE: tests/unit/browser-tools.test.ts :: refuses an empty capture rather than filing it as evidence
- EVIDENCE: tests/unit/browser-tools.test.ts :: reports an unexpected capture failure without leaking its detail
- EVIDENCE: tests/e2e/file-access.spec.ts :: a screenshot attaches the debugger and hands it straight back

The commonest real cause of "debugger unavailable" is DevTools already being
open on that tab, and the correct response is to say so rather than to detach
the user's own session. Leaving a pre-existing session alone, and detaching
only what this extension attached, are separate assertions for that reason.

`refuses an empty capture rather than filing it as evidence` is the one to
notice: an empty screenshot filed as evidence is worse than no screenshot,
because the audit trail then holds a record that appears to show something.
