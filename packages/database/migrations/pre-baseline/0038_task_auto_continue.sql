-- Auto-continue toggle + gate-1 pre-answers. auto_continue=true keeps existing
-- tasks on the current behavior for formless steps; pre_answers stays null
-- until a task's gate-1 (06-gate-1-spec-approval) records its run
-- configuration for the hands-free stretch to gate 2.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "auto_continue";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "pre_answers";
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "auto_continue" boolean NOT NULL DEFAULT true;
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "pre_answers" jsonb;
