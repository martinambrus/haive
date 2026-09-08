-- Per-CLI interactive login state + sandbox login containers.
-- Adds auth probe status tracking on cli_providers and lets containers
-- serve a 'cli_login' purpose keyed to a cli_provider instead of a task.

CREATE TYPE cli_auth_status AS ENUM (
  'unknown',
  'ok',
  'auth_expired',
  'auth_denied',
  'rate_limited',
  'network_error',
  'timeout',
  'unknown_error'
);

CREATE TYPE container_purpose AS ENUM ('task', 'cli_login');

ALTER TABLE cli_providers
  ADD COLUMN auth_status cli_auth_status NOT NULL DEFAULT 'unknown',
  ADD COLUMN auth_last_checked_at timestamp,
  ADD COLUMN auth_message text;

ALTER TABLE containers
  ADD COLUMN purpose container_purpose NOT NULL DEFAULT 'task',
  ADD COLUMN cli_provider_id uuid REFERENCES cli_providers(id) ON DELETE CASCADE,
  ALTER COLUMN task_id DROP NOT NULL;

CREATE INDEX containers_cli_provider_id_idx ON containers(cli_provider_id);
