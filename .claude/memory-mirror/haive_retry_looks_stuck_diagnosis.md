---
name: haive-retry-looks-stuck-diagnosis
description: "A step that looks stuck after a Retry: a pending row plus 'progress update failed (non-fatal)' every 2.5 s means the OLD pass is still running behind it; queue keys are bull:haive-<name>, not bull:task-queue"
metadata:
  node_type: memory
  type: reference
  originSessionId: a644756a-a3e2-4e31-883e-4ea8e833a31b
  modified: 2026-10-03T14:45:59.412Z
---

A task `running` on a step row that is `pending` with `started_at` and `waiting_started_at` both NULL, and an
empty `status_message`, is a Retry waiting behind an OLD pass of that step. MEASURED 2026-10-03 on task
fdd57e6b, step `01c-ddev-env`: Retry at 14:19:50, the new pass started 14:26:27 (6.5 min), and the UI showed
nothing the whole time.

**Evidence recipe** (all read-only):

- worker log: `progress update failed (non-fatal)` with `StepSupersededError` (`step-ownership.ts:65`, via
  `emitProgress`) repeating every ~2.5 s. Its first line is the Retry; the old pass is heartbeating onto a row
  the Retry reset, so the UI cannot show its progress. `grep -c` it for the cadence.
- the new pass starts only after `step pass superseded by a retry or skip` and `step pass superseded; nothing to
hand off` (a step's advances run one at a time, `worker-restarts.md`).
- for DDEV the old pass sits in `ddev start` inside the per-task runner (`blank-ddev-<task8>`, nested dockerd):
  `docker top <runner>` shows it. The first start on a fresh install pulls images first (the step's own progress
  line reads `... Downloading 114.3MB`), and DDEV only validates `.ddev/config.yaml` after that, so a bad config
  fails ~10 min in, then again in seconds on the retry.

**Do not read the queue with `bull:task-queue:*`.** The keys are `bull:haive-task:*` (also `haive-cli-exec`,
`haive-repo`, ...); a wrong name answers 0 and reads as an idle queue. `redis-cli --scan --pattern '*:id'` lists
the real names. `active` empty with a heartbeating pass means the pass runs without a live job: still wait.

**Do not restart the worker to unstick it.** The old pass ends on its own when its exec returns; a restart
orphans the runner and every other live job ([[haive-host-build-restarts-worker]]). The related generated-file
trap is in the found-not-fixed list (task a644756a #17): a `.ddev/config.yaml` that 01c wrote on a first run
is kept on a re-run; delete the untracked file, then Retry 01c.

Related: [[claude-config-notice-is-noise]], [[found-not-fixed-running-list]].
