-- Rollback: ALTER TABLE task_steps DROP COLUMN IF EXISTS integration_wait;
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS integration_wait jsonb;
