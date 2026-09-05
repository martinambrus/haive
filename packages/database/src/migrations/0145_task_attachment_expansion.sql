-- Uploaded archives expand into the tree they contain.
--
-- `task_attachments.filename` now holds a RELATIVE PATH rather than a basename,
-- so a folder upload keeps its structure. An uploaded `.zip`/`.tar`/`.tar.gz` is
-- the same thing arriving compressed: the worker expands it before any agent
-- reads it and inserts one row per contained file — exactly the rows a folder
-- upload would have produced. No existing row changes shape; a flat name is a
-- relative path with no directory part.
--
-- `expanded_from_id` links each produced row to the archive it came out of. It
-- does three jobs, which is why it is a real FK and not a derived prefix:
--   - removing the archive removes what it produced (ON DELETE CASCADE),
--   - it records provenance the de-duped directory name cannot (an archive
--     uploaded twice lands as `spec/` and `spec (2)/`),
--   - it is what stops expansion recursing: a row that HAS a parent is never
--     itself an expansion candidate, so a zip inside a zip stays a file.
--
-- `expanded_at` is the idempotency guard. Stamped even when the expansion
-- produced nothing — a failed or capped archive must not be retried on every
-- step for the life of the task. `expansion_note` says why, as display copy;
-- nothing branches on it (see the message-column rule in AGENTS.md).
--
-- Additive and idempotent. Rollback: revert `schema/task-attachments.ts` and
--   DROP INDEX IF EXISTS "task_attachments_expanded_from_idx";
--   ALTER TABLE "task_attachments" DROP COLUMN IF EXISTS "expanded_from_id";
--   ALTER TABLE "task_attachments" DROP COLUMN IF EXISTS "expanded_at";
--   ALTER TABLE "task_attachments" DROP COLUMN IF EXISTS "expansion_note";
-- Nothing is lost: rows an expansion wrote become ordinary attachment rows in a
-- subdirectory, their files stay on disk, and the agent keeps reading them.
ALTER TABLE "task_attachments"
  ADD COLUMN IF NOT EXISTS "expanded_from_id" uuid
  REFERENCES "task_attachments"("id") ON DELETE CASCADE;

ALTER TABLE "task_attachments" ADD COLUMN IF NOT EXISTS "expanded_at" timestamp;
ALTER TABLE "task_attachments" ADD COLUMN IF NOT EXISTS "expansion_note" text;

CREATE INDEX IF NOT EXISTS "task_attachments_expanded_from_idx"
  ON "task_attachments" ("expanded_from_id");
