-- Rollback: revert the application code. The new nullable columns are harmless to old code;
-- the enum value cannot be dropped and is inert when unused. No executable down migration.
-- Optional manual cleanup, in a maintenance window. This refuses every task pin or reference,
-- including terminal and dead tasks. Keep the migration journal consistent before roll-forward.
-- BEGIN MANUAL ROLLBACK
-- DO $$ BEGIN
--   LOCK TABLE "tasks", "task_type_definitions" IN ACCESS EXCLUSIVE MODE;
--   IF EXISTS (
--     SELECT 1 FROM "tasks" AS t
--     LEFT JOIN "task_type_definitions" AS d ON d."slug" = t."type"
--     WHERE t."derived_run_plan" IS NOT NULL OR d."run_list_strategy" = 'derived'
--   ) THEN
--     RAISE EXCEPTION 'Cannot remove derived storage while any task pins or uses a derived type';
--   END IF;
--   DELETE FROM "task_type_definitions" WHERE "run_list_strategy" = 'derived';
--   ALTER TABLE "task_type_definitions"
--     DROP CONSTRAINT IF EXISTS "task_type_definitions_base_slug_task_type_definitions_slug_fk",
--     DROP CONSTRAINT IF EXISTS "task_type_definitions_derived_shape_check",
--     DROP CONSTRAINT IF EXISTS "task_type_definitions_non_derived_shape_check",
--     DROP CONSTRAINT IF EXISTS "task_type_definitions_base_not_self_check",
--     DROP COLUMN IF EXISTS "base_slug",
--     DROP COLUMN IF EXISTS "changes";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "derived_run_plan";
-- END $$;
-- END MANUAL ROLLBACK

ALTER TABLE "task_type_definitions" ADD COLUMN IF NOT EXISTS "base_slug" varchar(128);
ALTER TABLE "task_type_definitions" ADD COLUMN IF NOT EXISTS "changes" jsonb;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "derived_run_plan" jsonb;

DO $$ BEGIN
  ALTER TABLE "task_type_definitions" ADD CONSTRAINT "task_type_definitions_derived_shape_check"
    CHECK ("run_list_strategy" <> 'derived' OR (
      "base_slug" IS NOT NULL AND "changes" IS NOT NULL AND "step_ids" IS NULL
      AND "source" = 'admin' AND jsonb_typeof("changes") = 'array'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "task_type_definitions" ADD CONSTRAINT "task_type_definitions_non_derived_shape_check"
    CHECK ("run_list_strategy" = 'derived' OR ("base_slug" IS NULL AND "changes" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "task_type_definitions" ADD CONSTRAINT "task_type_definitions_base_not_self_check"
    CHECK ("base_slug" IS NULL OR "base_slug" <> "slug");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "task_type_definitions"
    ADD CONSTRAINT "task_type_definitions_base_slug_task_type_definitions_slug_fk"
    FOREIGN KEY ("base_slug") REFERENCES "task_type_definitions"("slug")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
