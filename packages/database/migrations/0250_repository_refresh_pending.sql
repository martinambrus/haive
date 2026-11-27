-- Keep a ready checkout available while maintenance still sees its queued refresh work.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS refresh_pending boolean NOT NULL DEFAULT false;
-- The admission chooses the BullMQ id before enqueue; older preparations cannot clear its work.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS refresh_job_id text;
