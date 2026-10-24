-- tasks.db_upload_id (FK to db_uploads, ON DELETE SET NULL) had no index: the upload reaper read every
-- task linking a dump, and each db_uploads delete scanned tasks. The reaper now keys that read by dump id.
--
-- Additive and idempotent. Undo (the code needs no revert, the index is only a speed-up):
--   DROP INDEX IF EXISTS "tasks_db_upload_id_idx";
CREATE INDEX IF NOT EXISTS "tasks_db_upload_id_idx" ON "tasks" USING btree ("db_upload_id");
