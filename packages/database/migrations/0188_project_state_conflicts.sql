-- Units of the project state record that this install and the checkout both changed, differently.
--
-- The sync (`.haive-data/state/` into the database) merges a checkout's record against the base it
-- last synced from. A unit both sides changed since that base used to keep the local value and
-- name the key in `project_state_sync.last_error`, and the next writer rendered the record from the
-- column alone, which settled the conflict for the local side without asking. One row per such unit
-- keeps the three values until a person answers, so the writer can leave the other side's value in
-- the file and an upgrade can wait.
--
-- `base`, `local` and `incoming` hold `{"v": <value>}`, so a JSON null is a value and a NULL column
-- is a side that has no such unit. `resolution` is keep_mine, take_theirs or converged, validated in
-- code. At most one pending row (`resolved_at IS NULL`) per repository and unit.
--
-- Additive and idempotent. Nothing reads the table before the sync writes its first row. Undo:
--   DROP TABLE IF EXISTS "project_state_conflicts";
-- That takes the pending questions with it; the next sync finds each conflict again from the base
-- it kept, so nothing is settled for either side by dropping it.

CREATE TABLE IF NOT EXISTS "project_state_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "repository_id" uuid NOT NULL,
  "unit" text NOT NULL,
  "base" jsonb,
  "local" jsonb,
  "incoming" jsonb,
  "detected_at" timestamp DEFAULT now() NOT NULL,
  "resolution" text,
  "resolved_at" timestamp,
  "resolved_by" uuid
);

DO $$ BEGIN
  ALTER TABLE "project_state_conflicts" ADD CONSTRAINT "project_state_conflicts_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_state_conflicts" ADD CONSTRAINT "project_state_conflicts_resolved_by_users_id_fk"
    FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "project_state_conflicts_pending_idx" ON "project_state_conflicts" USING btree ("repository_id","unit") WHERE resolved_at IS NULL;
