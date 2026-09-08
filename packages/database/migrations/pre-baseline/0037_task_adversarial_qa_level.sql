-- Phase 7 toggle: when set to poc|standard|enterprise, the 08d-adversarial-qa
-- step fans out 2/4/6 adversarial QA agents over the implementation before
-- gate 2. Chosen on the new-task form. Additive, nullable (null/'none' = off) so
-- existing tasks and direct-insert fixtures skip the step.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "adversarial_qa_level";
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "adversarial_qa_level" text;
