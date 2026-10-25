-- Undo: ALTER TABLE tasks DROP COLUMN IF EXISTS pr_remote_url;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pr_remote_url text;
