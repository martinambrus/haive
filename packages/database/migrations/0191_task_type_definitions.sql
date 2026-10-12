-- Task type registry and per-task run list snapshot; rollback: ALTER TABLE "tasks" DROP COLUMN IF EXISTS "run_list_snapshot"; DROP TABLE IF EXISTS "task_type_definitions"; DROP TYPE IF EXISTS "run_list_strategy";
DO $$ BEGIN
  CREATE TYPE "public"."run_list_strategy" AS ENUM('static', 'workflow_paths', 'run_app_modes');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "task_type_definitions" (
  "slug" varchar(128) PRIMARY KEY NOT NULL,
  "display_name" text NOT NULL,
  "description" text,
  "run_list_strategy" "run_list_strategy" NOT NULL,
  "step_ids" jsonb,
  "pre_answer_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "step_loop_limit_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "fix_loop" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "selectable" boolean DEFAULT true NOT NULL,
  "source" varchar(128) NOT NULL,
  "requires_repository" boolean DEFAULT true NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "content_hash" varchar(64),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "run_list_snapshot" jsonb;
