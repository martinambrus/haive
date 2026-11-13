ALTER TABLE task_steps ADD COLUMN IF NOT EXISTS rerun_generation integer NOT NULL DEFAULT 0;
ALTER TABLE task_database_states ADD COLUMN IF NOT EXISTS decision_generation integer NOT NULL DEFAULT 0;

-- Old epochs cannot tell an upstream reset from recovery. Reoffer ambiguous legacy
-- decisions once instead of adopting a save from before an explicit reset.
UPDATE task_database_states s
SET decision_generation = -1
FROM tasks t
WHERE t.id = s.task_id
  AND s.decision_generation = 0
  AND s.decision_epoch IS DISTINCT FROM t.orchestration_epoch
  AND (s.outcome <> 'pending' OR s.candidate_snapshot_id IS NOT NULL OR s.export_error IS NOT NULL);
