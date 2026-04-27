-- Cache of the worker's compiled template manifest so the API can answer
-- upgrade-status queries without importing worker-side generators. Worker
-- synchronises this table on boot: upserts one row per manifest item and
-- deletes rows for template ids that have been removed from the manifest.
--
-- Singleton effective scope: this table is global, not per-repo. Per-repo
-- install state lives in `onboarding_artifacts`.

CREATE TABLE "template_manifest_cache" (
  "template_id" varchar(128) PRIMARY KEY,
  "template_kind" text NOT NULL,
  "schema_version" integer NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "set_hash" varchar(64) NOT NULL,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
