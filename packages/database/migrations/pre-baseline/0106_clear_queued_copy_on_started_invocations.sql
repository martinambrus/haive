-- Repair invocations that started but kept their "Queued — machine at capacity" label.
--
-- enqueueCliInvocation (worker task-queue.ts) marks an invocation as queued AFTER calling
-- queue.add, so when a slot is free enough for the worker to pick the job up immediately, the
-- run-start write ("Waiting for AI analysis...") lands FIRST and the queued mark then clobbers it.
-- A running CLI therefore advertised itself as still waiting for a slot: task 38f02dee showed
-- `running` in the listing while its own terminal banner read "Queued — machine at capacity
-- (2 parallel slots)". The step row and the park marker were both correct — only this copy lied.
--
-- The live-logic fix guards that mark on `started_at IS NULL` (the structural column). This
-- migration repairs the rows already written. It has to match on the message text because that
-- string IS the corruption signature — there is no other way to identify the affected rows — and
-- the pattern avoids the em dash so encoding cannot make it silently match nothing.
--
--   started + still running  -> the value the run-start write intended, so the live banner reads
--                              correctly until the status updater refines it
--   started + ended         -> NULL; the real last status is unknown and no banner renders for a
--                              finished invocation anyway, so a stale "queued" label is pure noise
--
-- Data-only + idempotent: re-running matches nothing once the text is gone. Invocations that never
-- started keep their queued label, which is exactly what it is for.

UPDATE "cli_invocations"
SET "status_message" = CASE
    WHEN "ended_at" IS NULL THEN 'Waiting for AI analysis...'
    ELSE NULL
  END
WHERE "started_at" IS NOT NULL
  AND "status_message" LIKE 'Queued%machine at capacity%';
