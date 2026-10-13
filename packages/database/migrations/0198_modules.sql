-- Intent record for each module this install has loaded: what the worker registered at its last
-- boot, and since when a module that loaded before is missing. The worker boot is the one writer.
--
-- Additive and idempotent. Nothing reads the table before the worker's next boot writes it. Undo:
--   DROP TABLE IF EXISTS "modules";
-- Modules keep loading from the build as before; only the record of what loaded is lost.

CREATE TABLE IF NOT EXISTS "modules" (
  "module_id" text PRIMARY KEY NOT NULL,
  "package_name" text NOT NULL,
  "name" text NOT NULL,
  "source" text DEFAULT 'local' NOT NULL,
  "installed_version" text NOT NULL,
  "entitlement_id" text,
  "first_loaded_at" timestamp DEFAULT now() NOT NULL,
  "last_loaded_at" timestamp DEFAULT now() NOT NULL,
  "missing_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "modules" ADD CONSTRAINT "modules_source_check"
    CHECK ("modules"."source" IN ('local', 'git', 'registry'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
