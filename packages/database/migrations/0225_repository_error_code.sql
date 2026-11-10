-- Rollback: ALTER TABLE repositories DROP COLUMN IF EXISTS error_code;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS error_code text;
