-- AI-assisted retry (retry_ai): stores the prior failure context on the step so
-- the step-runner can dispatch a diagnose-and-fix agent before re-running apply.
-- Additive, nullable.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "ai_fix_context";
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "ai_fix_context" jsonb;
