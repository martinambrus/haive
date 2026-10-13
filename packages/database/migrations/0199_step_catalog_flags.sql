-- Two per-step flags the api reads from step_catalog: whether the step itself dispatches a CLI
-- (dispatches_cli also counts a merge fixer, which runs one only on a conflict), and its position
-- in the run order. The worker boot sync is the one writer.
--
-- Additive and idempotent. Rows read as "dispatches no CLI, no position" until the worker's next
-- boot rewrites them. Undo:
--   ALTER TABLE "step_catalog" DROP COLUMN IF EXISTS "dispatches_step_cli";
--   ALTER TABLE "step_catalog" DROP COLUMN IF EXISTS "step_index";

ALTER TABLE "step_catalog" ADD COLUMN IF NOT EXISTS "dispatches_step_cli" boolean DEFAULT false NOT NULL;
ALTER TABLE "step_catalog" ADD COLUMN IF NOT EXISTS "step_index" double precision;
