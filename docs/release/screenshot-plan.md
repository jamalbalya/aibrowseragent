# Screenshot plan

What to capture, when you have a provider key and a browser. Every shot here
shows a real capability doing a real thing.

**No screenshots have been produced.** Producing them needs a configured
provider, and this repository holds no key. Two things were available without
one and both were rejected rather than used:

- The side panel with no provider configured. That is an empty state, and an
  empty state as a listing asset misrepresents the product.
- Mock-provider output from the end-to-end suite. That is a mocked capability
  presented as real, which is worse than an empty state because it is
  convincing.

Neither is a placeholder to be swapped later. Neither was captured.

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
