-- What a mining agent's last dispatch asked for beyond its step's spec: the seat it ran in
-- (`AgentMiningDispatch.roleKey`), its capability override, and `preferVision`.
--
-- A retry normally rebuilds each dispatch through the step's `selectAgents`, which sets all three
-- again. A WAVE agent cannot be rebuilt that way — the step threw it from apply(), so
-- `selectAgents` never authored it — and is recovered from the prompt its last run stored. That
-- recovery had nothing else to go on, so it ran in the `default` seat, possibly on a different CLI
-- than the run it repeats, and without a `vision` requirement a wireframe had put on the original.
--
-- NULL is "the dispatch set none": the `default` seat and the spec's own capabilities, which is
-- exactly how every existing row already resolves, so no backfill is needed.
--
-- Reverts with DROP COLUMN, and a code revert alone leaves the columns unused and harmless.
ALTER TABLE task_step_agent_minings ADD COLUMN IF NOT EXISTS role_key text;
ALTER TABLE task_step_agent_minings ADD COLUMN IF NOT EXISTS capabilities text[];
ALTER TABLE task_step_agent_minings ADD COLUMN IF NOT EXISTS prefer_vision boolean;
