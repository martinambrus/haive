-- Latest refresh only; historical prices and FX rates are untouched.
-- Undo after reverting the readers/writer: DROP TABLE IF EXISTS refresh_runs;
CREATE TABLE IF NOT EXISTS refresh_runs (
  kind text PRIMARY KEY,
  run_id uuid NOT NULL,
  trigger text NOT NULL,
  started_at timestamp NOT NULL,
  finished_at timestamp,
  result jsonb
);
