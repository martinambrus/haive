-- When an admin switched a module off; NULL while it is active. A switched-off module's routes, nav
-- entry, settings and palette steps stop answering and a revived task cannot run its steps; its
-- rows, database and stored settings are left as they are.
--
-- Two writers, on different columns: the worker boot owns the intent columns (what it loaded, and
-- since when a module that loaded before is missing); the admin toggle owns deactivated_at. The
-- boot upsert never names this column, so a module stays off across restarts and reinstalls.
--
-- Additive and idempotent: every existing row reads as active. Undo:
--   ALTER TABLE "modules" DROP COLUMN IF EXISTS "deactivated_at";
-- Every module is then active again.

ALTER TABLE "modules" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp;
