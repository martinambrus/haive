-- Checkout bytes successfully imported or written, independent of the merge base.
ALTER TABLE project_state_sync ADD COLUMN IF NOT EXISTS synced_hash text;
-- A committed undo journal precedes filesystem writes; success consumes it atomically.
ALTER TABLE project_state_outbox ADD COLUMN IF NOT EXISTS write_intent jsonb;
