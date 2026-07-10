-- Per-agent retry budget for agent-mining steps.
--
-- An unparseable reviewer (08c) or adversary (08d) that RAN was degraded to a
-- non-approving finding and never re-rolled: `retry` existed only on the `llm`
-- invocation spec, never on `agentMining`. Re-running one agent is far cheaper than
-- the alternatives -- a fix round through implementation, or a developer reject.
--
-- The llm path counts attempts by counting `cli_invocations` rows for the step
-- (countLlmAttempts). That does not translate: a mining row is UPDATEd in place on
-- retry, because the (task_step_id, agent_id) unique index forbids a second row for
-- the same agent. So the count lives on the row.
--
-- DEFAULT 1, not 0: a row exists only once its first invocation has been enqueued,
-- so an existing row has already had one attempt. Backfilling 0 would hand every
-- in-flight row an extra re-roll.
--
-- Deploy note: applied via `drizzle-kit push --force` from the schema; this file
-- is the idempotent parity/rollback record.
--
-- Rollback:
--   ALTER TABLE "task_step_agent_minings" DROP COLUMN IF EXISTS "attempts";

ALTER TABLE "task_step_agent_minings"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 1;
