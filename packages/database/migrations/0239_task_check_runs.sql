-- Undo: revert the application commits; leaving these unused tables is harmless.
-- Drop them only through a later numbered migration, never by editing this file.
CREATE TABLE IF NOT EXISTS "task_check_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL CONSTRAINT "task_check_runs_task_id_tasks_id_fk" REFERENCES "tasks"("id") ON DELETE CASCADE,
  "task_step_id" uuid CONSTRAINT "task_check_runs_task_step_id_task_steps_id_fk" REFERENCES "task_steps"("id") ON DELETE SET NULL,
  "step_id" text NOT NULL,
  "slot" text NOT NULL,
  "attempt_id" text NOT NULL,
  "outcome" text NOT NULL,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "ended_at" timestamp,
  CONSTRAINT "task_check_runs_slot_check" CHECK ("slot" in ('test', 'lint', 'php_lint', 'typecheck')),
  CONSTRAINT "task_check_runs_outcome_check" CHECK ("outcome" in ('running', 'passed', 'failed', 'not_run', 'interrupted')),
  CONSTRAINT "task_check_runs_attempt_unique" UNIQUE ("task_id", "step_id", "slot", "attempt_id")
);
CREATE INDEX IF NOT EXISTS "task_check_runs_task_id_idx" ON "task_check_runs" ("task_id");
CREATE INDEX IF NOT EXISTS "task_check_runs_task_step_id_idx" ON "task_check_runs" ("task_step_id");

CREATE TABLE IF NOT EXISTS "task_check_recording" (
  "id" integer PRIMARY KEY NOT NULL,
  "started_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "task_check_recording_singleton" CHECK ("id" = 1)
);
INSERT INTO "task_check_recording" ("id") VALUES (1) ON CONFLICT DO NOTHING;
