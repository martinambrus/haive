-- Restore each task's ORIGINAL start so its wall clock accumulates like work and idle.
--
-- handleStartTask ran markTaskRunning on every task-level retry, and that write re-stamped
-- tasks.started_at unconditionally. The step rows' carried_work_ms / carried_idle_ms survive a
-- reset, so work and idle kept accumulating across runs while wall silently restarted: a task
-- retried today after days of runs reported `wall 44m` next to `idle 193h`, and the two could
-- never reconcile. The worker now stamps started_at once (coalesce) and clears the stale
-- completedAt; this recovers the first start for tasks that already lost it.
--
-- Source of truth is the task_events trail: handleStartTask appends a 'task.running' event
-- immediately after the write, so the EARLIEST such event is the original start. Tasks with no
-- 'task.running' event (never started) are left untouched.
--
-- Data-only + idempotent: it only ever moves started_at BACKWARDS to the first event, so a
-- second run matches no rows (first_run is then >= started_at). Safe to re-run on every
-- environment.

UPDATE "tasks" AS t
SET "started_at" = e."first_run"
FROM (
  SELECT "task_id", MIN("created_at") AS "first_run"
  FROM "task_events"
  WHERE "event_type" = 'task.running'
  GROUP BY "task_id"
) AS e
WHERE e."task_id" = t."id"
  AND (t."started_at" IS NULL OR e."first_run" < t."started_at");
