-- Additive authoring choices. Existing tasks/pins are never rewritten.
ALTER TABLE task_type_definitions ADD COLUMN IF NOT EXISTS data_role_bindings jsonb;
