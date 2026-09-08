-- Clear park copy off pending rows whose park is already over.
--
-- The runtime-slot park writes its queue line to task_steps.status_message and its wait to
-- waiting_started_at. Closing a park folds the marker into idle_ms but used to leave the line
-- behind, and the task page rendered the amber "waiting for a free runtime slot" banner from the
-- MESSAGE alone — so a step nothing was driving showed a second live-looking queue banner beside
-- the real one (reported on bf88b9a5: 06a-db-migrate next to the genuine 07-phase-2-implement
-- park). The web panel now keys on the marker and the fold clears the copy at the source; this
-- clears the rows that already carry an orphan line.
--
-- Marker-less by definition: a row still holding waiting_started_at is genuinely parked and keeps
-- its line. Restricted to `pending`, which holds no durable status_message — a park/queue note is
-- the only thing such a row ever carries (same reasoning as 0102).
--
-- Data-only + idempotent: re-running matches nothing once cleared, and a step that is really
-- parked rewrites its own line within one poll (15s).

UPDATE "task_steps"
SET "status_message" = NULL
WHERE "status" = 'pending'
  AND "waiting_started_at" IS NULL
  AND "status_message" IS NOT NULL;
