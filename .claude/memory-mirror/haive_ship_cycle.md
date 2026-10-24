---
name: haive-ship-cycle
description: 'After finishing any Haive feature or fix, offer the whole ship cycle as ONE yes/no question — branch, commit, push, open the PR, watch both greptile and CI'
metadata:
  node_type: memory
  type: feedback
  originSessionId: 55c22883-09a4-4319-87b9-34197d131c73
  modified: 2026-08-21T13:37:18.641Z
---

When a feature or fix in the Haive repo is finished and verified, ask ONE question covering the
whole cycle: **commit into a branch, push it, open a PR, and watch it for the greptile review and
CI?** A plain "yes" then authorises every step end to end, including the plan-archive update where
the work came from a plan in `docs/plans/` (amendment + README status row, as a separate
`docs(plans):` commit after the implementation commit, so it can cite the hash). Requested by the
user on 2026-08-21; on 2026-09-10 the push-to-main step became branch-push-PR and the watch gained
a SECOND thing to wait for — the greptile peer review, which is the reason the PR exists at all
(see [[haive-pr-workflow]]).

**Why:** asking about each step separately made the user re-type the same instruction, or answer
three questions where one would do. The steps are never wanted individually — a commit that is not
pushed and watched is an unfinished ship.

**How to apply:** finish and verify the work first, then ask the single question. On "yes":
`git commit` (see [[haive-pr-workflow]] for the branch-and-PR rule and commit hygiene), push the
branch, open the PR, then wait for BOTH verdicts before reporting the work shipped.

- **CI:** find the run for the pushed sha and poll its `conclusion` — NOT
  `gh run watch --exit-status`, which has been measured exiting 0 on a failed run
  (see [[gh-run-watch-exit-status-lies]]). Filter by workflow name: `gh run list --limit 1`
  returns whichever workflow finished most recently, and it has already reported a CodeQL run's
  success as if it were CI's.
- **greptile:** its findings arrive on the PR, so read them rather than only the check status —
  a review that passes its check can still have said something worth acting on. Which surface it
  posts to has NOT been observed yet (review comments, a check run, or both), so on the first PR
  look at `gh pr view --comments` and `gh pr checks` together, then record what it actually uses.

Report both verdicts. If either fails, investigate rather than reporting and stopping; greptile
findings are review comments, so judge them rather than applying them blindly. Do not push without
asking — the question is the authorisation, and it does not carry to the next piece of work.
