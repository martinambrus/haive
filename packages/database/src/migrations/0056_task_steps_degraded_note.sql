-- Non-fatal advisory on a task step: set when the step's LLM output could not be
-- parsed and the step silently fell back to a deterministic stub (source
-- stub/salvage/fallback). The step status still finalizes as 'done'; the UI shows
-- this as an amber banner so a weak-but-alive model's degraded output is visible
-- instead of hidden. Idempotent + additive.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "degraded_note" text;

-- Rollback:
-- ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "degraded_note";
