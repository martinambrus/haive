-- Cached browser version catalogs for the declare-deps browser picker.
--
-- Additive and idempotent: the table is a cache, so an install that has never run
-- REFRESH_VERSIONS simply has no rows and the picker degrades to "system default" only.
-- Dropping it loses nothing the next refresh rebuilds.
CREATE TABLE IF NOT EXISTS "browser_version_cache" (
  "browser" varchar(32) PRIMARY KEY,
  "versions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fetched_at" timestamp,
  "fetch_error" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
