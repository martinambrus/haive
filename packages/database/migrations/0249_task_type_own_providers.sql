-- Module task types may select providers inside their own consent steps.
-- Existing types retain the automatic task-provider canary. Task pins are unchanged.
-- Rollback: older images ignore this column. To undo, add a new numbered migration with
-- ALTER TABLE task_type_definitions DROP COLUMN IF EXISTS selects_own_providers;
-- never remove this file once any database has applied it.
ALTER TABLE task_type_definitions
  ADD COLUMN IF NOT EXISTS selects_own_providers boolean NOT NULL DEFAULT false;
