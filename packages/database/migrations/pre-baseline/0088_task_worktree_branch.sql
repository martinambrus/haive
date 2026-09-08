-- Durable per-task record of the feature worktree created by 01-worktree-setup.
--
-- removeTaskWorktree (the cancel reaper) located the worktree by reading
-- 01-worktree-setup's step `output`. A Retry that cascades over that step nulls the
-- output (_step-reset) but leaves the worktree on disk, so a later cancel found no
-- worktree, silently no-op'd, and leaked both the directory and its branch.
--
-- `worktree_path` already existed but was never written by any code path (dead
-- column, 0 populated rows); it is now the durable path record. `worktree_branch` is
-- new and carries the branch name so the reaper can delete a fully-merged branch
-- without re-deriving it from step output.
--
-- Both stay set on terminal tasks as an audit record. Legacy rows keep working: the
-- reaper falls back to the step output when these columns are null.
--
-- Additive + idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "worktree_path" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "worktree_branch" text;
