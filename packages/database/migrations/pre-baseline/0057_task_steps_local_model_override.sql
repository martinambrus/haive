-- Per-step manual override for the "unsafe for local models" guard. Set true by
-- the "Override and run" UI action (retry + overrideLocalModel) so a user without
-- server shell access can run a destructive step (e.g. 09_5-skill-generation) on a
-- local Ollama model without the ALLOW_LOCAL_MODEL_DESTRUCTIVE_STEPS env flag.
-- Additive + idempotent.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "local_model_override" boolean NOT NULL DEFAULT false;

-- Rollback:
-- ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "local_model_override";
