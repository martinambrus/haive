-- DAG outer-loop escalation (replanner) state + debt aggregate on the plan.
-- The issue-advisor uses the already-reserved per-issue columns
-- (advisor_invocations, last_advisor_action, retry_context). Additive.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "replanner_invocations";
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "last_replanner_action";
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "replanner_invocation_id";
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "escalation_log";
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "debt_aggregate";
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "replanner_invocations" integer NOT NULL DEFAULT 0;
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "last_replanner_action" varchar(32);
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "replanner_invocation_id" uuid;
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "escalation_log" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "debt_aggregate" jsonb NOT NULL DEFAULT '{}'::jsonb;
