-- Phase 3.5 toggle: when set, the 07a-code-simplify step runs an AI code
-- simplification pass (plus a conditional fixup pass) over the implementation
-- before verification. Chosen on the new-task form. Additive, defaults false so
-- existing tasks and direct-insert fixtures skip the step.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "simplify_code";
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "simplify_code" boolean NOT NULL DEFAULT false;
