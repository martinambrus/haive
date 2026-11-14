-- Undo: revert the capture code first; a later migration may drop fix_test_blobs.
-- Reference-only task events remain harmless after that drop.
CREATE TABLE IF NOT EXISTS fix_test_blobs (
  task_id uuid NOT NULL,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL,
  content bytea,
  created_at timestamp NOT NULL DEFAULT now(),
  expired_at timestamp,
  CONSTRAINT fix_test_blobs_task_id_content_hash_pk PRIMARY KEY (task_id, content_hash)
);
ALTER TABLE fix_test_blobs ADD COLUMN IF NOT EXISTS manifest_gzip bytea;
DO $$ BEGIN
  ALTER TABLE fix_test_blobs ADD CONSTRAINT fix_test_blobs_task_id_tasks_id_fk
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- Replacing the experimental definition also handles an already-present broader index.
DROP INDEX IF EXISTS fix_test_blobs_expiry_idx;
CREATE INDEX IF NOT EXISTS fix_test_blobs_expiry_idx ON fix_test_blobs(created_at) WHERE expired_at IS NULL AND content IS NOT NULL;

-- Prior experimental event payloads must not keep serving file content or host paths.
-- Their references survive, with unavailable legacy content disclosed rather than copied
-- into the new store without the effective secret policy.
UPDATE task_events
SET payload = jsonb_build_object(
  'invocationId', payload->'invocationId', 'stepId', payload->'stepId',
  'pass', payload->'pass', 'round', payload->'round', 'epoch', payload->'epoch',
  'beforeEventId', payload->'beforeEventId', 'state', 'not captured',
  'reason', 'Legacy content removed; no policy-checked manifest.')
WHERE event_type IN ('fix_tests.before', 'fix_tests.after')
  AND (payload ? 'image' OR payload ? 'workspace' OR payload ? 'changes' OR payload ? 'manifest');
