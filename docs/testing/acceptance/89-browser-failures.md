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

Eight items are `AUTOMATED`. Four — iframe, popup, SPA navigation and modal —
are not covered, and two of those are architectural limits rather than gaps.
They are listed as unmet rather than reinterpreted into something that is.

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

**Verdict: `MANUAL`. Not covered by any automated test.**

No automated test opens a `window.open` popup and asserts what happens. This
is a genuine gap, not an architectural limit: a popup is an ordinary tab, and
the tab-ownership rules should apply to it. Whether they do has not been
demonstrated.

### Procedure P-1 — manual

1. Open a page with a link carrying `target="_blank"`, or a button calling
   `window.open`.
2. Ask the agent to click it.
3. Observe:
   - whether the agent notices the new tab at all;
   - whether it treats the new tab as its own or as the user's — the
     distinction that decides the risk level of acting in it;
   - whether acting in the popup raises a permission prompt.

Record what happened even if it was correct. This item exists precisely
because nobody has looked.

---

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

**Verdict: `MANUAL`. Not covered by any automated test.**

Nothing in the suite exercises a route change performed by `history.pushState`
without a document load. The question the item is really asking is whether the
page model goes stale silently when the URL changes but the document does not
— which is the `stale element` failure arriving through a door nothing
watches.

### Procedure S-1 — manual

1. Open a single-page application — any React or Vue router demo, or a site
   you know uses client-side routing.
2. Ask the agent to read the page.
3. Navigate within the app **yourself**, using the app's own links, without a
   full page load.
4. Ask the agent to click an element it saw in step 2.

Met when the agent reports the element is gone or the page has changed. Not
met if it clicks something on the new route, or reports success having clicked
nothing. Record the URL before and after, and whether the document actually
reloaded — some routers do force a load, which makes the test inconclusive
rather than passing.

---

## Modal

**Verdict: `MANUAL`. Not covered by any automated test.**

The page model has no special handling for `<dialog>`, `aria-modal`, or the
inert background a modal creates. An element behind an open modal is not
clickable by a person, and nothing currently tells the model that.

### Procedure M-1 — manual

1. Open a page with a modal dialog — a cookie consent banner that blocks the
   page works well and is easy to find.
2. Ask the agent to read the page, then to click something _behind_ the modal.
3. Observe whether the click is refused, or is attempted and reported as
   succeeding.

Met when the agent either reports the element is not interactable or
interacts with the modal first. Not met if it reports a successful click on an
element a person could not have clicked. This is worth doing early: a false
success here is the shape of failure most likely to mislead a user.

---

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
