-- DAG auto-resolve toggle: when set, 06c-dag-execute auto-dispatches the LLM
-- merge-fix agent for conflicting branches and loops (bounded) until all merge,
-- instead of halting for a manual "Retry with LLM". Chosen at the 2c gate.
-- Additive, defaults false.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "task_dag_plans" DROP COLUMN IF EXISTS "auto_resolve_conflicts";
ALTER TABLE "task_dag_plans"
  ADD COLUMN IF NOT EXISTS "auto_resolve_conflicts" boolean NOT NULL DEFAULT false;
