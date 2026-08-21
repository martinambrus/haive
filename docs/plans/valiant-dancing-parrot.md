# Task up/down scoring (vote-based prioritisation)

## Context

Today the cli-exec queue round-robins across tasks. `enqueueCliInvocation`
(`packages/worker/src/queues/task-queue.ts:857`) sets
`priority = rank*1000 + userTiebreak`, where `rank` is the count of that task's in-flight
CLI invocations. Because `rank` is per-task, every task's Nth agent shares a band with every
other task's Nth agent — nobody starves, and nobody can be pushed ahead either.

The gap: there is no way to say "this one today". The only lever is pausing every other task
by hand, which is tedious and reversible only by hand.

Classic P1..P5 dropdowns are rejected: they need a shared severity convention nobody agrees on,
and a hard priority class starves the bottom of the list. Instead: a Stack-Overflow-shaped
up/down control whose score shifts **where a task enters the round-robin**, without breaking it.

Two facts from the code that shape the design:

- **Tasks are strictly single-owner.** Every query in `packages/api/src/routes/tasks/index.ts`
  filters `eq(schema.tasks.userId, userId)`. Nobody can see, let alone vote on, another user's
  task. So there is no multi-voter ballot to model — no `task_votes` table, no SUM. The score
  is one integer on the task row.
- **Priority is not frozen after enqueue.** `bullmq@5.73.5` `changePriority-7.lua` runs
  `HSET jobKey priority` unconditionally, and both `promoteDelayedJobs.lua` and `promote-9.lua`
  read it back with `HGET`. So a vote can reprice jobs already sitting in `prioritized`,
  `wait` **and `delayed`**. Only `active` jobs are unaffected — correct, that is no-preemption.

## Design

```
band     = VOTE_BASE + rank - score          // VOTE_BASE = 5, score ∈ [-5, +5]
priority = band * 1000 + userTiebreak        // unchanged tiebreak term
```

`rank ∈ [1,2000]`, `tiebreak ∈ [0,999]` stay exactly as they are.
`band ∈ [1, 2010]` → max priority `2,010,999`.

The ceiling is real and checked: `getPriorityScore.lua` computes
`score = priority * 0x100000000 + counter`, and a Redis ZSET score is a double (53-bit
integers), so `priority` must stay under `2^21 = 2,097,152`. It does.
`band` is never 0 either — priority 0 routes a job to the `wait` list instead of `prioritized`.

Why this shape:

- **No starvation.** The score is bounded and `rank` still climbs, so a boosted task gets `score`
  extra turns per cycle and then yields like everything else.
- **`VOTE_BASE` is what makes it work for serial tasks.** `rank` clamps at 1, so without a base
  offset a 1-agent-at-a-time task could never be boosted — every such task would sit in band 1.
- **`score = 0` reproduces today's order exactly.** Every band shifts by the same constant, and
  ZSET ordering is monotonic in priority. Rollout is behaviourally a no-op until someone votes.
- **The vote offsets `rank` only, never `userTiebreak`.** A user boosting their own tasks can
  pull ahead by at most 5 bands; within a band an overloaded user still sorts last, so cross-user
  fairness survives.
- **±5 is a principled bound, not a taste call.** `MAX_PARALLEL_AGENTS_PER_TASK` defaults to 5,
  so a `+5` task already outranks every neutral task's every agent. Further levels would only let
  the number inflate until it stopped meaning anything.

Votes ride inside the existing `CONFIG_KEYS.FAIR_SCHEDULING_ENABLED` block. **No new config key** —
turning fair scheduling off already means FIFO, and the feature-level off switch is one statement
(see Rollback). Adding a second toggle for the same outcome is the kind of speculative config this
repo avoids.

## Rollback (before the change)

1. Neutralise with no deploy, no restart: `UPDATE tasks SET vote_score = 0;`
   Every band returns to `VOTE_BASE + rank`, i.e. today's order.
2. Revert the code. The column can stay — nothing else reads it and it is inert.
3. Full undo: `ALTER TABLE tasks DROP COLUMN IF EXISTS vote_score;` (no FK, no index, no other
   reader).

Additive-only. No destructive phase, so no two-phase split is needed.

## Slice 0 — open the edit window (do this first)

This touches `@haive/shared`, `@haive/database`, worker, api and web, so it needs a `dev.sh libs`
rebuild plus a worker+api restart — which reaps any in-flight CLI. Procedure per
`project_worker_edit_window_queue_pause` / `project_migrate_before_libs_rebuild`:

