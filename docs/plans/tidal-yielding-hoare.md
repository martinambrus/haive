# Vote scoring for the runtime (DDEV) pool

> Third plan at this path. The two before it shipped (`c4d9acb` vote scoring, `19bf74e` agent
> preemption) and are archived at `docs/plans/valiant-dancing-parrot.md` and
> `docs/plans/yielding-preempting-dijkstra.md`. Archive this one under a new slug when it lands.

## Context

Votes currently govern one pool: cli-exec agent slots. Observed live — a score-1 task never ran
while a score-0 task did, and the reason was not the agent queue at all:

```
step 07b-phase-4-validate (task 38f02dee, score 1) → pending, since 10:09:36
"Waiting for a free runtime slot — #1 of 1 waiting (9216 MB of 10941 MB in use, needs 3072)"
worker: "runtime admission: parked step (pool full, no free capacity)"
```

It had **0 running and 0 queued** cli-exec invocations and no DDEV container. Three runners
(3072 MB each = 1536 base + 1536 browser surcharge, all three in validate/review phases) held
9216 MB of a 10941 MB budget. The score-0 task held one of them, so it could queue agent work and
compete where votes apply; the score-1 task could not get a runner, so its score was never
consulted.

The effective rule today is **holding a DDEV is a prerequisite for a vote to matter at all**. This
extends votes to the runtime pool so that stops being true.

Two halves are needed, and only the second fixes the observed case — nothing was going to free on
its own, because `pickPreemptibleRunner` today reclaims only dead/orphan or paused-and-settled
runners and never a live task's.

## Slice A — score-order the runtime park queue

`joinParkQueue` (`packages/worker/src/sandbox/runtime-admission.ts:361`) is a Redis ZSET scored by
`Date.now()` with `zadd NX`, i.e. FIFO. Replace the score with the same band trick the cli-exec
priority uses:

```
parkScore = (TASK_VOTE_MAX - clampVoteScore(vote)) * PARK_SCORE_BAND + joinedMs
PARK_SCORE_BAND = 1e13      // max ≈ 1.0e14, exact in a Redis double (< 2^53 ≈ 9.0e15)
```

- New hash `haive:runtime-park-joined`, written with **HSETNX**, holds the original join time so a
  re-poll (every ~15s) keeps FIFO *within* a score band instead of resetting it. The ZADD itself
  drops `NX` so a vote cast while parked re-orders on the next poll — the whole point.
- `joinParkQueue` takes the score; `runtimeAdmission` reads `tasks.vote_score` alongside the weight
  lookup it already does. Reuse `clampVoteScore` / `TASK_VOTE_MAX` from `@haive/shared/fair-priority`.
- Clear the new hash in `leaveParkQueue` and in the existing dead-ticket sweep, next to
  `PARK_WEIGHT_KEY`.

At all-zero scores every entry shifts by the same constant, so the order is byte-identical to
today's FIFO — the same no-op-until-voted property vote scoring shipped with.

## Slice B — a score tier in `pickPreemptibleRunner`

`packages/worker/src/sandbox/runtime-runner-reaper.ts` already has the shape: two tiers, tier 2
consulted only when tier 1 is empty, and a `settled` flag (no live CLI invocation, from
`hasLiveCliInvocation` in `orchestrator/pause.ts`) that stops it tearing down an environment a
run is still using.

Add **tier 3**, consulted only when 1 and 2 are empty: runners whose task's `voteScore` is
strictly below the waiter's **and** which are `settled`. Lowest score first, then longest-running
(the opposite tie-break to agent preemption — there the youngest victim loses the least work; here
the longest-lived runner is the most likely to be idle).

- `ReaperTask` gains `voteScore`; `settled` must now be computed for tier-3 candidates too, not
  only paused ones.
- `reclaimer` (`runtime-admission.ts:83`, `setRuntimeReclaimer`) becomes
  `(waiterScore: number) => Promise<boolean>`; the `runtimeAdmission` call site passes the parked
  task's score.
- The end-of-`reclaimOnePreemptible` TOCTOU re-check currently vetoes anything not terminal and not
  paused — it must accept a tier-3 pick (re-read the score and re-confirm `settled`).

