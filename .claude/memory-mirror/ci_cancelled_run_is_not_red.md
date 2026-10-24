---
name: ci-cancelled-run-is-not-red
description: 'A main CI run with conclusion `cancelled` was superseded by a later merge on the same ref — cancel-in-progress killed it. The verdict rolls onto the superseding sha; the watcher still reports it as a failure'
metadata:
  node_type: memory
  type: project
  originSessionId: e62dac9c-0a5b-41ca-8f3f-eaec5bb75d8c
  modified: 2026-09-20T08:14:54.631Z
---

**`.github/workflows/ci.yml:22-24` sets `concurrency: group: ci-${{ github.ref }}` with
`cancel-in-progress: true`.** So a merge to main starts a run that KILLS any run still in flight on
the same ref. On a busy day — several sessions landing PRs minutes apart — a perfectly good main run
is cancelled routinely, and it is not a failure.

**The trap: `watch-sha.sh` reports it as one.** Its verdict counts any conclusion that is not
`success` or `skipped` as unsuccessful, so `cancelled` exits 1 exactly like `failure`. The
notification then says "failed with exit code 1" and invites a full investigation of your own diff.

MEASURED twice:

- 2026-09-20, `2e399831` (PR #179). Run `35496616581` conclusion `cancelled`; **End-to-end smokes
  SUCCEEDED** on it and only Playwright showed `cancelled`. #180 merged as `10d8e572` at 07:24:25Z,
  3m38s after mine at 07:20:47Z. That run (`35496779528`) passed all five jobs plus both CodeQL
  analyses, and `2e399831` IS an ancestor of `10d8e572`, so it answered for my content.
- Earlier, `db0f3af1` (PR #126) was cancelled the same way by a merge 2.5 min later; the verdict
  rolled onto `4512b64a`, which had it as an ancestor. Only the job that finished first, schema
  parity, had reported.

**How to apply.** On a `cancelled` main run, before suspecting anything:

1. Read the JOB breakdown in the dump. A cancelled run usually has most jobs `success` and one or two
   `cancelled` mid-flight — and if the job that exercises your change is among the successes, your
   change is already cleared by the artefact rather than by argument.
2. `git fetch origin main` and check whether main moved past your merge
   (`git rev-list --count <mysha>..origin/main`). A non-zero count plus a later run is the cause.
3. Confirm the successor covers you: `git merge-base --is-ancestor <mysha> <newer sha>`. Only then
   does the newer run's verdict answer for your content.
4. Watch the SUPERSEDING sha. Do not re-run the cancelled one — it will be cancelled again by the
   next merge, and it proves nothing the successor does not.

**Pass the watcher a FULL sha.** It keys on the full form deliberately, so an abbreviated one may
match no runs and sit until its deadline reporting nothing. I made that mistake once here and had to
`TaskStop` the stray task so its dump could not later be mistaken for a verdict.

Related: [[gh-run-watch-exit-status-lies]] — the same lesson from the other direction, that an exit
code is never the verdict and the dump has to name the full sha on both its header and completion
lines.
