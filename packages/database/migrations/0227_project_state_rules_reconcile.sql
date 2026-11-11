-- Undo: ALTER TABLE project_state_outbox DROP COLUMN IF EXISTS rules_reconcile_intent;
ALTER TABLE project_state_outbox
  ADD COLUMN IF NOT EXISTS rules_reconcile_intent jsonb;
