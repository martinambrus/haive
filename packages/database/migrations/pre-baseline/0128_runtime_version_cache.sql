-- Cached language-runtime version catalogs, for the declare-deps Ruby version resolution.
--
-- Additive and idempotent: the table is a cache, so an install that has never run
-- REFRESH_VERSIONS simply has no rows and a declared Ruby version resolves to nothing,
-- which renders exactly the apt install path that shipped before this. Dropping the table
-- loses nothing the next refresh rebuilds.
CREATE TABLE IF NOT EXISTS "runtime_version_cache" (
  "runtime" varchar(32) PRIMARY KEY,
  "versions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fetched_at" timestamp,
  "fetch_error" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);
