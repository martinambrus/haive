---
name: pr-watch-read-ci-field
description: 'After every PR watcher run, read its ci= field (bad[...]) before replying to Codex or merging — a red smoke went unnoticed for 4 pushes on #472'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 3813bbf6-9261-4b06-870d-404ed90866bb
  modified: 2026-10-10T14:54:43.469Z
---

On 2026-10-10, PR #472's `End-to-end smokes` job was red on four consecutive pushes (b42bf576 through 7d1c6674). The watcher (`.claude/tmp/backlog/pr_watch.sh`) printed `ci=9runs/0pending/bad[End-to-end smokes=failure]` each time. I only read the Codex comments and kept replying and pushing. The failure was a smoke fixture that a review-round fix had made invalid (an upgrade revival refused on a never-onboarded repository).

**Why:** the review loop gates on CI as much as on Codex, and a red check that nobody reads leaks into four more rounds of work built on a broken head.

**How to apply:**

- Every time a watcher ends, read the last `codex=… ci=…` line first.
- A non-empty `bad[...]` means: stop replying to review threads, pull the failed job's log with `gh run view <id> --log-failed`, and fix the failure before the next push.
- When a job fails early, the job's later steps (for example the worker smokes after the api smokes) did not run. Treat them as unverified, not green.

Related: [[haive-pr-workflow]], [[gh-run-watch-exit-status-lies]].
