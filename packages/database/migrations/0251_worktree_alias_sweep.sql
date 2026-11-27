-- Trusted completion marker for the one-time, resumable legacy worktree alias sweep.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS worktree_aliases_swept_at timestamp;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS worktree_alias_scan jsonb;
CREATE TABLE IF NOT EXISTS worktree_alias_names (
  repository_id uuid NOT NULL,
  path text NOT NULL,
  dev text NOT NULL,
  ino text NOT NULL,
  CONSTRAINT worktree_alias_names_repository_id_path_pk PRIMARY KEY (repository_id, path),
  CONSTRAINT worktree_alias_names_repository_id_repositories_id_fk
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
