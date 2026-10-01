-- A step's CLI picked during a task now belongs to that task. Changing it used to rewrite the
-- user's saved (user, step, role) preference, so every LATER task of that user inherited a switch
-- made to rescue one stuck run. The picker now writes here, and writes the saved preference too
-- only when asked to. A NULL provider is a choice as well: the task cleared that slot, so the
-- saved preference stays out of it and the slot falls back as though none existed.
--
-- Additive and idempotent. Rollback: revert `schema/tasks.ts` and
--   DROP TABLE IF EXISTS "task_step_cli_choices";
-- The resolvers then read the saved preferences alone, as they did before; a choice made in a
-- task is lost, its task falling back to the saved preference or the task's own CLI.

CREATE TABLE IF NOT EXISTS "task_step_cli_choices" (
  "task_id" uuid NOT NULL,
  "step_id" varchar(128) NOT NULL,
  "role" varchar(32) DEFAULT 'default' NOT NULL,
  "cli_provider_id" uuid,
  "effort_level" text,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "task_step_cli_choices" ADD CONSTRAINT "task_step_cli_choices_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "task_step_cli_choices" ADD CONSTRAINT "task_step_cli_choices_cli_provider_id_cli_providers_id_fk"
    FOREIGN KEY ("cli_provider_id") REFERENCES "public"."cli_providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "task_step_cli_choices_pk" ON "task_step_cli_choices" USING btree ("task_id", "step_id", "role");
