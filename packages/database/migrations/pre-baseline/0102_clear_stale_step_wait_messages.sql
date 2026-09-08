-- Clear frozen wait notes off pending step rows.
--
-- A full task retry replays from step 0 and the fix loop restarts at round 1, so rows
-- materialized by a previous, longer run (rounds 2+) are orphaned at `pending` and never run
-- again — yet they keep the status_message they were parked with ("Waiting for a free runtime
-- slot…", "Queued — machine at capacity…"). The step list sorts by (round, run_seq), so that
-- frozen line renders at the BOTTOM of the task page and reads as the task's current state
-- while the live step sits mid-page. The retry path now clears these at the source; this
-- clears the rows already carrying one.
--
-- Same litter lands on `skipped` rows: a step can park on a runtime slot and then be skipped
-- by its shouldRun/skip gate, which leaves the wait note behind on a row that never ran.
--
-- Data-only + idempotent: neither status holds a durable message. A step still parked on a
-- runtime slot rewrites its own within one park poll (15s), and a step that starts clears it
-- anyway (step-runner, pending->running). done/failed rows are left alone — there the message
-- is a run artifact worth keeping. Safe to re-run on every environment.

UPDATE "task_steps"
SET "status_message" = NULL
WHERE "status" IN ('pending', 'skipped')
  AND "status_message" IS NOT NULL;
