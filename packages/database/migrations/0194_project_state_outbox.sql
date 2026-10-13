-- Dirty mark for the project state record (`.haive-data/state/`), one row per repository.
--
-- A mutation of anything the record carries (a bundle created or deleted, a ledger backfill) bumps
-- `revision` in its own transaction. A record write advances `written_revision` to the revision it
-- read before it looked at the database, so a mutation that lands during a write stays dirty. The
-- worker's 10 s sweep rewrites the record of a row with `revision > written_revision`, the way
-- `plan_mirror_state` drives the plan snapshot. A repository with no row has never been marked.
--
-- Additive and idempotent. Nothing reads the table until a mutation writes its first row. Undo:
--   DROP TABLE IF EXISTS "project_state_outbox";
-- The record already on disk stays as it is; the next record write (12, 02, 04) rewrites it from the
-- database as before, and the sweep no longer runs for lack of a mark.

CREATE TABLE IF NOT EXISTS "project_state_outbox" (
  "repository_id" uuid PRIMARY KEY NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "written_revision" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "project_state_outbox_revision_nonnegative" CHECK ("project_state_outbox"."revision" >= 0),
  CONSTRAINT "project_state_outbox_written_nonnegative" CHECK ("project_state_outbox"."written_revision" >= 0),
  CONSTRAINT "project_state_outbox_written_not_ahead" CHECK ("project_state_outbox"."written_revision" <= "project_state_outbox"."revision")
);

DO $$ BEGIN
  ALTER TABLE "project_state_outbox" ADD CONSTRAINT "project_state_outbox_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "project_state_outbox_dirty_idx" ON "project_state_outbox" USING btree ("repository_id") WHERE "project_state_outbox"."written_revision" < "project_state_outbox"."revision";
