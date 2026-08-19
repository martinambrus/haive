# Fix: phantom worker-restart orphans under GLOBAL_PAUSE, and fan-out Resume that cannot clear them

## Context

Task `977e1c5a-0c36-4962-ad30-b9e747bbbfe2`, step `09_5-skill-generation`, is stuck: clicking
"Re-run 5 failed terminals" fires a `step.resume` event (`retriedAgents: 5`) and the step
re-fails ~0.5 s later with `cli invocation failed: CLI invocation orphaned by a worker restart
(worker exited mid-run)`. The 5 mining rows still carry `user_retry_requested_at`, proving
`resolveAgentMiningPhase` was never reached.

Two independent defects, established from the DB and worker log:

**1. GLOBAL_PAUSE turns every worker restart into phantom orphans.**
`reconcileOrphanedSteps` (`packages/worker/src/queues/task-queue.ts:2162`) ends *every*
invocation of a `waiting_cli` step where `ended_at IS NULL AND superseded_at IS NULL`, with no
`started_at` filter. Under GLOBAL_PAUSE, `enforcePauseGate` holds every invocation at
`started_at IS NULL` by design, so those rows are guaranteed to exist. Three tsx restarts inside
40 s (triggered by editing `shared/src/config/config.service.ts`) stamped
"orphaned by a worker restart" on three runs that never started:

```
7ac0d5e6  created 12:25:02  started NULL  ended 12:34:57  orphan
ff866b97  created 12:34:57  started NULL  ended 12:35:16  orphan
94927058  created 12:35:16  started NULL  ended 12:35:33  orphan  (not superseded)
c8ab787b  created 12:02:29  started 12:21  exit 0                 (resets the chain)
```

`countTrailingOrphans` (`step-runner.ts:2855`) counted 3, `MAX_ORPHAN_REDISPATCH` is 3, so
`3 < 3` was false and the step failed. The budget was spent by runs that never happened.

The rest of the codebase already treats `started_at IS NOT NULL` as the "actually running"
invariant — `enforceTaskAgentCap` (`queues/cli-exec/handlers.ts:829`) and
`foldOrphanedCliParkOnBoot`'s NOT EXISTS guard (`queues/cli-park-timing.ts:201`) both key on it.
The reconciler is the one place that does not.

**2. The fan-out arm of Resume never supersedes the invocation blocking it.**
`resolveLlmPhase` runs before `resolveAgentMiningPhase` (`step-runner.ts:1751` then `:1769`).
The loop arm of resume supersedes the failed pass's invocation
(`packages/api/src/routes/tasks/steps.ts:770`); the fan-out arm (`:679`) returns before that
code, so it only marks the mining rows. The next advance re-reads the un-superseded orphan row,
finds the orphan budget spent, and fails the step at `step-runner.ts:602`. A human re-run cannot
clear its own blocker.

Intended outcome: a paused stack survives worker restarts without inventing orphans, and the
fan-out Re-run button recovers a step instead of re-failing it.

## Rollback

All three changes are code-only — no schema change, no migration, no data edit. Rollback is
`git revert` of the commit plus a worker + api restart. No forward-only step.

## Changes

### 1a. Reconciler must not orphan runs that never started

`packages/worker/src/queues/task-queue.ts`, the update at `:2162` inside `reconcileOrphanedSteps`
pass 1: add `isNotNull(schema.cliInvocations.startedAt)` to the `where`. `isNotNull` is already
imported (`:5`).

Rationale to record in the comment: a `started_at IS NULL` invocation spawned no container, so
the boot-time `reapAllCliSandboxes` did not kill anything of its; its BullMQ job survives the
restart in Redis (delayed by the pause gate, or waiting/prioritized), and `handleCliExecJob:118`
already no-ops a redelivered job whose row was finalized. Ending it instead both burns the
orphan budget and discards queued work the queue would still have run.

Known residual (pre-existing, out of scope): `startCliExecWorker()` runs at
`packages/worker/src/index.ts:81`, before `reconcileOrphanedSteps` at `:101`, so an invocation
picked up in that window can set `started_at` and then be marked orphaned. Unchanged by this fix.

### 1b. `countTrailingOrphans` stops at a never-started row

`packages/worker/src/step-engine/step-runner.ts:2855`: add `startedAt` to the selected columns
and `break` on a row with `startedAt == null`, before the `isTransientCliFailure` test.