**`settled` is non-negotiable.** Killing a DDEV under a running agent leaves that agent executing
against a dead environment; it would fail in a way no budget exclusion can classify, which is
strictly worse than waiting.

## How the two sweepers compose (and the escape hatch)

The settled window is normally created by the agent-preemption sweeper that already shipped: it
evicts the low-scored task's agent (budget-free, re-dispatches cleanly), and in the gap before the
victim's next agent starts, the runtime reclaimer can take its runner. The victim's step then finds
no runner and re-parks on the gate — now *behind* the booster in score order.

That only fires when a higher-scored task has queued **agent** demand. When it does not, the
low-scored holder never becomes settled and the runtime waiter still waits. Escape hatch, so it
converges unconditionally: after `RUNTIME_PREEMPTION_MAX_WAIT_MINUTES` parked, the runtime
reclaimer preempts the holder's **agent** itself (reusing `markPreempted` + the
`haive.invocation.id` kill from `agent-preemption.ts`), which creates the settled window on the
next pass.

## Config

Both on the admin "Runtime resource limits" card with GET/PUT in `routes/admin.ts`:

- `RUNTIME_PREEMPTION_ENABLED` — default **true**. Off = tiers 1-2 only (today's behaviour).
  Gates slice B only; slice A's ordering is harmless and follows the vote data itself.
- `RUNTIME_PREEMPTION_MAX_WAIT_MINUTES` — default **10**. `0` disables the escape hatch, leaving
  tier 3 dependent on a naturally-occurring settled window.

## Rollback

1. `RUNTIME_PREEMPTION_ENABLED=false` — no deploy; tier 3 and the escape hatch stop.
2. `UPDATE tasks SET vote_score = 0;` — neutralises slice A's ordering too (every band collapses to
   the constant offset = FIFO).
3. Revert the code. The new Redis hash is inert without the reader and expires with its tickets.

Additive only; no migration.

## Live-stack procedure

Worker `src` plus new `@haive/shared` config keys, so it needs the drained window
([[project_worker_edit_window_queue_pause]]) — and `dev.sh libs` itself reloads the worker and
reaps in-flight CLIs, so it belongs inside the window:

1. `redis-cli SET config:orchestrator:globalPause true`
2. Drain: no started-and-unended `cli_invocations`, no `haive-cli-*`, no `task_steps.status='running'`
3. Edit → `dev.sh libs` → restart worker + api → verify → **`globalPause false`**

## Verification

1. **Unit — park score.** All-zero scores reproduce FIFO exactly; a higher vote sorts ahead of an
   earlier join; within a band the earlier join still wins; the max composite is under 2^53 so the
   ZSET double is exact.
2. **Unit — tier 3.** Never picks an equal-or-higher-scored runner; never picks an unsettled one;
   tiers 1 and 2 still win when non-empty; lowest score then longest-running among ties. Existing
   `runtime-runner-reaper.test.ts` covers tiers 1-2 and must stay green.
3. **Typecheck per container** + full suites (worker/api/web/shared).
4. **Live — the observed shape.** Three DDEV holders filling the budget, one higher-scored task
   parked on the gate. Expect: the parked task's `status_message` position improves as soon as it
   outscores a waiter; then either a natural settled window or the escape hatch frees a runner, and
   it boots. Confirm the victim re-parks rather than failing, and that no DDEV is torn down while
   its task has a live CLI invocation (`hasLiveCliInvocation` must be false on every tier-3 reap —
   assert it in the log line).
5. **Kill-switch** — `RUNTIME_PREEMPTION_ENABLED=false` stops tier 3 without a restart.

## Known bounded imperfection

With the escape hatch at its default, a low-scored task can lose both its agent and its runner to a
higher-scored one, then re-queue for both. That is the intended trade, and it is the runtime-pool
counterpart of the no-starvation caveat already accepted for agent preemption.

---

# Amendment — 2026-08-21: shipped

Landed as `8b6b3a9` (`feat(worker): extend vote scoring to the runtime (DDEV) pool`). This file is a historical record, not pending work — do not
re-implement from it. Line numbers in the body are as of writing and have since drifted; resolve
any reference by symbol name.

The header instruction "Archive this one under a new slug when it lands" has already been carried
out — this path IS the archive. Nothing further is owed.
