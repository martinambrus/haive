-- Greenfield repositories: a `blank` repo source with no remote and no local tree.
--
-- The repo-queue INIT job creates the storage dir, `git init`s it and lands one
-- commit, so every downstream resolver (worktree setup, sandbox mounts, the
-- `.haive-data/` mirror, task attachments) sees a normal git repo.
--
-- Additive and idempotent. Rollback note: Postgres cannot remove an enum label,
-- so this one stays in place on a revert; an unused label is inert.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'repo_source' AND e.enumlabel = 'blank'
  ) THEN
    ALTER TYPE "repo_source" ADD VALUE 'blank';
  END IF;
END
$$;
