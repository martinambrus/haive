-- An older Retry reset a refused fix-loop gate row to `pending` and kept its saved answer. A pass
-- writes nothing to a pending row (step-ownership.ts `owned()`), so the answer was never applied and
-- the stalled sweep re-drove the task for good. Drop the answer and stop the next pass at the form,
-- the state a current Retry leaves (`reofferGate`, api/src/lib/task-control.ts).
-- Only unparked `pending` rows: a done gate keeps its answer as the record of the decision, and a
-- `waiting_form` row is a refused answer the next Retry drops. updated_at is left alone, so the sweep
-- finds the idle row at once.
-- Data-only and idempotent: a healed row holds no answer, so a second run matches nothing.
-- Undo: the dropped answer is recorded nowhere else (`step.form_submitted` keeps only a field count),
-- so only a database backup from before this ran brings it back; the gate asks again. The flag alone
-- is one-shot, cleared when the gate parks.
UPDATE "task_steps"
SET "form_values" = NULL,
    "pause_form_on_retry" = true
WHERE "status" = 'pending'
  AND "waiting_started_at" IS NULL
  AND jsonb_typeof("form_values" -> 'fixLoopAction') = 'string';
