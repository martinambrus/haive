-- Additive execution declarations only. No backfill, defaults, guard writer or runtime.
-- Rollback stops admission and retains nullable columns and every immutable task pin.
ALTER TABLE task_type_definitions ADD COLUMN IF NOT EXISTS execution_contract jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_contract jsonb;
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS guard_state jsonb;