1. `docker compose exec -T redis redis-cli SET config:orchestrator:globalPause true`
2. Drain: poll until `cli_invocations` has no row with `ended_at IS NULL AND superseded_at IS NULL`,
   no `task_steps.status = 'running'`, and no `haive-cli-*` container. Confirm the worker log shows
   `task is paused; deferring invocation`.
3. Only then start editing.

Ordering inside the window matters: **schema edit → `push` → `dev.sh libs` → restart**. `dev.sh libs`
hot-swaps the new Drizzle dist into the running worker without a restart, so a `libs` before the
column exists makes every `tasks` row read fail.

## Slice 1 — column

- `packages/database/src/schema/tasks.ts`: add
  `voteScore: integer('vote_score').notNull().default(0)` next to `pausedAt` (line ~316), with a
  docblock in the style of the `pausedAt` comment: a scheduling hint, not state; the scheduler
  clamps defensively so an out-of-range value can never break band math.
- `packages/database/src/migrations/0112_task_vote_score.sql`: idempotent
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "vote_score" integer NOT NULL DEFAULT 0;`
  plus a trailing `-- Rollback:` comment, matching `0108_task_paused_at.sql`.
- No CHECK constraint and no index. The repo's schema uses neither `check()` anywhere today, the
  range is enforced at the single write site, and every listing query is already scoped by
  `user_id` over a few hundred rows.

## Slice 2 — shared band math

New `packages/shared/src/scheduling/fair-priority.ts`, exported as the `./scheduling` subpath in
`packages/shared/package.json` (never via the barrel — see `project_web_shared_barrel_redis_dns`).
Pure and unit-tested, mirroring the `agentReserveDecision` pattern in
`packages/worker/src/queues/cli-exec/agent-reserve.ts:68`:

```ts
export const TASK_VOTE_MIN = -5;
export const TASK_VOTE_MAX = 5;
export function fairPriority(input: { rank: number; tiebreak: number; score: number }): number;
export function repricedPriority(current: number, scoreDelta: number): number;
```

Both worker and api import these, so the enqueue formula and the reprice arithmetic cannot drift.
`repricedPriority` is `current - scoreDelta * 1000` clamped to `[1000, 2010999]` — exact, because
the band clamps never actually bite in the reachable range, so no job payload change is needed to
recover the original `rank`.

Tests (`fair-priority.test.ts`): `score = 0` matches the legacy `rank*1000 + tiebreak`; band never
0 and never over `2^21`; a `+5` serial task outranks a neutral `rank 1` task; reprice of an
enqueued job equals a fresh enqueue at the new score.

Also add to `packages/shared/src/schemas/tasks.ts` (next to `taskActionSchema`, line ~150):
`taskVoteRequestSchema = z.object({ delta: z.union([z.literal(1), z.literal(-1)]) })`.

## Slice 3 — worker: use the score at enqueue

`packages/worker/src/queues/task-queue.ts`:

- Extend `cliBacklogCounts` (line 841) to return `score` via a scalar subquery in the same round
  trip: `(select vote_score from tasks where id = $taskId)`. The aggregate has no `GROUP BY`, so it
  always returns exactly one row and the subquery always evaluates.
- Replace the inline arithmetic at line 874-876 with `fairPriority({ rank, tiebreak, score })`.
- Delete the now-duplicated `FAIR_RANK_MULTIPLIER` / `FAIR_TASK_RANK_MAX` / `FAIR_USER_TIEBREAK_MAX`
  constants, moving the band docblock (line 824-830) into the shared module.
- Keep the existing `try/catch → FIFO` fail-soft exactly as is.

## Slice 4 — api: vote endpoint + reprice + list order

`packages/api/src/routes/tasks/index.ts`:

- New `taskRoutes.post('/:id/vote')`, modelled on the `pause` branch of `/:id/action` (line 909):
  owner-scoped lookup → 404, clamp `task.voteScore + delta` to `[TASK_VOTE_MIN, TASK_VOTE_MAX]`,
  write with `updatedAt`, `appendTaskEvent(db, id, null, 'task.voted', { by: userId, score })`,
  return `{ voteScore }`. A dedicated route rather than a new `taskActionSchema` member: the
  response shape differs and that switch is already long.
- After the write, reprice the task's queued jobs (new helper
  `packages/api/src/lib/reprice-cli-jobs.ts`, mirroring `cancel-task.ts`'s use of the queue from
  `packages/api/src/queues.ts:35`):
  `getCliExecQueue().getJobs(['waiting','prioritized','delayed'], 0, 999)` → filter
  `job.name === 'invoke' && job.data.taskId === id && job.opts.priority` → `job.changePriority({
  priority: repricedPriority(job.opts.priority, delta) })`. **All three states**, per
  `project_bullmq_prioritized_not_waiting`: fair scheduling means jobs land in `prioritized`, not
  `waiting`, and the pickup gates park jobs in `delayed`. Fail-soft per job — a reprice miss only
  delays the boost until that job's next enqueue.
- Listing `orderBy` (line 151): the non-`sort=updated` branch becomes
  `[desc(sql\`case when status in ('completed','cancelled','failed') then 0 else vote_score end\`),
  desc(createdAt)]`. Terminal tasks fall back to date so a completed `+5` cannot pin itself to the
  top forever. The `sort=updated` branch is untouched — that is the notifier's change-detector feed.
- Both endpoints already spread the task row (`...t` at line 265, `...task` at line 627), so
  `voteScore` reaches the client with no further mapping.

## Slice 5 — web

- `packages/web/src/lib/api-client.ts`: add `voteScore: number` to `Task` (line 548).
- New `packages/web/src/components/task-vote.tsx`: `ChevronUp` / score / `ChevronDown` from
  `lucide-react` (already used in the listing), compact vertical stack. Optimistic local override,
  replaced by the value the POST returns; the 3s poll reconciles. Arrows render disabled at the
  clamp edges with a title explaining why. Keeps a local `TASK_VOTE_MIN/MAX` copy — web must not
  import from `@haive/shared` — matching the `WorkflowType` precedent
  (`project_web_local_workflowtype_copy`).
- `packages/web/src/app/(app)/tasks/page.tsx`: render it as the first child of the `TaskRow` flex
  row (line 49). **The row is wrapped in `<Link>`** — the click handler must
  `preventDefault()` + `stopPropagation()` or voting navigates to the task.
- `packages/web/src/app/(app)/tasks/[id]/page.tsx`: same component left of `<h1>{task.title}</h1>`
  (line 1169), inside the non-renaming branch.

## Slice 6 — close the window

`pnpm --filter @haive/database push --force` → `./scripts/dev.sh libs` → restart worker + api →
verify → **`redis-cli SET config:orchestrator:globalPause false`**. Resume is the step that must
not be skipped.

## Verification

1. **Unit** — `pnpm --filter @haive/shared test` covers `fair-priority.test.ts` (the table above).
2. **Typecheck** — per container, per `feedback_typecheck_per_container`:
   `docker exec haive-worker sh -lc 'cd /app/packages/worker && pnpm typecheck'`, same for api and
   web.
3. **No-op proof** — with every score at 0, enqueue a task and read the job's priority from Redis:
   it must equal the legacy value plus exactly `VOTE_BASE * 1000`, and relative order across two
   tasks must be unchanged.
4. **Live reprice** — with the queue paused and ≥2 queued invocations across two tasks, POST a
   vote and re-read `bull:haive-cli-exec:prioritized` with `ZRANGE ... WITHSCORES`: the voted
   task's jobs must have moved ahead. Repeat with a job parked in `delayed` (pause one task first)
   to confirm the `HSET`-on-delayed path lands on promotion.
5. **End-to-end** — resume, create three tasks, upvote one, confirm from the worker log
   (`fair-scheduling` enqueue lines) that its agents are picked up ahead of the others and that the
   unvoted tasks still make progress rather than stalling — the no-starvation property is the whole
   point.
6. **UI** — click ↑ in the list: the row moves up without navigating; the same score shows on the
   detail header; the arrow disables at ±5.

## Out of scope (named, deliberately)

Runtime/DDEV admission (`runtime-admission.ts`), preemption ordering (`pickPreemptibleRunner`) and
the runner-holder yield rule (`agent-reserve.ts`) keep their current behaviour. Each is a separate
gate with its own failure modes; a boosted task waiting on a DDEV slot still waits its turn.

---

# Amendment — 2026-08-21: shipped

Landed as `c4d9acb` (`feat(tasks): up/down vote scoring to prioritise a task’s AI agents`). This file is a historical record, not pending work — do not
re-implement from it. Line numbers in the body are as of writing and have since drifted; resolve
any reference by symbol name.
