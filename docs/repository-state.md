# Repository state

A short, factual record of repository-level issues that code cannot fix.
Delete a section once its issue is resolved.

There are currently no open issues. The two that were open are recorded below
as resolved, because both were reported as blockers in Stage 2 audits and a
reader of those reports should be able to find out what happened to them.

## Resolved: the default branch was a machine-generated branch name

The repository's default branch was once an obsolete temporary branch created
by an automation harness, whose generated name carried an assistant's name and
therefore breached this project's ownership rules. It was never this project's
development branch, and it no longer exists, so it is not named here.

The owner has since set the default branch to `main` and deleted the obsolete
branch. Verified against the GitHub API:

```json
{ "default_branch": "main" }
```

with `main` the only branch in the repository. No history was rewritten and
nothing was force-pushed at any point; `main` was created by pointing a new
branch at an already-published commit, and the obsolete branch was a strict
ancestor of it with zero unique commits.

Sessions working here must not recreate a branch named after an assistant,
vendor or model. `main` is the canonical branch.

## Resolved: the authoritative specification was not in the repository

`PARITY_MATRIX.md` tracks forty capabilities "from the specification" and
quotes section numbers throughout; source files cite dozens more. For most of
the project's life that document existed only outside the repository, so every
status could be checked against a restatement of a requirement and never
against the requirement.

It is now committed verbatim at
[`docs/spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md`](spec/AI_Browser_Agent_Specs_Kit_v1.1_Unbranded.md)
and excluded from formatting in `.prettierignore` so it cannot drift. It is
**authoritative**, not reference-only: where this repository's documentation
disagrees with it, the specification wins.

Committing it immediately surfaced one such disagreement. `PARITY_MATRIX.md`
had been listing five conditions for a capability to be PASS; specification
§84 sets six, and the one that had gone missing was "manual acceptance test
exists". That is corrected in `PARITY_MATRIX.md`, which now also states
plainly that no row satisfies §84 on its own.

## Open: manual acceptance tests have not been run

Not a blocker for Stage 2, and recorded here so it is not mistaken for one.

Specification §84 requires a manual acceptance test for a capability to be
PASS, and §85–§89 define them: six end-to-end scenarios (§85 A–F) plus
security, provider, connector and browser-failure suites. None has been
executed or recorded.

They cannot be run from the current scope: §85 D and E require Jira,
Confluence, Figma and Google Sheets connectors, and §85 F and §87 require
OpenAI, Anthropic and Gemini adapters. Those are Phases 6 and 5 of §96, and
the acceptance run itself is Phase 10. Stage 2 covers Phases 1–4 plus the
OpenAI-compatible adapter.

**REQUIRED FOR PARITY, NOT FOR STAGE 2:** execute §85–§89 once the relevant
phases exist, and record the results here.

## Open: no provider credentials are configured

Live provider end-to-end testing has never run because no legitimate project
credentials are configured. None were borrowed, invented, or taken from a
harness or another project. The mock-provider suite exercises real HTTP against
a local Chat Completions server and is never described as a live one.

**REQUIRED OWNER ACTION, WHEN WANTED:** configure project provider credentials.
