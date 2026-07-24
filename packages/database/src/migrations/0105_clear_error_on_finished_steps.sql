-- Clear error copy off steps that ended successfully.
--
-- A step that failed on one attempt and succeeded on a later one kept its error_message: the
-- done-write cleared status_message but not error_message. The task page rendered its red banner
-- from that text alone, so a `done` row showed "cli invocation failed: CLI invocation orphaned by
-- a worker restart…" and read as a FAILED step — sitting beside whatever the task was really
-- doing, which made a single task look like it had two live steps at once (observed on 38f02dee:
-- 07b-phase-4-validate round 0 done-with-error next to its genuine round-1 runtime park).
--
-- The worker now nulls error_message on every done write and the panel keys on status; this clears
-- the rows already carrying stale text. Steps that ended well but with caveats use degraded_note /
-- warning_message, which are untouched here.
--
-- Data-only + idempotent: only done/skipped rows, and re-running matches nothing once cleared.
-- Failed rows keep their message — that is where it belongs.

UPDATE "task_steps"
SET "error_message" = NULL
WHERE "status" IN ('done', 'skipped')
  AND "error_message" IS NOT NULL;
