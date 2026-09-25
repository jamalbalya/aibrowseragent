# Acceptance packages

The specification names six sets of acceptance tests, §85–§90, and this
directory holds one package per set. Each package states, item by item, what
the specification asks for, what this repository can actually show for it,
and — where a person has to do the showing — the exact steps.

One package is not a specification section. A capability audit can find that
the only thing standing between a capability and its evidence is a step a
person has to take, and such a step needs a written procedure like any other.
`91-downloads.md` is the first of those, and it says at the top that it is one.

## Three verdicts, and no fourth

Every item carries exactly one:

| Verdict             | Means                                                      |
| ------------------- | ---------------------------------------------------------- |
| `AUTOMATED`         | An automated test already establishes this, and it ran     |
| `MANUAL`            | A person has to execute the written procedure              |
| `NOT POSSIBLE HERE` | The thing the item needs does not exist in this repository |

There is deliberately no `PASS`. A verdict says where the evidence comes from,
not that the item is satisfied. Whether a `MANUAL` item was ever executed is
recorded in [`RESULTS.md`](RESULTS.md) and nowhere else, so an item cannot
become passing by being written down well.

**A procedure existing is not a result.** Every `MANUAL` item is
`NOT YET EXECUTED` until somebody runs it and records what happened, including
the date, the build and the browser version. This is the whole reason the
results live in a separate file: editing a procedure cannot silently edit a
verdict.

## What `AUTOMATED` is allowed to mean

An `AUTOMATED` item cites its evidence as a file and a test title:

```text
- EVIDENCE: tests/e2e/agent-task.spec.ts :: reads a real page and reports a summary with evidence
```

`scripts/check-acceptance.mjs` reads every such line, opens the file, and
fails if the title is not in it. It runs in `scripts/verify.sh` and in CI, so
a renamed or deleted test breaks the build rather than leaving a citation
pointing at nothing. What the checker cannot do is read the test and judge
whether it proves the claim — that is a review question, and the citation
exists so a reviewer has somewhere to look.

Where an item is only partly covered, the uncovered part is stated in the
item's notes rather than rounded up. Several items here are `AUTOMATED` for
the mechanism and `MANUAL` for the judgement — a test can assert that a
summary was produced and cannot assert that the summary is any good.

## What `NOT POSSIBLE HERE` is allowed to mean

That the repository lacks the capability or the external dependency, with the
reason named. It is not a way to retire an inconvenient item: an item that
could be covered by building something is a gap in the product, and it says
so. The distinction that matters throughout is between

- **work this repository can do** — anything implementable here, which is not
  deferred to a person; and
- **work only the account owner can do** — registering an OAuth application,
  holding a vendor API key, accepting a developer agreement.

No credential, OAuth application or external approval is fabricated anywhere
in this package to make an item look executable.

## The packages

| Package                                          | Specification section                |
| ------------------------------------------------ | ------------------------------------ |
| [85-mandatory.md](85-mandatory.md)               | §85 Mandatory acceptance tests, A–F  |
| [86-security.md](86-security.md)                 | §86 Security acceptance tests        |
| [87-providers.md](87-providers.md)               | §87 Provider acceptance tests        |
| [88-connectors.md](88-connectors.md)             | §88 Connector acceptance tests       |
| [89-browser-failures.md](89-browser-failures.md) | §89 Browser failure acceptance tests |
| [90-mv3-failures.md](90-mv3-failures.md)         | §90 MV3 failure acceptance tests     |
| [91-downloads.md](91-downloads.md)               | P-011 downloads — capability audit   |
| [RESULTS.md](RESULTS.md)                         | What has actually been executed      |

## Preparing to execute a manual item

Every manual procedure in this directory assumes this setup, and says so by
referring to it rather than repeating it.

```bash
npm ci
npm run build          # produces dist/
```

Then load the extension:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select the `dist/` directory.
4. Note the extension id Chrome assigns; some procedures need it.
5. Open the side panel from the toolbar action.

A provider must be configured before any item involving a task. The extension
ships no credential and none is supplied here: use your own API key for one of
the three API providers, entered in the side panel's settings. Items that need
a _specific_ provider say which.

Several procedures need the local test site the automated suite uses. It is
started by the Playwright fixture, so the simplest way to get it is:

```bash
npx playwright test tests/e2e/agent-task.spec.ts --headed --debug
```

which starts the site and pauses. The site's routes are listed in
`tests/e2e/fixtures/test-site.ts`; the ones the procedures use are `/`,
`/details`, `/hostile`, `/redirect`, `/controls` and `/cross-site-form`.

## Recording a result

Append to `RESULTS.md`. A result names the item, the date, the commit, the
Chrome version, what was observed, and the verdict `EXECUTED — MET` or
`EXECUTED — NOT MET`. An item that was attempted and could not be completed is
recorded as `EXECUTED — BLOCKED` with what blocked it. Nothing is recorded as
met on the strength of having been read.
