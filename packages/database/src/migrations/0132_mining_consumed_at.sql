-- Wave-aware mining consumption marker for task_step_agent_minings.
--
-- A step whose apply() throws MiningWaveError re-runs apply after every wave with
-- the CUMULATIVE agent set. Steps that fold results into the database (the plan
-- builder) must not re-fold a wave it already folded — temp-ref node creation is
-- not idempotent — so the runner stamps every row apply() has already seen with
-- consumed_at before dispatching the next wave, and apply() can ask for only the
-- unconsumed rows. A re-roll clears the marker so the fresh output re-applies.
--
-- Additive and idempotent. NULL = not yet folded (the state every existing row is
-- in, which is also the meaning 08c's fingerprint-dedupe fold has always relied
-- on — it ignores the column entirely).
ALTER TABLE "task_step_agent_minings"
  ADD COLUMN IF NOT EXISTS "consumed_at" timestamp;
