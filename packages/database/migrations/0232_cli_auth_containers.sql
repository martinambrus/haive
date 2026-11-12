-- Rollback only after confirming every recorded container is gone:
-- DROP TABLE IF EXISTS cli_auth_containers;
CREATE TABLE IF NOT EXISTS cli_auth_containers (
  docker_container_id varchar(255) PRIMARY KEY,
  scope varchar(255) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cli_auth_containers_scope_idx ON cli_auth_containers (scope);
