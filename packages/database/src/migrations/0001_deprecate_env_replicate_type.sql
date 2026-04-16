-- Migrate existing env_replicate tasks to workflow type.
-- The 'env_replicate' enum value stays in Postgres (cannot easily drop enum values)
-- but is no longer used for new rows. Env-replicate steps now run as a mandatory
-- prelude for all workflow tasks.

UPDATE tasks
SET type = 'workflow',
    metadata = jsonb_set(
      COALESCE(metadata, '{}'),
      '{migratedFromEnvReplicate}',
      'true'
    ),
    updated_at = NOW()
WHERE type = 'env_replicate';
