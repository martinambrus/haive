-- Stored static types used to require validation before reconciliation.
-- Swap only that pair; leave every other position and all pinned task snapshots intact.
-- Undo: restore step_ids, content_hash and updated_at from a pre-migration export for
-- the affected slugs. Equivalently swap these two positions again for ONLY those slugs;
-- do not reverse rows that were already in the new order before this migration.
WITH positions AS (
  SELECT slug, step_ids,
    (SELECT ordinality::int - 1 FROM jsonb_array_elements_text(step_ids) WITH ORDINALITY
      WHERE value = '07b-phase-4-validate') AS validate_at,
    (SELECT ordinality::int - 1 FROM jsonb_array_elements_text(step_ids) WITH ORDINALITY
      WHERE value = '07c-ddev-reconcile') AS reconcile_at
  FROM task_type_definitions
  WHERE run_list_strategy = 'static'
    AND (source = 'admin' OR source LIKE 'module:%')
    AND jsonb_typeof(step_ids) = 'array'
    AND (SELECT count(*) FROM jsonb_array_elements_text(step_ids)
      WHERE value = '07b-phase-4-validate') = 1
    AND (SELECT count(*) FROM jsonb_array_elements_text(step_ids)
      WHERE value = '07c-ddev-reconcile') = 1
)
UPDATE task_type_definitions AS definition
SET step_ids = jsonb_set(
    jsonb_set(positions.step_ids, ARRAY[validate_at::text], '"07c-ddev-reconcile"'::jsonb),
    ARRAY[reconcile_at::text], '"07b-phase-4-validate"'::jsonb),
  content_hash = NULL,
  updated_at = now()
FROM positions
WHERE definition.slug = positions.slug AND validate_at < reconcile_at;
