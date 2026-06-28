-- User-supplied reference files attached to a task (docs, screenshots, sample
-- data). Stored on the haive_repos volume under
-- `<repoRoot>/.haive/task-uploads/<taskId>/` and read by the AI CLI agent at
-- `/haive/workdir/.haive/task-uploads/<taskId>/`. Persist for the life of the
-- task (not consumed/deleted by a step like db_uploads). Idempotent.
CREATE TABLE IF NOT EXISTS "task_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "stored_path" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "content_type" varchar(128),
  "description" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "task_attachments_task_id_idx" ON "task_attachments" ("task_id");
CREATE INDEX IF NOT EXISTS "task_attachments_user_id_idx" ON "task_attachments" ("user_id");
