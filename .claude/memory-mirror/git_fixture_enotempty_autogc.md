---
name: git-fixture-enotempty-autogc
description: 'A test fixture that git-commits and is then removed with rm(recursive) can fail ENOTEMPTY on .git/objects/pack — detached `git gc --auto` outlives the awaited call. Set gc.auto=0 repo-locally in any new git fixture'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-21T14:24:19.860Z
---

**`git gc --auto` DETACHES by default, so it keeps writing `.git/objects/pack` after the `execFile`
you awaited has resolved.** A fixture that commits and is then torn down by
`rm(dir, { recursive: true, force: true })` therefore walks a tree something is still filling, and
`rmdir` fails `ENOTEMPTY` — even though the remove options are already correct.

MEASURED on CI run `35607941673`, main at `b4784be4`, 2026-09-21:

```
FAIL src/plan/merge.test.ts > landPlanMerge > refuses rather than resetting when the checkout moved underneath
Error: ENOTEMPTY: directory not empty, rmdir '/tmp/planmerge-local-7TkHPI/.git/objects/pack'
Tests  1 failed | 4848 passed | 5 skipped (4854)
```

It took main red on a commit whose entire content was **two markdown files under `docs/plans`**. The
same job had passed on that identical content 20 min earlier as a `pull_request` run, and rerunning
the job on the **identical sha passed** — which is what proves non-determinism by experiment rather
than by argument. Nothing in `packages/worker` set `gc.auto` or `gc.autoDetach`, so nothing suppressed
it.

**Fixed in #190 (`19165ffa`), two halves, because only one of them rests on a proven cause:**

- **Prevention:** `gc.auto=0` set REPO-LOCALLY by one `quietGit` helper, called after each fixture's
  `git init` AND after `git clone` — a clone makes its own `.git` and inherits no config from the
  remote, so it needs its own call.
- **Tolerance:** the `afterEach` retries on `ENOTEMPTY`, mirroring `removeDirContents` in
  `@haive/shared/fs-safe` for the same errno (a few passes cover a concurrent writer while still
  terminating on a directory something is actively filling). This half is there because auto-gc is the
  LIKELIEST writer, not a proven one.

**Why repo-local rather than an env var, since both would work.** `gitRun` (`repo/git-push.ts:17`)
spreads `{ ...process.env, ...env }` when given an env and passes only `{ cwd }` otherwise, so
`GIT_CONFIG_*` would in fact reach it. Repo-local is chosen for SCOPE: it covers every git process
touching those trees — including the ones production code spawns through `gitRun` for `worktree prune`
and `worktree remove --force` — without changing git's behaviour for any other suite, and it survives a
future helper that builds a fresh env.

**How to apply.** Any new test fixture that runs `git init` or `git clone` and is torn down by a
recursive remove should disable auto-gc the same way; one shared helper beats three inline `git config`
calls, because a fourth fixture repo will otherwise skip it silently. And if you see `ENOTEMPTY` on a
`.git` path in CI, this is it — rerun the job on the same sha to confirm non-determinism rather than
investigating your own diff, exactly as [[container-cleanup-smoke-races-cancel]] prescribes for the
other known test race.

**What is NOT proven:** that the race is closed. Four consecutive local runs came back 10/10 green and
CI is green on `19165ffa`, but the failure never reproduced locally, so there is no red-to-green
transition to point at and those passes are consistent with both states. The evidence is structural.

Related: [[ci-cancelled-run-is-not-red]] for the other case where main's CI looks like your problem and
is not, and [[rtk-docker-logs-summarized]] — reading this test's verdict needed vitest's JSON reporter,
because the wrapped stdout answered `[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed`.
