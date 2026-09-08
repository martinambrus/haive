-- Add 'agent_mining' to cli_invocation_mode enum.
-- Sub-agent-based knowledge mining writes one cli_invocations row per
-- agent. The discovery step-runner needs to distinguish these rows from
-- the 'selector' invocation (mode='cli') when picking the latest LLM
-- output to feed downstream phases.

ALTER TYPE cli_invocation_mode ADD VALUE IF NOT EXISTS 'agent_mining';
