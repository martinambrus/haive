-- Per-repo registry of deterministic template outputs written by Haive's
-- onboarding and onboarding-upgrade workflows. Enables version-aware upgrades
-- and rollback without relying on the user's git history.
--
-- One live row per (repository_id, disk_path); history is preserved by
-- soft-deletion via superseded_at, mirroring the pattern already used by
-- cli_invocations.supersededAt.

CREATE TYPE artifact_source AS ENUM ('onboarding', 'upgrade', 'rollback', 'backfill');

CREATE TABLE "onboarding_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,

  "disk_path" text NOT NULL,
  "template_id" text NOT NULL,
  "template_kind" text NOT NULL,
  "template_schema_version" integer NOT NULL,
  "template_content_hash" varchar(64) NOT NULL,

  "written_hash" varchar(64) NOT NULL,
  "last_observed_disk_hash" varchar(64),
  "user_modified" boolean NOT NULL DEFAULT false,

  "form_values_snapshot" jsonb,
  "source_step_id" varchar(128) NOT NULL,
  "source" artifact_source NOT NULL DEFAULT 'onboarding',

  "generated_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "superseded_at" timestamp
);

CREATE INDEX "onboarding_artifacts_repo_id_idx" ON "onboarding_artifacts" ("repository_id");
CREATE INDEX "onboarding_artifacts_task_id_idx" ON "onboarding_artifacts" ("task_id");
CREATE INDEX "onboarding_artifacts_superseded_idx" ON "onboarding_artifacts" ("superseded_at");

-- At most one live row per (repo, disk_path); superseded rows are free to
-- duplicate disk_path because history lines up chronologically.
CREATE UNIQUE INDEX "onboarding_artifacts_repo_path_live_idx"
  ON "onboarding_artifacts" ("repository_id", "disk_path")
  WHERE "superseded_at" IS NULL;
