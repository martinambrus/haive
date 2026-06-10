-- Phase 2c sprint-planning + Phase 3 DAG execution state. Three tables persist a
-- crash-recoverable DAG: task_dag_plans (the 2c decision), task_dag_levels (the
-- per-wave checkpoint cursor), task_dag_issues (the per-coder barrier row).
-- Additive. Columns reserved for later slices (inner review / escalation / merge)
-- are created now so the executor's resume tree can read them as no-ops.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "task_dag_issues";
--   DROP TABLE IF EXISTS "task_dag_levels";
--   DROP TABLE IF EXISTS "task_dag_plans";
--   DROP TYPE IF EXISTS "dag_issue_outcome";
DO $$ BEGIN
  CREATE TYPE "dag_issue_outcome" AS ENUM (
    'pending', 'running', 'completed', 'completed_with_debt', 'failed_unrecoverable'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "task_dag_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "task_step_id" uuid NOT NULL REFERENCES "task_steps"("id") ON DELETE CASCADE,
  "mode" varchar(16) NOT NULL,
  "rationale" text,
  "max_parallel" integer NOT NULL DEFAULT 1,
  "levels" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model_map" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "plan_json" jsonb,
  "replan_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "task_dag_plans_task_id_idx" ON "task_dag_plans" ("task_id");
CREATE UNIQUE INDEX IF NOT EXISTS "task_dag_plans_task_step_idx" ON "task_dag_plans" ("task_step_id");

CREATE TABLE IF NOT EXISTS "task_dag_levels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dag_plan_id" uuid NOT NULL REFERENCES "task_dag_plans"("id") ON DELETE CASCADE,
  "level" integer NOT NULL,
  "issue_keys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "phase" varchar(32) NOT NULL DEFAULT 'pending',
  "merge_state" jsonb,
  "checkpointed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "task_dag_levels_plan_id_idx" ON "task_dag_levels" ("dag_plan_id");
CREATE UNIQUE INDEX IF NOT EXISTS "task_dag_levels_plan_level_idx" ON "task_dag_levels" ("dag_plan_id", "level");

CREATE TABLE IF NOT EXISTS "task_dag_issues" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dag_plan_id" uuid NOT NULL REFERENCES "task_dag_plans"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "issue_key" varchar(64) NOT NULL,
  "level" integer NOT NULL,
  "title" varchar(512) NOT NULL,
  "description" text,
  "spec_sections" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "acceptance_criteria" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "depends_on" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "estimated_files" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provides" text,
  "guidance" jsonb,
  "worktree_path" text,
  "sandbox_worktree_path" text,
  "branch_name" varchar(256),
  "outcome" "dag_issue_outcome" NOT NULL DEFAULT 'pending',
  "cli_invocation_id" uuid,
  "files_modified" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "debt_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "concerns" text,
  "raw_output" text,
  "error_message" text,
  "review_status" varchar(32),
  "inner_iteration" integer NOT NULL DEFAULT 0,
  "stuck_count" integer NOT NULL DEFAULT 0,
  "reviewer_verdict" jsonb,
  "advisor_invocations" integer NOT NULL DEFAULT 0,
  "last_advisor_action" varchar(32),
  "retry_context" jsonb,
  "parent_issue_id" uuid,
  "resolution" varchar(32),
  "merge_status" varchar(32),
  "merged_at" timestamp,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "task_dag_issues_plan_id_idx" ON "task_dag_issues" ("dag_plan_id");
CREATE INDEX IF NOT EXISTS "task_dag_issues_task_level_idx" ON "task_dag_issues" ("task_id", "level");
CREATE UNIQUE INDEX IF NOT EXISTS "task_dag_issues_plan_issue_idx" ON "task_dag_issues" ("dag_plan_id", "issue_key");
