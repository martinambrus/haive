-- Per-step hard-timeout override chosen by the user via "Retry with longer timeout".
--
-- A CLI killed at its budget used to be re-dispatched at the SAME budget (up to
-- MAX_ORPHAN_REDISPATCH times), so a pass that genuinely needed more time burned every
-- attempt and produced nothing. The worker now escalates the budget per consecutive
-- timeout, and this column is the manual escape hatch above that ladder: when set, the
-- step's next invocations run with exactly this many milliseconds instead.
--
-- Nullable with no default: NULL means "use the ladder", which is the state every
-- existing row must land in. The retry endpoint writes it alongside local_model_override
-- in the same update, so a plain Retry sets it back to NULL — there is no worker-side
-- clearing step to keep in sync.
--
-- Additive + idempotent: a second run is a no-op, and leaving the column in place after a
-- code revert is harmless (nothing reads it).

ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "cli_timeout_override_ms" integer;