This is the same invariant as 1a applied to the reading side, and it is what heals rows already
written — including this task's three, which no data migration then has to touch. `break` rather
than skip: the cap exists to converge a crash-looping worker, a never-started row is no evidence
of a crash, and the lenient reading costs at most one extra re-dispatch.

With 1b alone the stuck step already recovers through the existing orphan re-dispatch path
(`step-runner.ts:511`). Change 2 is still required so Resume does not depend on that path.

### 2. Fan-out resume arm supersedes its trailing failed invocation

`packages/api/src/routes/tasks/steps.ts`, inside the `db.transaction` at `:676` (alongside the
`userRetryRequestedAt` update at `:679`, so marker and supersede are atomic):

- `tx.select()` the latest invocation for `step.id` with `superseded_at IS NULL`,
  `consumed_at IS NULL`, `mode <> 'agent_mining'`, ordered `created_at desc limit 1` — the same
  predicate `resolveLlmPhase` reads at `step-runner.ts:461`.
- Supersede it by id **only if** it is ended and failed (`exit_code IS NULL`, `exit_code <> 0`,
  or a non-empty `error_message`) — the same failure test as `step-runner.ts:481`.

Deliberately narrower than the loop arm's blanket supersede: the fan-out arm can target a
DEGRADED (`done`) step whose trailing invocation succeeded and is not yet consumed, and
superseding that would discard good output and buy a fresh CLI call for nothing. `agent_mining`
rows are excluded for the same reason — the mining results live in `task_step_agent_minings`
and `retryMiningAgents` reads `cli_invocation_id` off them.

### 3. Tests

- `packages/worker/test/step-runner-llm.test.ts` (existing mock-db harness, already covers the
  orphan re-dispatch path): add a case where the trailing invocations are transient-failed with
  `startedAt: null` and assert the step re-dispatches instead of failing.
- New test for `reconcileOrphanedSteps` — it currently has none. Fake-tx style, as in
  `packages/api/test/cancel-task.test.ts`: assert the update's `where` carries the
  `started_at IS NOT NULL` term.
- `packages/api/test/` — new fake-tx test for the fan-out resume arm: a failed trailing
  invocation is superseded, a succeeded/unconsumed one is not, an `agent_mining` row is never
  touched.

## Verification

Deploying needs a worker restart (task-queue.ts, step-runner.ts) and an api restart (steps.ts).
GLOBAL_PAUSE is currently on; confirm the drain predicate is zero before restarting
(`started_at IS NOT NULL AND ended_at IS NULL AND superseded_at IS NULL`, plus no
`haive-cli-*` containers). Leave the pause on afterwards.

Do not click Re-run on task `977e1c5a` before deploying — each click currently just re-fails the
step, and that task is the fixture for check 3.

1. `pnpm test` in the worker and api containers (per-container, node_modules are not shared).

2. **Fix 1, live, no CLI spend.** With pause still on, snapshot
   `select count(*) from cli_invocations where started_at is null and ended_at is null and superseded_at is null;`
   restart the worker, re-run it. Before the fix those rows all end with an orphan message;
   after it the count is unchanged and no new "orphaned by a worker restart" text appears on
   them. Tasks `1c128654`, `3da4a8df`, `75122651` currently hold queued fan-out invocations and
   serve as the sample.

3. **Fix 2 + 1b, live, no CLI spend.** On task `977e1c5a`, click "Re-run 5 failed terminals"
   once. Expect: step `09_5-skill-generation` leaves `failed` for `waiting_cli`, its
   `error_message` clears, `94927058` gains a `superseded_at`, and one new `cli_invocations` row
   appears with `started_at NULL` (the pause gate defers it, so nothing is bought). The 5 mining
   retries do **not** fire on this advance — `user_retry_requested_at` stays set until that loop
   pass completes and the advance reaches `resolveAgentMiningPhase`. That is correct: the step is
   mid-loop, and the marker is honoured on the next advance.

**Re-running the whole task is not a sufficient check**, and is the reason to avoid it: neither
defect reproduces on a healthy run. Fix 1 needs pause on plus a worker restart while an
invocation sits queued; fix 2 needs a fan-out step with failed mining rows plus a trailing failed
non-mining invocation. A clean re-run produces neither, spends real CLI budget, and destroys the
one fixture that does reproduce the bug. Use it afterwards as a regression check that nothing
else broke, not as the proof these fixes work.
