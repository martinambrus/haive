-- Per-step timing that survives a restart. Every path that throws a step back to
-- pending (retry, per-step / task-level CLI-provider change, revise / fix-loop /
-- crash recovery) zeroes the live timing columns (started_at, ended_at, idle_ms,
-- user_active_ms) so the current run measures cleanly. Before zeroing, the run's
-- work/idle/user contribution is folded into these accumulators. Timing readers add
-- carried_* on top of the current run, so work/idle/effort report the FULL step
-- across all restarts instead of only the latest attempt (previously the pre-retry
-- run was discarded, making the effort timer undercount actual work).
-- Additive + idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "carried_work_ms" integer NOT NULL DEFAULT 0;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "carried_idle_ms" integer NOT NULL DEFAULT 0;
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "carried_user_active_ms" integer NOT NULL DEFAULT 0;
