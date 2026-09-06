-- Record that the New Task form STATED a CLI choice, so all of its states stick per
-- repository -- not only "a provider was picked".
--
-- Both dropdowns are preselected from the repository's task history (GET /tasks/last-cli),
-- and both derived that from the FK columns alone. A NULL FK cannot say whether the user
-- chose nothing or never chose, so "(none -- deterministic steps only)" and the summary
-- dropdown's "(inherit)" were unrememberable: the summary picker reset to inherit on every
-- task. Three other paths also insert tasks and never state either choice (upgrade rollback,
-- the plan spawner, kb_author), so they all land on the same defaults as a deliberate
-- inherit -- which is exactly the ambiguity these flags remove.
--
-- Two flags, not a new enum: (summary_cli_provider_id, summary_llm_enabled) already encodes
-- all three summary states and the FK still carries the value. The only missing bit was
-- whether a human put it there. Per dropdown rather than one flag, because POST /tasks can
-- name one field without the other.
--
-- NO BACKFILL, deliberately. The read admits recorded rows OR legacy rows carrying today's
-- evidence and orders flag-first:
--   ... AND (cli_choice_recorded OR cli_provider_id IS NOT NULL)
--   ORDER BY cli_choice_recorded DESC, created_at DESC LIMIT 1
-- so an install with only pre-change rows preselects exactly what it does today, and the
-- first task created through the form afterwards wins permanently. An UPDATE here would not
-- run anyway: this directory is a parity record and the applier is `drizzle-kit push --force`
-- (the db-migrate service, `pnpm docker migrate`), which syncs DDL only.
--
-- Additive and idempotent. The columns are also declared in `schema/tasks.ts`, so push
-- reaches the same state on an environment that never sees this file.
--
-- Rollback: remove `cliChoiceRecorded` / `summaryCliChoiceRecorded` from `schema/tasks.ts`,
-- revert the create-task handler, the /last-cli route and the New Task form, and
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "cli_choice_recorded";
--   ALTER TABLE "tasks" DROP COLUMN IF EXISTS "summary_cli_choice_recorded";
-- Nothing else reads them and no existing column changes meaning, so the reverted code
-- preselects as it does now whether or not the columns are dropped.
ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "cli_choice_recorded" boolean NOT NULL DEFAULT false;

ALTER TABLE "tasks"
  ADD COLUMN IF NOT EXISTS "summary_cli_choice_recorded" boolean NOT NULL DEFAULT false;
