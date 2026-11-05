-- Undo: DROP TABLE IF EXISTS module_sources;
-- DELETE FROM system_secrets WHERE key LIKE 'module_source:%:token';
CREATE TABLE IF NOT EXISTS module_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  module_id text NOT NULL,
  url text,
  ref text,
  package_name text,
  version text,
  has_token boolean NOT NULL DEFAULT false,
  resolved_sha text,
  fetch_status text,
  fetched_at timestamp,
  last_error text,
  created_by uuid,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_sources_module_id_unique UNIQUE (module_id),
  CONSTRAINT module_sources_created_by_users_id_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT module_sources_kind_check CHECK (kind IN ('git', 'registry')),
  CONSTRAINT module_sources_module_id_check CHECK (module_id ~ '^[a-z0-9][a-z0-9-]{0,22}$'),
  CONSTRAINT module_sources_fields_check CHECK (
    (kind = 'git' AND url IS NOT NULL AND ref IS NOT NULL AND length(ref) > 0 AND package_name IS NULL AND version IS NULL)
    OR (kind = 'registry' AND url IS NULL AND ref IS NULL AND package_name IS NOT NULL AND package_name = '@haive-module/' || module_id AND version IS NOT NULL AND length(version) > 0)
  )
);
