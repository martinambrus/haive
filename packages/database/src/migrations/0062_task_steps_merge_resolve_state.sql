-- Persisted state machine for the merge-resolution phase (resolveMergePhase) on the
-- 12-worktree-cleanup step — the analogue of task_dag_levels.merge_state. Holds the
-- merge mode/phase, the base + feature branches, the merge dirs, the in-flight fix
-- invocation id, the auto-retry count, a pending user clarification, and the
-- push-after-merge choice, so a crash + redelivery resumes the merge from the
-- persisted phase reconciled with on-disk git state. Idempotent + additive.
ALTER TABLE "task_steps" ADD COLUMN IF NOT EXISTS "merge_resolve_state" jsonb;

-- Rollback:
-- ALTER TABLE "task_steps" DROP COLUMN IF EXISTS "merge_resolve_state";
