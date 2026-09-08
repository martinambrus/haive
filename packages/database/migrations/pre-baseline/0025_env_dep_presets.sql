-- Reusable, per-repository dependency presets for env-replicate step 1
-- (01-declare-deps). Stores a named snapshot of the step-1 form inputs so the
-- user can prefill the dependency form on future runs instead of re-entering
-- all fields by hand. Distinct from env_templates (the per-task environment
-- state: declared deps + dockerfile + build status). Upsert target is
-- (repository_id, name); rows cascade-delete with their repository or user.
--
-- Deploy note: the dev/prod apply path is `drizzle-kit push --force` from the
-- schema (the db-migrate one-shot in docker-compose.dev.yml), which creates
-- this table from packages/database/src/schema/env.ts. This file is the
-- idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "env_dep_presets";
CREATE TABLE IF NOT EXISTS "env_dep_presets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "values" jsonb NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "env_dep_presets_repository_id_idx" ON "env_dep_presets" ("repository_id");
CREATE UNIQUE INDEX IF NOT EXISTS "env_dep_presets_repo_name_idx" ON "env_dep_presets" ("repository_id", "name");
