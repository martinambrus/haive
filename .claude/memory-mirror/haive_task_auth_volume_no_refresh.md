---
name: haive-task-auth-volume-no-refresh
description: "Mid-run credential refresh shipped in PR #101; volumes created before it never self-heal, and a task's own copy can be NEWER than the user volume — check before replacing one"
metadata:
  node_type: memory
  type: project
  originSessionId: 7b103635-8824-4e07-9760-f6a4061bf2b8
  modified: 2026-09-14T05:35:31.043Z
---

**Shipped** in PR #101 (merged 2026-09-13, `3c0a93f6`): `ensureTaskAuthVolumes` records a
fingerprint of the SOURCE credential at populate time and recopies when it moves, so a `cli
login` performed mid-task reaches that task. Two things about it are not in the repo:

**A volume populated before that change carries no `.haive-source` record, and an absent record
is deliberately read as FRESH** — that is what let the change deploy without invalidating every
task in flight. Such volumes never self-heal; recovery is removing
`haive_cli_auth_task_<taskid12>_<cli>_<idx>` while the task is idle and letting the next
dispatch re-copy. (The six pre-existing amp volumes were tended to on 2026-09-14 and all now
carry a marker, so this applies only to volumes older than that.)

**Never replace a task copy without comparing it to the source first.** A task's own copy can be
NEWER than the user volume: the in-task CLI rotates its credential, and
`syncRefreshedAuthToUserVolumes` only carries that back at task END. MEASURED 2026-09-14 across
six amp tasks — five copies predated the user volume and were refreshed, but one (`38efef4a`)
was 71 minutes NEWER and its last three runs exited 0, so deleting it would have downgraded a
working credential to an older one. Check two things, not one:

- last invocation outcome per task (`exit_code`), which says whether the copy still WORKS —
  hash-differs-from-source does NOT mean the copy is dead;
- `secrets.json` mtime vs the user volume's, which says whether anything newer would be lost.

Both volumes hold the same SIZE of `secrets.json`, so compare by HASH, never by size.

Diagnosis path for "the summary CLI stopped working": step-summary invocations are the rows with
`summary_for_step_id IS NOT NULL` and `task_step_id IS NULL`; a step with zero CLI invocations
and zero agent minings never enqueues one at all, so "no summary" is not evidence of a failure.

Removing a task volume by hand is safe for the preparations: `clearTaskAuthPreparationState` sits
on the create path, so the rtk seed and MCP config are re-applied rather than skipped.

Related: [[haive-mcp-config-is-per-task-not-per-invocation]] is the other defect in the same
volume, still open.
