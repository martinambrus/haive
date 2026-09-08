-- Per-step idle accounting so the UI can report active work time (wall-clock
-- minus time spent waiting for user input). idle_ms accumulates closed
-- waiting_form periods; waiting_started_at marks an in-progress wait, folded
-- into idle_ms when the user submits the form.
--
-- Rollback:
--   ALTER TABLE "task_steps" DROP COLUMN "waiting_started_at";
--   ALTER TABLE "task_steps" DROP COLUMN "idle_ms";
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "idle_ms" integer NOT NULL DEFAULT 0;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "waiting_started_at" timestamp;
