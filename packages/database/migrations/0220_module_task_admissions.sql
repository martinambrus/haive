-- Undo (destructive to known required module admission evidence): DROP TABLE module_task_admissions;
-- Reverting this evidence does not remove a task, account choice, grant or drain cohort.
CREATE TABLE IF NOT EXISTS module_task_admissions (
  module_id text NOT NULL,
  task_id uuid NOT NULL,
  CONSTRAINT module_task_admissions_module_id_modules_module_id_fk FOREIGN KEY (module_id) REFERENCES modules(module_id) ON DELETE CASCADE,
  CONSTRAINT module_task_admissions_task_id_tasks_id_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CONSTRAINT module_task_admissions_module_id_task_id_pk PRIMARY KEY (module_id, task_id)
);
