-- Rollback: ALTER TABLE task_steps DROP COLUMN IF EXISTS detect_cli_provider_id;
ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS detect_cli_provider_id uuid;
