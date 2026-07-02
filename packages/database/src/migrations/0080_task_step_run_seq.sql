-- Display-only ordering key for the task step list. step_index (global offset +
-- metadata.index) is NOT monotonic with run order when a step is reused across task
-- types at a different position (the env_replicate prelude inside a workflow task;
-- run_app's 98-choose-view at global 400 and 02/03 env steps at 2/3). Ordering the
-- step list by (created_at, step_index) then misplaces steps inserted mid-pipeline
-- on a resumed task. run_seq holds the step's position in buildRunList (stamped by
-- the worker on advance, backfilled on boot), so the list sorts by (round, run_seq)
-- in true run order. Nullable: legacy rows stay null and fall back to created_at.
-- Additive + idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "run_seq" integer;
