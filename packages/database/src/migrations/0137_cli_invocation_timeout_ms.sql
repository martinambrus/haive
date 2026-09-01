-- Actual hard timeout budget per CLI invocation.
--
-- The step definition is not historical truth: retries can escalate their budget, a user can
-- override a later attempt, and provider-specific floors (currently Ollama) can raise the value
-- after dispatch. Persist the resolved value on the invocation when its worker job starts so the
-- terminal can show elapsed / limit for that exact run.
--
-- NULL means the invocation has not started yet or predates this migration. There is deliberately
-- no backfill: current step settings cannot tell us which retry rung or provider floor a past run
-- actually received.
--
-- No index: this is display data read with the invocation row.
--
-- Additive + idempotent. A code rollback can leave the nullable column in place harmlessly.
--
-- Rollback: ALTER TABLE "cli_invocations" DROP COLUMN IF EXISTS "timeout_ms";

ALTER TABLE "cli_invocations" ADD COLUMN IF NOT EXISTS "timeout_ms" integer;
