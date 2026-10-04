-- Assignment is known at dispatch, before execution/tool-usage capture. Keep it
-- available to queued and running terminal headers without claiming observed usage.
ALTER TABLE cli_invocations ADD COLUMN IF NOT EXISTS assigned_agent_ids text[];

-- Only recover assignments that were actually recorded, never infer them from
-- prose, file paths, work-item titles, or the current repository's profiles.
UPDATE cli_invocations
SET assigned_agent_ids = ARRAY(
  SELECT jsonb_array_elements_text(tool_usage #> '{agents,assigned}')
)
WHERE assigned_agent_ids IS NULL
  AND jsonb_typeof(tool_usage #> '{agents,assigned}') = 'array';
