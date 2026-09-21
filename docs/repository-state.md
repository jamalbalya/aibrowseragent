# Repository state

A short, factual record of repository-level issues that code cannot fix.
Delete a section once its issue is resolved.

## Open: the default branch is a machine-generated branch name

**Status:** BLOCKED — needs an action only the repository owner can take.

### What is wrong

The repository's configured default branch is
`claude/dreamy-shannon-tu0z6h`. The project's ownership rules require the
primary branch to be `main` and prohibit tool-generated assistant names
anywhere in repository metadata, which includes branch names.

### What has been done

`main` now exists on the remote and carries the complete, validated history.
It was created by pointing a new branch at the already-published commit, so
no history was rewritten and nothing was force-pushed:

```
git rev-list --count origin/main..origin/claude/dreamy-shannon-tu0z6h
0
```

Zero commits exist on the old branch that are not on `main`. Deleting it
cannot lose work.

CI triggers on `main` and has since been observed passing there in full —
Verify, Dependency audit and the real-Chromium end-to-end job — on run
`35574637544`. Before `main` existed, the `push` trigger matched nothing and
CI never ran on a push at all; the first run after it was created failed its
end-to-end job outright, so "CI is configured" and "CI passes" were separate
facts and had to be checked separately.

### What remains, and why it is blocked

Two steps are left, and neither can be performed from this environment:

1. **Set the default branch to `main`.** There is no tooling here for
   repository settings, and GitHub refuses to delete a branch while it is the
   default, so this must happen first.
2. **Delete `claude/dreamy-shannon-tu0z6h`.** Attempting it returns HTTP 403:
   the available credential cannot delete refs.

### How to finish it

In the GitHub web UI:

1. **Settings → General → Default branch**, switch it to `main`.
2. **Branches**, delete `claude/dreamy-shannon-tu0z6h`.

Or, with a token that has `repo` scope:

```bash
gh repo edit jamalbalya/aibrowseragent --default-branch main
git push origin --delete claude/dreamy-shannon-tu0z6h
```

Afterwards, confirm the repository reports `"default_branch": "main"` and that
`main` is the only branch.

### Note for future sessions

An automation harness may instruct a session to develop on a branch whose name
it generates. When that name carries an assistant name, it conflicts with this
project's ownership rules. Push the work, then land it on `main` and remove the
generated branch rather than leaving it as the project's branch.
