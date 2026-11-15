-- Immutable v3 per-consumer data edges. No default and no backfill.
-- Rollback: stop v3 admission, keep capable readers/workers for resumable v3 tasks,
-- and leave this nullable column and its migration journal row in place.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS data_edge_plan jsonb;
