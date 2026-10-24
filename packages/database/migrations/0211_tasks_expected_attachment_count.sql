-- Record how many original uploads a deferred task expects, so Start can ask for confirmation
-- when fewer have landed. NULL preserves the start behavior for tasks without a recorded count.
--
-- Additive and idempotent. Undo: revert the code first, leaving this nullable column unused;
-- a later migration may remove it:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "expected_attachment_count";
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expected_attachment_count integer;
