-- Module task types may select providers inside their own consent steps.
-- Existing types retain the automatic task-provider canary. Task pins are unchanged.
ALTER TABLE task_type_definitions
  ADD COLUMN IF NOT EXISTS selects_own_providers boolean NOT NULL DEFAULT false;
