# Screenshot plan

What to capture, when you have a provider key and a browser. Every shot here
shows a real capability doing a real thing.

**No screenshots have been produced**, and the reason has changed.

It used to be _"producing them needs a configured provider, and this repository
holds no key"_. **That is no longer true.** As of 3 October 2026 a free Google
AI Studio key reaches the real Gemini API, the extension is live-verified
against it, and a real task runs end to end — so a shot of a working product
with real model output is now possible and no longer needs anything bought.

What remains is not a blocker but a judgement, and it is yours: which
capability to lead with, which page to feature, and how to frame the panel
beside it. Those decide what the listing says about the product, and a
mechanically captured panel would be a worse asset than ten minutes in a real
browser.

Two things were available before and were rejected rather than used. Both
rejections still stand:

- The side panel with no provider configured. That is an empty state, and an
  empty state as a listing asset misrepresents the product.
- Mock-provider output from the end-to-end suite. That is a mocked capability
  presented as real, which is worse than an empty state because it is
  convincing.

Neither is a placeholder to be swapped later. Neither was captured.

### What live testing settled, so your shots do not fail

- **Use a `-latest` or `3.x` Gemini model**, for example
  `gemini-flash-lite-latest`. Google's model list leads with
  `gemini-2.5-flash`, `gemini-2.5-pro` and `gemini-2.5-flash-lite`, and all
  three answer `404 … no longer available to new users`. A shot of that error
  is not the shot you want.
- **`gemini-flash-lite-latest` reaches AGENT_READY** with all twelve
  capability checks passing, so the readiness badge in Settings shows the good
  state rather than `CHAT_ONLY`.
- **The free tier allows fifteen requests a minute.** A session of repeated
  captures will hit 429 at the sixteenth; wait about eleven seconds, which is
  what Google asks for.
- The settings screen shows a **masked key suffix**. It is on the list below of
  things that must never be visible, and it is the one screen where a
  legitimate shot can leak one.

## Before you start

|            |                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- |
| Build      | `npm ci && npm run release`, load `dist/` unpacked                                             |
| Provider   | one API key, in a model that can call tools                                                    |
| Dimensions | **1280×800** or **640×400** — the store accepts either; use 1280×800 throughout and do not mix |
| Format     | PNG or JPEG, 24-bit, no alpha                                                                  |
| Count      | at least 1, at most 5. Four is a good listing                                                  |
| Window     | size the browser so the panel and page are both legible at 1280×800 without scaling            |

## What must never be visible, in any shot

Check every image against this list before uploading. A screenshot is
published at full resolution and is not redacted afterwards.

- An API key, or any part of one — including a masked suffix in settings
- A connector token, an authorization code, or an OAuth `state`
- Any real personal data: a real name, email, address, order or account number
- A real logged-in session on a site you do not own
- A browser profile that is signed in to anything personal
- Bookmarks bar, open tab titles, or history from your own browsing
- A page whose brand you have no permission to feature
- Anything from a page you were not authorised to automate

Use a clean Chrome profile created for this purpose, with an empty bookmarks
bar and no other tabs.

## The shots

### 1 — A task running, with its steps visible

|               |                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Feature       | The core loop: a natural-language task, carried out, with the trajectory shown                  |
| Prerequisite  | provider configured; a public page you are entitled to automate                                 |
| Test data     | Use a page you own or a documentation site. Do **not** use a logged-in account                  |
| Must show     | The panel with the task text, several completed steps naming real tools, and the page beside it |
| Must not show | a half-finished step, an error, the provider's name if you would rather not endorse one         |
| Why this one  | It is the product. If a person looks at one image, this is it                                   |

### 2 — A permission prompt before a consequential action

|               |                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| Feature       | The agent asks before anything consequential, and the user decides                                              |
| Prerequisite  | a task that reaches an R2+ action — a form submission or a navigation away                                      |
| Must show     | the prompt naming the specific action, the site, and both choices                                               |
| Must not show | a prompt already answered                                                                                       |
| Why this one  | The single most important thing a reviewer and a cautious user want to see. It shows the model is not in charge |

### 3 — The audit trail

|               |                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Feature       | Every decision recorded, exportable, holding decisions rather than page content                 |
| Prerequisite  | one completed task                                                                              |
| Must show     | several records with tool names, risk levels and outcomes; the integrity verdict                |
| Must not show | a record containing page text or anything that looks like personal data                         |
| Why this one  | It is the claim that distinguishes this from a scripted macro, and it is checkable in the image |

### 4 — Settings, with a provider connected

|                   |                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| Feature           | Bring your own model; the capability check reports what it actually observed                        |
| Prerequisite      | a connected provider                                                                                |
| Must show         | the provider selected, the model id, and the capability verdict (`AGENT_READY`)                     |
| **Must not show** | **the API key field with any characters in it, including a masked suffix.** Clear it or crop it out |
| Why this one      | It answers "what do I need to use this?" before the install                                         |

### Optional 5 — A refusal

|              |                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Feature      | The agent declines something it should decline                                                                                     |
| Prerequisite | a page with a modal over a control, or a hard-prohibited action                                                                    |
| Must show    | the refusal and its reason                                                                                                         |
| Why          | Most listings show only success. A refusal is the honest differentiator, and this build has two freshly-proved ones to choose from |

## After capturing

1. Open each image at full size and re-read the "must never be visible" list.
2. Check the file's EXIF carries no path or device name.
3. Name them `01-task.png` … `05-refusal.png` so the listing order is obvious.
4. Keep them out of the repository — they are listing assets, not source.

Record in [`../testing/acceptance/RESULTS.md`](../testing/acceptance/RESULTS.md)
that screenshots were captured, when, and against which build. A future reader
should be able to tell whether a listing image matches the shipped version.
