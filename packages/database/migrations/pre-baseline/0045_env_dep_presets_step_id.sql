-- Generalize env_dep_presets to snapshot any env-replicate step's form (step 1
-- '01-declare-deps' deps OR step 2 '02-generate-dockerfile' Dockerfile), scoped
-- per (repository, step, name). Additive + idempotent; existing rows default to
-- the step-1 deps form so they keep their current behaviour.
ALTER TABLE "env_dep_presets" ADD COLUMN IF NOT EXISTS "step_id" text NOT NULL DEFAULT '01-declare-deps';
DROP INDEX IF EXISTS "env_dep_presets_repo_name_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "env_dep_presets_repo_step_name_idx" ON "env_dep_presets" ("repository_id","step_id","name");

-- Rollback:
-- DROP INDEX IF EXISTS "env_dep_presets_repo_step_name_idx";
-- CREATE UNIQUE INDEX IF NOT EXISTS "env_dep_presets_repo_name_idx" ON "env_dep_presets" ("repository_id","name");
-- ALTER TABLE "env_dep_presets" DROP COLUMN IF EXISTS "step_id";
