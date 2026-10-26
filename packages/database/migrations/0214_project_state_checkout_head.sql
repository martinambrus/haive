-- An observed, successfully admitted named checkout. Never a source of record ownership.
ALTER TABLE project_state_sync ADD COLUMN IF NOT EXISTS synced_head text;
