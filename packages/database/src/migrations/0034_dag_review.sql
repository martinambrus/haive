-- DAG inner review loop: per-issue reviewer/fix-coder runs + a plan-level toggle.
-- When review_enabled, each completed issue is reviewed (coder<->reviewer loop)
-- before merge. Agent runs are tracked in dag_agent_runs. Additive.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   DROP TABLE IF EXISTS "dag_agent_runs";
--   DROP TYPE IF EXISTS "dag_agent_role";
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "review_enabled";
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "review_enabled" boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE "dag_agent_role" AS ENUM ('coder', 'reviewer', 'issue_advisor', 'replanner');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "dag_agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dag_issue_id" uuid NOT NULL REFERENCES "task_dag_issues"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "role" "dag_agent_role" NOT NULL,
  "iteration" integer NOT NULL DEFAULT 0,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "cli_invocation_id" uuid,
  "output" jsonb,
  "raw_output" text,
  "consumed_at" timestamp,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "dag_agent_runs_issue_idx" ON "dag_agent_runs" ("dag_issue_id");
CREATE INDEX IF NOT EXISTS "dag_agent_runs_task_idx" ON "dag_agent_runs" ("task_id");
