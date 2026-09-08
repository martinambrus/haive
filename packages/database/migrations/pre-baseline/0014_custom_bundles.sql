-- Custom user-supplied bundle ingestion. Each bundle is per-repo; ingestion
-- happens during onboarding (step 06_3-custom-bundles) and upgrades re-sync
-- git-sourced bundles via the new 00-bundle-resync step. Items inside a
-- bundle are normalised to canonical IR (AgentSpec or SkillEntry) and emitted
-- to disk through the existing onboarding_artifacts lifecycle, which means
-- bundle items participate in clean_update/conflict/rollback for free.

CREATE TYPE custom_bundle_source_type AS ENUM ('zip', 'git');
CREATE TYPE custom_bundle_status AS ENUM ('active', 'syncing', 'failed');
CREATE TYPE custom_bundle_item_kind AS ENUM ('agent', 'skill');
CREATE TYPE custom_bundle_item_source_format AS ENUM ('claude-md', 'codex-toml', 'gemini-md');

CREATE TABLE "custom_bundles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "source_type" custom_bundle_source_type NOT NULL,
  "archive_filename" text,
  "archive_path" text,
  "archive_format" varchar(16),
  "git_url" text,
  "git_branch" varchar(255),
  "git_credentials_id" uuid REFERENCES "repo_credentials"("id") ON DELETE SET NULL,
  "storage_root" text NOT NULL,
  "enabled_kinds" text[] NOT NULL DEFAULT ARRAY['agent','skill']::text[],
  "last_sync_at" timestamp,
  "last_sync_commit" varchar(40),
  "last_sync_error" text,
  "status" custom_bundle_status NOT NULL DEFAULT 'active',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "custom_bundles_repository_id_idx" ON "custom_bundles" ("repository_id");
CREATE INDEX "custom_bundles_user_repo_idx" ON "custom_bundles" ("user_id", "repository_id");

-- Chunked/resumable upload sessions for ZIP/TAR bundle archives. Mirrors the
-- repo_uploads pattern from migration 0007. The bundle_id is nullable until
-- complete, when the upload is rolled into a custom_bundles row using the
-- per-session bundle metadata (repository, name, enabled_kinds).
CREATE TABLE "custom_bundle_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "bundle_id" uuid REFERENCES "custom_bundles"("id") ON DELETE CASCADE,
  "repository_id" uuid NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "name" varchar(255) NOT NULL,
  "enabled_kinds" text[] NOT NULL DEFAULT ARRAY['agent','skill']::text[],
  "filename" text NOT NULL,
  "archive_format" varchar(16) NOT NULL,
  "total_size" bigint NOT NULL,
  "bytes_received" bigint NOT NULL DEFAULT 0,
  "chunk_size" integer NOT NULL,
  "archive_path" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'uploading',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX "custom_bundle_uploads_user_id_idx" ON "custom_bundle_uploads" ("user_id");
CREATE INDEX "custom_bundle_uploads_status_idx" ON "custom_bundle_uploads" ("status");

CREATE TABLE "custom_bundle_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bundle_id" uuid NOT NULL REFERENCES "custom_bundles"("id") ON DELETE CASCADE,
  "kind" custom_bundle_item_kind NOT NULL,
  "source_format" custom_bundle_item_source_format NOT NULL,
  "source_path" text NOT NULL,
  "normalized_spec" jsonb NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "custom_bundle_items_bundle_path_idx"
  ON "custom_bundle_items" ("bundle_id", "source_path");
CREATE INDEX "custom_bundle_items_bundle_kind_idx" ON "custom_bundle_items" ("bundle_id", "kind");

-- Bundle-derived rows in onboarding_artifacts reference the source item so
-- upgrade/rollback can relink content to its bundle even after a re-parse.
-- Null on legacy rows and on rows produced from Haive's deterministic
-- template manifest.
ALTER TABLE "onboarding_artifacts"
  ADD COLUMN "bundle_item_id" uuid REFERENCES "custom_bundle_items"("id") ON DELETE SET NULL;

CREATE INDEX "onboarding_artifacts_bundle_item_idx" ON "onboarding_artifacts" ("bundle_item_id");
