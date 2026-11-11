-- Stored static types used to require validation before reconciliation.
-- Move reconciliation immediately before validation; preserve every other relative order
-- and all pinned task snapshots.
-- Undo: restore step_ids, content_hash and updated_at from a pre-migration export for
-- the affected slugs. Do not reverse every new-order row: some were already correct.
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
SET step_ids = (
    SELECT jsonb_agg(value ORDER BY
      CASE WHEN ordinality::int - 1 = reconcile_at
        THEN validate_at + 0.5 ELSE ordinality END)
    FROM jsonb_array_elements(positions.step_ids) WITH ORDINALITY
  ),
  content_hash = NULL,
  updated_at = now()
FROM positions
WHERE definition.slug = positions.slug AND validate_at < reconcile_at;
