# Repository state

A short, factual record of repository-level issues that code cannot fix.
Delete a section once its issue is resolved.

## Open: the default branch is a machine-generated branch name

**Status:** BLOCKED — needs the owner to act from outside this environment.
The account already holds the rights; the network policy here does not allow
the calls. See "What remains" below for the exact refusals.

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

Two steps are left, in this order, and neither can be performed from this
environment. The reason is narrower than an earlier version of this note
claimed, and the distinction matters to whoever finishes it.

**The account is not the problem.** The authenticated GitHub account is
`jamalbalya`, and the repository reports its permissions as:

```json
{ "admin": true, "maintain": true, "push": true, "triage": true, "pull": true }
```

Administration rights exist. What blocks the work is the network policy of the
agent proxy this session runs behind, which refuses write traffic to the
GitHub API paths involved:

| Attempted call                                         | Result                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `PATCH /repos/jamalbalya/aibrowseragent`               | `403` — _"Repository settings writes are not permitted through this proxy."_          |
| `DELETE /repos/jamalbalya/aibrowseragent/git/refs/...` | `403` — _"Write access to this GitHub API path is not permitted through this proxy."_ |

Pushing commits is unaffected and continues to work, so this is a restriction
on repository administration specifically, not on the credential's rights.

1. **Set the default branch to `main`.** Blocked as above. It has to happen
   first regardless, because GitHub refuses to delete a branch while it is the
   default.
2. **Delete `claude/dreamy-shannon-tu0z6h`.** Blocked today as a consequence
   of step 1, not independently: deleting a ref over `git push` is _not_
   refused by the proxy (a probe against a non-existent ref returned GitHub's
   own "remote ref does not exist", not a 403), so once the default branch
   moves, the deletion below should succeed from anywhere with push access.

### How to finish it

In the GitHub web UI, from any ordinary network:

1. **Settings → General → Default branch**, switch it to `main`.
2. **Branches**, delete `claude/dreamy-shannon-tu0z6h`.

Or from a shell outside this proxy, authenticated as `jamalbalya`:

```bash
gh repo edit jamalbalya/aibrowseragent --default-branch main
git push origin --delete claude/dreamy-shannon-tu0z6h
```

Afterwards, confirm the repository reports `"default_branch": "main"` and that
`main` is the only branch. Deleting the old branch loses nothing: it is a
strict ancestor of `main`, verified with

```bash
git rev-list --count origin/main..origin/claude/dreamy-shannon-tu0z6h   # 0
```

Once both steps are done, delete this file — it documents a problem that will
no longer exist, and it is the only place in the repository that still names
the obsolete branch.

### Note for future sessions

An automation harness may instruct a session to develop on a branch whose name
it generates. When that name carries an assistant name, it conflicts with this
project's ownership rules. Push the work, then land it on `main` and remove the
generated branch rather than leaving it as the project's branch.
