-- DB dump uploads: chunked-upload sessions for database dumps. The finished
-- dump is imported into a task's ephemeral environment before migrations run,
-- then deleted. Mirrors repo_uploads. Additive: adds the db_uploads table plus
-- tasks.db_upload_id (the task references the dump to import).
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "db_upload_id";
--   DROP TABLE IF EXISTS "db_uploads";
CREATE TABLE IF NOT EXISTS "db_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "dump_format" varchar(16) NOT NULL,
  "total_size" bigint NOT NULL,
  "bytes_received" bigint NOT NULL DEFAULT 0,
  "chunk_size" integer NOT NULL,
  "dump_path" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'uploading',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "db_uploads_user_id_idx" ON "db_uploads" ("user_id");
CREATE INDEX IF NOT EXISTS "db_uploads_status_idx" ON "db_uploads" ("status");
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "db_upload_id" uuid
  REFERENCES "db_uploads"("id") ON DELETE SET NULL;
