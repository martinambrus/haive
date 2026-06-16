-- Per-invocation title for multi-CLI loop steps: the role of THIS pass
-- (Validator / Fixer, Reviewer / Corrector, Simplifier / Fixup verifier) so the
-- terminal header shows which agent ran, the same way it already shows the mining
-- agent name. Distinct from task_step_agent_minings.agent_title (mining only); the
-- api COALESCEs the two into the invocation's displayed title. Idempotent + additive.
ALTER TABLE "cli_invocations" ADD COLUMN IF NOT EXISTS "agent_title" varchar(256);

-- Rollback:
-- ALTER TABLE "cli_invocations" DROP COLUMN IF EXISTS "agent_title";
