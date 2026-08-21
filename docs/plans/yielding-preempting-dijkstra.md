# Vote-driven agent-slot preemption

> Supersedes the vote-scoring plan previously at this path; that one shipped as `c4d9acb` and its
> durable copy is committed at `docs/plans/valiant-dancing-parrot.md`. Archive THIS plan under a
> new slug when it lands.

## Context

Vote scoring shipped and orders the queue correctly, but a vote cannot take a slot that is
already occupied. Observed live: task `aba4d722` (score 2) held the queue's lowest priority
number (`4003`) — ahead of a running score-0 job at `6003` — and still could not run, because the
two agent slots were taken first-come by jobs enqueued moments earlier. Its jobs sat in
`prioritized`, not `delayed`, proving no gate deferred them; they were purely waiting for a slot.

The runtime-holder reserve is not involved (all three contending tasks held a live DDEV, and
`agentReserveDecision` returns `allow` whenever `holdsRunner` is true). The binding constraint is
2 agent slots — host 15630 MB, budget ~10941, three browser-phase DDEVs at 3072 each = 9216
committed, `floor(1725/2048) = 0` fit, so `agentFloor` 2 wins.

So the only thing that changes the outcome is **preemption**: a running CLI on a lower-scored task
yields its slot. Decided: agent slots only — DDEV runners are never torn down. Guards: a minimum
victim run age and an admin kill-switch. No score-gap threshold and no per-victim eviction cap.

**Accepted cost:** the preempted round's tokens and partial work are lost. **Accepted risk:**
without an eviction cap, a permanently low-scored task can be preempted more than once, so the
no-starvation property the band design was built around no longer holds unconditionally.

## Mechanism — reuse the existing transient-recovery path

The codebase already recovers killed CLI work end to end, and preemption is exactly that shape:

1. Sweeper marks the victim invocation as preempted, then force-removes only its container.
2. `runInSandbox` returns exit 137/null; `interpretCliFailure` (`exec-core.ts:100`) stamps a
   preemption headline instead of the generic "stopped before it finished", mirroring how a budget
   kill stamps `CLI_TIMEOUT_HEADLINE` (`exec-core.ts:954`).
3. The row is left **ended but NOT superseded**, so `resumeStepIfLinked` advances the step.
4. `resolveLlmPhase` (`step-runner.ts:485`) classifies it transient and **re-dispatches a fresh
   invocation** — machinery that already exists, is tested, and needs no new recovery code.

So the new code is only: pick a victim, kill it, label the failure, and keep that label out of the
retry budgets.

## The correctness tax — preemption must never fail the victim

`isTransientCliFailure` already returns true for exit 137, so re-dispatch works for free. But every
transient counter would also count it, and `MAX_ORPHAN_REDISPATCH = 3` means a task preempted three
times **fails** — silently converting "deprioritized" into "broken". That is worse than today's
behaviour and is the main thing this plan has to get right.

Add `CLI_PREEMPTED_HEADLINE` + `isCliPreemptionFailure` to
`packages/worker/src/queues/cli-exec/failure-class.ts` (same "stable internal contract we own
end-to-end" convention as `CLI_TIMEOUT_HEADLINE`), keep it inside `TRANSIENT_CLI_FAILURE_RE`, then
make every budget **skip and continue** on a preemption row — never count it, never let it reset
the chain (a reset would hide a real crash loop behind repeated preemptions):

- `countTrailingOrphans`, `countTrailingTimeouts`, `countTrailingCapabilityFailures`
  (`step-runner.ts` ~2622-2690)
- mining `attempts` — do not increment in `retryMiningAgents` when the prior failure was a
  preemption (`MAX_MINING_ORPHAN_REDISPATCH`)
- DAG `infra_retries` / `review_infra_retries` — same, so preemption cannot reach
  `DAG_INFRA_EXHAUSTED`

## The sweeper

New `packages/worker/src/sandbox/agent-preemption.ts`, structured like
`queues/cli-exec/agent-reserve.ts`: a **pure `preemptionDecision()`** split from the docker/redis/db
I/O so the rule is directly testable, plus a periodic class mirroring `RuntimeRunnerReaper`
(`runtime-runner-reaper.ts`), started at worker boot on a ~30s interval.

Per tick, **at most one preemption**:

1. Queued demand from the cli-exec queue, states `['waiting', 'prioritized']` — the same
   both-states rule `agent-reserve.ts` documents; a `delayed` job is parked by a gate and must not
   trigger an eviction.
2. Running invocations (`started_at` set, `ended_at`/`superseded_at` null) joined to
   `tasks.vote_score`.
3. Preempt only when a queued task's score is strictly greater than a running task's score.
4. **Victim = lowest score; tie-break to the YOUNGEST eligible run**, because it destroys the least
   work. Skip anything younger than `minRunAgeMinutes`.
5. **Skip if the booster would be deferred anyway.** Reuse `agentReserveDecision` /
   `runnerHoldingTaskIds()` (`runtime-admission.ts:191`): if the runtime-holder reserve would hold
   the booster's job at pickup, the freed slot would not go to it and the work would be destroyed
   for nothing.

Preempt = write a Redis marker `cli-preempt:<invocationId>` (short TTL, read by
`interpretCliFailure`), then `docker rm -f` filtered on a **new `haive.invocation.id` label**.
Today `docker-runner.ts:311` names containers `haive-cli-${randomUUID()}` and labels only
`haive.task.id`, so there is no way to kill exactly one invocation — adding the label via the
existing generic `opts.labels` mechanism is what makes preemption surgical instead of killing a
task's whole fan-out.

Also append a `task.preempted` event (`appendTaskEvent` equivalent) so an eviction is auditable
rather than looking like a random CLI death.

## Config

Two keys in `packages/shared/src/config/config.service.ts`, both on the admin "Runtime resource
limits" card with GET/PUT in `packages/api/src/routes/admin.ts` (every global needs an admin
control):

