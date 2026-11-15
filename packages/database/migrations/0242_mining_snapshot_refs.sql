-- Inert, host-issued committed snapshot identities. NULL/NULL retains live-checkout semantics.
-- Keep both columns last, in the same order as the Drizzle declaration; no defaults or backfill.
-- Rollback: keep the columns and revert application code, which is safe only while every row and
-- queued job holds NULL refs. Once one holds a ref, an older worker would mount the live checkout,
-- and dropping the columns would lose the pin.
ALTER TABLE task_step_agent_minings
  ADD COLUMN IF NOT EXISTS snapshot_ref jsonb,
  ADD COLUMN IF NOT EXISTS base_snapshot_ref jsonb;
