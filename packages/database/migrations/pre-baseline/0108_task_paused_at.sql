-- Per-task pause: the user holds a task so its CLI subscription budget goes to the
-- other tasks instead. The CLI run in flight finishes; after that the orchestrator
-- stops handing this task work (no next step, no new CLI invocation) until cleared.
--
-- A COLUMN, not the `paused` member of the task_status enum. That member exists but
-- nothing has ever written it, and adopting it now would be a silent regression:
-- every reaper, orchestration guard, boot backstop and blocker query keys on the
-- concrete status (running / queued / waiting_*), so a paused task would drop out of
-- all of them at once. The task keeps its real status and "paused" is derived for
-- display and filtering, exactly as the runtime-slot wait already is (deriveSlotWait).
--
-- No index: every gate reads this by task primary key, and the one query that filters
-- on it (?status=paused in the tasks listing) is already scoped by user_id.
--
-- Additive + idempotent: a second run is a no-op, and leaving the column in place
-- after a code revert is harmless (nothing reads it). To undo the feature's effect
-- without a deploy: UPDATE tasks SET paused_at = NULL;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "paused_at" timestamp;
