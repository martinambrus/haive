-- Rollback: ALTER TABLE cli_providers DROP COLUMN IF EXISTS auth_generation;
ALTER TABLE cli_providers ADD COLUMN IF NOT EXISTS auth_generation uuid NOT NULL DEFAULT gen_random_uuid();
