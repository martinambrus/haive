-- Fix-loop "rounds": when a downstream workflow step finds a blocking defect, the
-- flow re-enters at 07-phase-2-implement and re-runs the post-implementation chain
-- as a NEW round. Each round materializes its own task_steps rows (full per-round
-- history + CLI-reliability stats), distinguished by `round`. The original pass is
-- round 0, so this is purely additive: every existing row stays round 0 and the new
-- unique index equals the old one at apply time.
--   task_steps.round      per-row round discriminator (0 = original pass)
--   tasks.current_round   round new rows are materialized at (display + escalation)
--   tasks.max_fix_rounds  per-task cap on automatic fix rounds (Gate-1 run config)
-- Idempotent + additive.

ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "round" integer NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "current_round" integer NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "max_fix_rounds" integer NOT NULL DEFAULT 5;

-- Swap per-(task,step) uniqueness to per-(task,step,round) so a step can recur once
-- per round. Create the new unique FIRST (it equals the old one while all rows are
-- round 0), then drop the old one.
CREATE UNIQUE INDEX IF NOT EXISTS "task_steps_task_step_round_idx"
  ON "task_steps" ("task_id", "step_id", "round");
DROP INDEX IF EXISTS "task_steps_task_step_idx";

-- Rollback (additive-first, so undo is reversible while no fix round has run):
--   DELETE FROM "task_steps" WHERE "round" > 0;   -- only if any fix round ran
--   CREATE UNIQUE INDEX IF NOT EXISTS "task_steps_task_step_idx" ON "task_steps" ("task_id", "step_id");
--   DROP INDEX IF EXISTS "task_steps_task_step_round_idx";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "max_fix_rounds";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "current_round";
--   ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "round";
