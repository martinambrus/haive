-- Drop the dead repositories.excluded_paths / selected_paths columns.
--
-- These were written at clone time (framework-detect computePathSelection) and by
-- the old top-level PATCH /repos/:id/exclusions editor, but NO scan/mining/RAG step
-- ever consumed them — they only round-tripped through the repos-page top-level
-- exclusion UI. Scope scoping is now owned entirely by scope_exclude_globs
-- (migration 0081), which the onboarding picker (06_7), the mining steps (08/09-qa/
-- 09_5), RAG population (10) + task-end reindex (11c/02), and the repos-page deep
-- tree editor all read/write. Their consumers have been migrated, so the columns
-- are removed.
--
-- Rollback: re-add as nullable jsonb — the data was cosmetic (never fed a scan), so
-- nothing recomputes from it and losing the old top-level exclusion prefs is safe:
--   ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "excluded_paths" jsonb;
--   ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "selected_paths" jsonb;
--
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "excluded_paths";
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "selected_paths";
