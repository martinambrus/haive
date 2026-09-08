-- Parent task a bug fix belongs to (one level only). Self-FK on "tasks".
--
-- A bug-fix task can now point at the completed task it belongs to -- the
-- original feature, or, when the developer picks another bug fix, that bug
-- fix's own parent (the create handler flattens so the link never chains past
-- one level). This is the prerequisite for later rolling up time/tokens per
-- feature; nothing reads the column yet.
--
-- ON DELETE SET NULL (not CASCADE) on purpose: deleting a parent feature must
-- un-link its bug fixes, never delete them. Mirrors every other FK on "tasks".
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "parent_task_id";

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "tasks_parent_task_id_idx" ON "tasks" ("parent_task_id");
