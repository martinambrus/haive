-- Undo (destructive to pending drain intent/cohorts): DROP TABLE module_drain_tasks;
-- ALTER TABLE modules DROP COLUMN draining_by, DROP COLUMN draining_at;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS draining_at timestamp;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS draining_by uuid;
CREATE TABLE IF NOT EXISTS module_drain_tasks (
  module_id text NOT NULL,
  task_id uuid NOT NULL,
  CONSTRAINT module_drain_tasks_module_id_modules_module_id_fk FOREIGN KEY (module_id) REFERENCES modules(module_id) ON DELETE CASCADE,
  CONSTRAINT module_drain_tasks_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT module_drain_tasks_module_id_task_id_pk PRIMARY KEY (module_id, task_id)
);
