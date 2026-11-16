-- NULL means unknown, including all historical and task-token-only queries. No backfill.
-- Rollback: revert application code; leave this additive column in place.
ALTER TABLE rag_query_log ADD COLUMN IF NOT EXISTS cli_invocation_id uuid;

DO $$ BEGIN
  ALTER TABLE rag_query_log
    ADD CONSTRAINT rag_query_log_cli_invocation_id_cli_invocations_id_fk
    FOREIGN KEY (cli_invocation_id) REFERENCES cli_invocations(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS rag_query_log_cli_invocation_id_idx ON rag_query_log (cli_invocation_id);
