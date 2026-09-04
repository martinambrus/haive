-- Which CLI writes a task's per-step "What the agent did" recap, and whether one
-- is written at all.
--
-- The recap is 1-3 sentences, but the summarizer had no CLI of its own: it walked
-- the same per-step preference chain as the step itself and fell back to
-- tasks.cli_provider_id, so a coding model answered it. Worse, a preference the
-- dispatcher cannot honor is not an error there — resolveDispatch only ORDERS the
-- preferred provider first and falls through to whichever one is enabled next, so
-- "the summary ran on a model nobody chose" was a normal outcome.
--
-- MEASURED before this existed, across every step-summary invocation on the dev
-- install: claude-code spent 33,945 tokens and 22s on three sentences, and three
-- of six runs were killed by the pass's own 60s budget having written nothing.
--
-- Two columns, because "which model" and "run it at all" are different questions
-- and an FK cannot carry an off value. NULL provider = inherit (the step's saved
-- pref, then cli_provider_id) and enabled = true, which together are exactly what
-- every task did before this migration — so existing rows need no backfill and
-- change no behavior.
--
-- ON DELETE SET NULL matches every other FK on this table except user_id: deleting
-- a CLI provider must not delete tasks, and NULL here already means "inherit",
-- which is the safe reading of a provider that went away.
--
-- Additive and idempotent. The values are also declared in `schema/tasks.ts`, so
-- `drizzle-kit push --force` (what the db-migrate service runs) reaches the same
-- state on an environment that never sees this file; this is the parity record.
--
-- Rollback: remove `summaryCliProviderId` / `summaryLlmEnabled` from
-- `schema/tasks.ts`, revert the create-task handler and the worker's
-- maybeEnqueueStepSummary, and
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "summary_cli_provider_id";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "summary_llm_enabled";
-- Every row is already at the inherit/enabled defaults, so dropping them restores
-- the previous behavior exactly, with no data loss.
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "summary_cli_provider_id" uuid
  REFERENCES "cli_providers"("id") ON DELETE SET NULL;

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "summary_llm_enabled" boolean NOT NULL DEFAULT true;
