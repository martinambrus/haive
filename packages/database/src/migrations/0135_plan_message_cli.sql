-- Which CLI produced a chat turn.
--
-- Recorded per MESSAGE, not read from the task: a conversation's provider can
-- be changed mid-flight, so the task's current CLI is not evidence of what
-- answered three turns ago. Null on user turns (a person has no CLI) and on
-- rows written before this existed — unknown, rather than guessed.
--
-- Additive and idempotent. Rollback: DROP COLUMN; nothing reads it but the
-- tooltip that names the agent.
ALTER TABLE "plan_node_messages"
  ADD COLUMN IF NOT EXISTS "cli_provider_id" uuid
  REFERENCES "cli_providers"("id") ON DELETE SET NULL;
