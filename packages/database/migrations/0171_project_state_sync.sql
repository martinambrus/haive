-- The render context a repository's templates were last written from, and the record the project
-- state sync starts from.
--
-- A second install can only plan an upgrade if the first one commits the context its templates
-- render from: `acceptedAgentIds` and `customAgentSpecs` exist only in the first install's database,
-- and `.haive/install.json` carries neither. `repositories.render_context` holds that context with
-- the RTK choice flag beside it, and `project_state_sync` holds the record `.haive-data/state/` was
-- last written from, which a later sync merges against.
--
-- Additive and idempotent. Nothing reads either yet, so NULL (no row, no value) is the state of every
-- repository until onboarding, an upgrade or a rollback records one. Undo:
--   DROP TABLE IF EXISTS "project_state_sync";
--   ALTER TABLE "repositories" DROP COLUMN IF EXISTS "render_context";
-- The record files those writers left in a checkout are not removed by it.

ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "render_context" jsonb;

CREATE TABLE IF NOT EXISTS "project_state_sync" (
  "repository_id" uuid PRIMARY KEY,
  "base_snapshot" jsonb NOT NULL,
  "last_error" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "project_state_sync" ADD CONSTRAINT "project_state_sync_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
