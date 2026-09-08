-- Append-only audit trail for security-sensitive mutations (git credential
-- create/update/delete, admin user actions). No foreign keys: rows must outlive
-- the user/credential they reference. Idempotent (safe to re-run).
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  action varchar(64) NOT NULL,
  target_type varchar(64) NOT NULL,
  target_id uuid,
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_user_id);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_id);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action);
