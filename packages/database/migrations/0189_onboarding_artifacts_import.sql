-- A row of the artifact ledger an import wrote, with no task behind it.
--
-- Importing another install's project state records which paths that install claims, as ledger rows
-- this install never wrote. Such a row belongs to no task, so `task_id` stops being required, and
-- the CHECK keeps that to exactly one shape: a marker (`source = 'backfill'` with
-- `source_step_id = 'project-state-import'`) has no task and carries `imported_at`, and no other
-- row may lack a task. `imported_at` is the instant an import changed the path, on an inserted
-- marker and on a local row it retired.
--
-- Additive and idempotent. Nothing writes a marker before the import ships. Undo:
--   DELETE FROM "onboarding_artifacts" WHERE "task_id" IS NULL;
--   ALTER TABLE "onboarding_artifacts" DROP CONSTRAINT IF EXISTS "onboarding_artifacts_import_marker_check";
--   ALTER TABLE "onboarding_artifacts" ALTER COLUMN "task_id" SET NOT NULL;
--   ALTER TABLE "onboarding_artifacts" DROP COLUMN IF EXISTS "imported_at";
-- A path a marker had superseded then has no live row; the next upgrade plan backfills it.

ALTER TABLE "onboarding_artifacts" ADD COLUMN IF NOT EXISTS "imported_at" timestamp;

ALTER TABLE "onboarding_artifacts" ALTER COLUMN "task_id" DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE "onboarding_artifacts" ADD CONSTRAINT "onboarding_artifacts_import_marker_check"
    CHECK (("task_id" IS NULL) = ("source" = 'backfill' AND "source_step_id" = 'project-state-import') AND ("task_id" IS NOT NULL OR "imported_at" IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
