-- Per-invocation live status line, so each terminal in a multi-agent step (e.g.
-- 03-phase-0a-discovery, where many personas mine in parallel) shows what its OWN
-- agent is doing — distinct from the step's shared status_message, which is
-- last-writer-wins. Set by the cli-exec status updater from the invocation's
-- stream. Idempotent + additive.
ALTER TABLE "cli_invocations" ADD COLUMN IF NOT EXISTS "status_message" varchar(256);

-- Rollback:
-- ALTER TABLE "cli_invocations" DROP COLUMN IF EXISTS "status_message";
