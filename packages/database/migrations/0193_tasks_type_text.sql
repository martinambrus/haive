-- tasks.type becomes text; rollback (only while every row is a built-in): DROP INDEX IF EXISTS "tasks_one_live_upgrade_per_repo_idx"; ALTER TABLE "tasks" ALTER COLUMN "type" TYPE "workflow_type" USING "type"::"workflow_type"; then recreate the index as in 0168.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'tasks'
      AND column_name = 'type'
      AND udt_name = 'workflow_type'
  ) THEN
    DROP INDEX IF EXISTS "tasks_one_live_upgrade_per_repo_idx";
    ALTER TABLE "tasks" ALTER COLUMN "type" TYPE text USING "type"::text;
    CREATE UNIQUE INDEX IF NOT EXISTS "tasks_one_live_upgrade_per_repo_idx" ON "tasks" USING btree ("repository_id") WHERE "tasks"."type" = 'onboarding_upgrade' and "tasks"."status" in ('created', 'queued', 'running', 'paused', 'waiting_user', 'waiting_pr');
  END IF;
END $$;
