-- Allow global env-replicate presets: a NULL repository_id makes a preset
-- reusable across all of the user's repos (a set value stays repo-scoped).
-- Idempotent + additive.
ALTER TABLE "env_dep_presets" ALTER COLUMN "repository_id" DROP NOT NULL;
-- Globals are deduped per (user, step, name); repo presets keep their own unique.
CREATE UNIQUE INDEX IF NOT EXISTS "env_dep_presets_global_step_name_idx"
  ON "env_dep_presets" ("user_id", "step_id", "name") WHERE "repository_id" IS NULL;

-- Rollback (delete globals first — re-adding NOT NULL fails while NULL rows exist):
-- DROP INDEX IF EXISTS "env_dep_presets_global_step_name_idx";
-- DELETE FROM "env_dep_presets" WHERE "repository_id" IS NULL;
-- ALTER TABLE "env_dep_presets" ALTER COLUMN "repository_id" SET NOT NULL;
