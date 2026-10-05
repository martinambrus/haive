-- File inventory intentionally has no repository/user FK: retain it for file GC after deletion.
CREATE TABLE IF NOT EXISTS database_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_task_id uuid CONSTRAINT database_snapshots_source_task_id_tasks_id_fk REFERENCES tasks(id) ON DELETE SET NULL,
  source_task_title text NOT NULL,
  parent_snapshot_id uuid,
  status text NOT NULL DEFAULT 'writing',
  engine text NOT NULL,
  engine_version text,
  code_commit text,
  size_bytes bigint,
  sha256 text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS database_snapshots_repository_idx ON database_snapshots(repository_id);
CREATE TABLE IF NOT EXISTS repository_database_states (
  repository_id uuid PRIMARY KEY CONSTRAINT repository_database_states_repository_id_repositories_id_fk REFERENCES repositories(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  snapshot_id uuid CONSTRAINT repository_database_states_snapshot_id_database_snapshots_id_fk REFERENCES database_snapshots(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS task_database_states (
  task_id uuid PRIMARY KEY CONSTRAINT task_database_states_task_id_tasks_id_fk REFERENCES tasks(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL CONSTRAINT task_database_states_repository_id_repositories_id_fk REFERENCES repositories(id) ON DELETE CASCADE,
  base_revision integer NOT NULL,
  source_snapshot_id uuid CONSTRAINT task_database_states_source_snapshot_id_database_snapshots_id_fk REFERENCES database_snapshots(id) ON DELETE SET NULL,
  save_enabled boolean NOT NULL DEFAULT true,
  candidate_snapshot_id uuid CONSTRAINT task_database_states_candidate_snapshot_id_database_snapshots_id_fk REFERENCES database_snapshots(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'pending',
  imported_at timestamp,
  export_error text,
  decision_epoch integer,
  candidate_step_id uuid CONSTRAINT task_database_states_candidate_step_id_task_steps_id_fk REFERENCES task_steps(id) ON DELETE SET NULL
);
