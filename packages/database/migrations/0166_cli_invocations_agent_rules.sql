-- Which agent rules a CLI run was given. The dispatcher injects each provider's effective rules at
-- the top of every prompt, and the exec start writes what happened: the rules' hash, whether they
-- were injected, and the reason when they were not (switched off, a step that opts out, or a
-- prompt too large to carry them).
--
-- NULL means "not recorded": every row written before this column, and any run that never started.
-- Reverts with DROP COLUMN; nothing branches on it.
ALTER TABLE cli_invocations ADD COLUMN IF NOT EXISTS agent_rules jsonb;