- `AGENT_PREEMPTION_ENABLED` — default **true** (the requested behaviour), off = today's
  first-come.
- `AGENT_PREEMPTION_MIN_RUN_MINUTES` — default **5**. The trade: lower reacts faster but destroys
  more short runs; higher lets brief runs finish on their own while the booster waits longer.

## Rollback

1. `AGENT_PREEMPTION_ENABLED=false` — no deploy, no restart; the sweeper becomes a no-op.
2. Revert the code. The `haive.invocation.id` label and the preemption headline are inert without
   the sweeper, and the budget exclusions are no-ops when no row ever carries the headline.

Additive only. Nothing is dropped or migrated, so there is no destructive phase.

## Live-stack procedure

Worker `src` changes plus a `@haive/shared` config key, so this needs the drained window
([[project_worker_edit_window_queue_pause]]) — and note `dev.sh libs` itself reloads the worker and
reaps in-flight CLIs, so it belongs inside the window, not before it:

1. `redis-cli SET config:orchestrator:globalPause true`
2. Drain: no `cli_invocations` with `started_at` set and `ended_at`/`superseded_at` null, no
   `haive-cli-*` container, no `task_steps.status='running'`.
3. Edit → `dev.sh libs` → restart worker + api → verify → **`globalPause false`**.

No DB migration this time, so the migrate-before-libs ordering does not apply.

## Verification

1. **Unit** — `preemptionDecision` table: no queued demand → none; equal scores → none; victim
   younger than the guard → none; booster the reserve would defer → none; two eligible victims →
   the younger one. Plus `failure-class` tests: preemption headline is transient, is NOT a timeout
   (`isCliTimeoutFailure` must stay false or the timeout ladder escalates on evictions).
2. **Budget-exclusion tests** — a step with 5 consecutive preemption rows still re-dispatches;
   preemption interleaved with real orphans still fails at 3 genuine orphans.
3. **Typecheck per container** + full suites (worker/api/web/shared).
4. **Live** — recreate today's shape: three DDEV-holding tasks, two slots, upvote the starved one.
   Expect exactly one eviction, the booster starting within a tick, the victim's invocation reading
   the preemption headline, and the victim re-dispatching rather than failing. Confirm all three
   `haive-ddev-*` containers survive.
5. **Kill-switch** — flip `AGENT_PREEMPTION_ENABLED` off and confirm the sweeper stops evicting
   without a restart.
6. **Starvation watch** — with the eviction cap deliberately absent, watch the victim across a few
   ticks and confirm it re-enters behind the booster's queue and eventually runs, rather than being
   evicted repeatedly.

---

# Amendment — 2026-08-21: shipped

Landed as `19bf74e` (`feat(worker): let an up-voted task preempt a lower-voted running agent`). This file is a historical record, not pending work — do not
re-implement from it. Line numbers in the body are as of writing and have since drifted; resolve
any reference by symbol name.

The header instruction "Archive THIS plan under a new slug when it lands" has already been carried
out — this path IS the archive. Nothing further is owed.
