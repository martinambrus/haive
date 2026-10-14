-- Per-task integration choices, the account a preference names, one task grant per category, one repository
-- grant per account, and a repository allow-list switch that stays on when its accounts are deleted.
--
-- Additive and idempotent. Nothing read or wrote the grant and preference tables before this release, so the two
-- keys find no duplicate. Undo, which drops the choices, the preferred accounts, the switch and the two keys, no tokens:
--   DROP TABLE IF EXISTS "task_integration_choices";
--   DROP INDEX IF EXISTS "integration_grants_task_category_key_idx";
--   DROP INDEX IF EXISTS "integration_grants_repository_connection_key_idx";
--   ALTER TABLE "integration_category_preferences" DROP COLUMN IF EXISTS "connection_id";
--   ALTER TABLE "repositories" DROP COLUMN IF EXISTS "integrations_restricted";

CREATE TABLE IF NOT EXISTS "task_integration_choices" (
  "task_id" uuid NOT NULL,
  "category_id" varchar(256) NOT NULL,
  "provider_id" varchar(256) NOT NULL,
  "connection_id" uuid,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "task_integration_choices_task_id_category_id_pk" PRIMARY KEY("task_id","category_id")
);

DO $$ BEGIN
  ALTER TABLE "task_integration_choices" ADD CONSTRAINT "task_integration_choices_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "task_integration_choices" ADD CONSTRAINT "task_integration_choices_connection_id_integration_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "integration_category_preferences" ADD COLUMN IF NOT EXISTS "connection_id" uuid;

DO $$ BEGIN
  ALTER TABLE "integration_category_preferences" ADD CONSTRAINT "integration_category_preferences_connection_id_integration_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "integrations_restricted" boolean DEFAULT false NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "integration_grants_task_category_key_idx" ON "integration_grants" USING btree ("task_id","category_id") WHERE "integration_grants"."target_kind" = 'task';
CREATE UNIQUE INDEX IF NOT EXISTS "integration_grants_repository_connection_key_idx" ON "integration_grants" USING btree ("repository_id","connection_id") WHERE "integration_grants"."target_kind" = 'repository';
