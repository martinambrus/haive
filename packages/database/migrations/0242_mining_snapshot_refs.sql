-- Inert, host-issued committed snapshot identities. NULL/NULL retains live-checkout semantics.
-- Keep both columns last, in the same order as the Drizzle declaration; no defaults or backfill.
ALTER TABLE task_step_agent_minings
  ADD COLUMN IF NOT EXISTS snapshot_ref jsonb,
  ADD COLUMN IF NOT EXISTS base_snapshot_ref jsonb;
