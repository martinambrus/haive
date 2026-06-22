-- Per-task "use my chosen CLI for all steps" override.
--   1. tasks.ignore_saved_step_clis: the New Task form toggle. Default false =
--      unchanged behavior; the step-CLI resolver + UI keep honoring saved
--      per-step prefs.
--   2. task_step_cli_touched: marks which (step, role) the user explicitly set a
--      CLI for within a flagged task, so a mid-task change is honored while the
--      auto-applied default stays the task's cli_provider_id. Keyed per task_id
--      => no cross-task bleed.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "task_step_cli_touched";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "ignore_saved_step_clis";
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "ignore_saved_step_clis" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "task_step_cli_touched" (
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "step_id" varchar(128) NOT NULL,
  "role" varchar(32) NOT NULL DEFAULT 'default',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "task_step_cli_touched_pk"
  ON "task_step_cli_touched" ("task_id", "step_id", "role");
CREATE INDEX IF NOT EXISTS "task_step_cli_touched_task_id_idx"
  ON "task_step_cli_touched" ("task_id");
