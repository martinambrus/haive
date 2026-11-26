-- Keep a ready checkout available while maintenance still sees its queued refresh work.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS refresh_pending boolean NOT NULL DEFAULT false;
