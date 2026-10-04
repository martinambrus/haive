-- Gate 2 persists its rendered form, so changing form() alone leaves an already parked
-- gate showing PASS for an unauthenticated 4xx. Repair only unsubmitted, genuinely
-- waiting gates. Keep recorded probe evidence and every human decision unchanged.
-- Data-only and idempotent: after the repair the smoke row is no longer a pass.
WITH affected AS (
  SELECT id, form_schema, detect_output,
    COALESCE(
      detect_output #>> '{browser,passed}' = 'true'
      AND detect_output #>> '{browser,skipped}' = 'false'
      AND COALESCE(detect_output #>> '{browser,verificationIncomplete}', 'false') = 'false'
      AND detect_output #>> '{browser,method}' IN ('mcp', 'interactive'),
      false
    ) AS browser_verified
  FROM task_steps
  WHERE step_id = '09-gate-2-verify-approval'
    AND status = 'waiting_form'
    AND waiting_started_at IS NOT NULL
    AND form_values IS NULL
    AND detect_output #>> '{runtimeSmoke,ran}' = 'true'
    AND detect_output #>> '{runtimeSmoke,passed}' = 'true'
    AND detect_output #>> '{runtimeSmoke,httpStatus}' ~ '^4[0-9]{2}$'
    AND jsonb_typeof(form_schema -> 'statusSummary') = 'array'
    AND jsonb_typeof(form_schema -> 'fields') = 'array'
    AND form_schema -> 'statusSummary' @> '[{"label":"Runtime smoke","status":"pass"}]'::jsonb
), repaired AS (
  SELECT id, jsonb_set(
    jsonb_set(form_schema, '{statusSummary}', (
      SELECT jsonb_agg(CASE
        WHEN item ->> 'label' = 'Runtime smoke' AND item ->> 'status' = 'pass'
        THEN item || jsonb_build_object(
          'status', 'warn', 'statusLabel', 'UNSURE',
          'detail', 'HTTP ' || (detect_output #>> '{runtimeSmoke,httpStatus}')
            || ' — runtime health could not be verified',
          'body', 'A 4xx response may be a login or access wall, or a broken route; this smoke cannot determine whether the app works. Verify the intended page in a browser before approving.'
            || CASE WHEN browser_verified
              THEN E'\n\nBrowser testing already passed, so this warning did not affect the gate default.'
              ELSE E'\n\nThis uncertain result does not pre-select Approve and does not trigger an automatic fix round.'
            END
            || E'\n\n## Response excerpt\n\n'
            || regexp_replace('    ' || COALESCE(detect_output #>> '{runtimeSmoke,errorExcerpt}', '(empty)'), E'\n', E'\n    ', 'g'),
          'defaultOpen', NOT browser_verified
        )
        ELSE item END ORDER BY ord)
      FROM jsonb_array_elements(form_schema -> 'statusSummary') WITH ORDINALITY AS rows(item, ord)
    )), '{fields}', (
      SELECT jsonb_agg(CASE
        WHEN NOT browser_verified AND field ->> 'id' = 'decision' AND field ->> 'default' = 'approve'
        THEN jsonb_set(field, '{default}', '"reject"'::jsonb)
        ELSE field END ORDER BY ord)
      FROM jsonb_array_elements(form_schema -> 'fields') WITH ORDINALITY AS fields(field, ord)
    )
  ) AS form_schema
  FROM affected
)
UPDATE task_steps SET form_schema = repaired.form_schema
FROM repaired WHERE task_steps.id = repaired.id;
