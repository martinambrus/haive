-- Add the 'dag_parallel' cli_invocation_mode value.
--
-- The DAG executor (06c-dag-execute) dispatches N parallel coder/reviewer/advisor
-- invocations per level, all sharing the ONE 06c task_step_id. Under the singleton
-- index cli_invocations_one_live_per_step_idx (migration 0096) the 2nd concurrent
-- insert failed with 23505 and broke every multi-issue DAG level. Giving the DAG
-- fan-out its own mode lets migration 0098 exempt it from that index -- exactly
-- as 'agent_mining' (the review fan-out) is already exempt.
--
-- Split from the index change (0098) on purpose: PostgreSQL cannot USE a newly
-- added enum value in the same transaction that adds it, and 0098's predicate uses
-- 'dag_parallel'. Apply this file first (its own committed transaction), THEN 0098
-- / `drizzle-kit push`. Mirrors migration 0018 (which added 'agent_mining').
--
-- Rollback: PostgreSQL cannot cleanly DROP an enum value. Leaving 'dag_parallel'
-- in the type is harmless once the dispatch code reverts to 'cli' (no new rows use
-- it, and ended rows never constrain the live-only index). A full removal needs the
-- enum-recreate recipe (rename type, CREATE, ALTER COLUMN ... USING, DROP type).

ALTER TYPE "cli_invocation_mode" ADD VALUE IF NOT EXISTS 'dag_parallel';
