-- A sequencing reply rejected at apply left its agent row `done` with only an error, so every later
-- Order pass counted that group as asked. The step now marks such a row `failed`; this does the same
-- for the rows written before it. The error prefix is the only trace those rows carry.
-- Data-only and idempotent: a second run matches nothing.
UPDATE task_step_agent_minings AS m
SET status = 'failed', updated_at = now()
FROM task_steps AS ts
WHERE ts.id = m.task_step_id
  AND ts.step_id IN ('03-plan-sequence', '00-plan-sequence')
  AND m.status = 'done'
  AND m.error_message LIKE 'plan patch not applied:%';
