-- Per-task developer time estimate, in decimal hours (e.g. 0.25, 0.5, 1, 1.5).
-- Optional, set on the new-task form; compared against the actual effort
-- (agent work + user-active time) in the task header indicator and a footer
-- verdict card. NULL = no estimate; the comparison UI stays hidden.
-- Rollback: ALTER TABLE "tasks" DROP COLUMN IF EXISTS "estimated_time_hours";
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "estimated_time_hours" double precision;
