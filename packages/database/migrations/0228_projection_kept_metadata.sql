-- Undo only after kept_metadata is NULL for every row: dropping it earlier loses recovery data.
ALTER TABLE project_state_outbox ADD COLUMN IF NOT EXISTS kept_metadata jsonb;
