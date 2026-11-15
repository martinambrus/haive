-- Additive rollback: revert application code; leave this inert, default-false column.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_act_on_insights boolean NOT NULL DEFAULT false;
