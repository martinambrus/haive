-- Chunked/resumable repository archive uploads. Session rows track per-user
-- upload progress so large archives can stream to disk in pieces and resume
-- after a client reconnect. The old single-shot /repos/upload endpoint
-- remains available for small archives.

CREATE TABLE "repo_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text,
  "branch" varchar(255) DEFAULT 'main',
  "filename" text NOT NULL,
  "archive_format" varchar(16) NOT NULL,
  "total_size" bigint NOT NULL,
  "bytes_received" bigint NOT NULL DEFAULT 0,
  "chunk_size" integer NOT NULL,
  "archive_path" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'uploading',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "repo_uploads_user_id_idx" ON "repo_uploads" ("user_id");
CREATE INDEX "repo_uploads_status_idx" ON "repo_uploads" ("status");
