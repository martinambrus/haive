-- Per-task execution path chosen by the 00-triage step:
--   quick_bugfix | plan_tasklist | full_workflow
-- NULL = legacy / pre-triage; buildRunList runs the full workflow when unset and
-- trims the workflow step list to the chosen path once 00-triage records it.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "execution_path" varchar(32);
