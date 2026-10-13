-- A task whose run list names a step this install no longer registers (a module removed, a step
-- renamed) is dead: no job walks, completes, fails or re-drives it. Both columns are null on every
-- live task. Additive and idempotent. Undo:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "dead_reason";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "dead_at";
-- After the undo a dead task fails on its next pickup, as before.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "dead_at" timestamp;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "dead_reason" text;
