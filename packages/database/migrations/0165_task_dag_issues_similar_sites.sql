-- Places with the same code or defect that a DAG coder found and deliberately did NOT change,
-- reported for the person at gate 2 to decide on. One issue's coder can report more than once
-- (an advisor retry re-runs it, and the review loop's fix coders report too), so the executor
-- merges into this column rather than overwriting it.
--
-- Display only: nothing branches on it. Reverts with DROP COLUMN.
ALTER TABLE task_dag_issues ADD COLUMN IF NOT EXISTS similar_sites jsonb NOT NULL DEFAULT '[]'::jsonb;
