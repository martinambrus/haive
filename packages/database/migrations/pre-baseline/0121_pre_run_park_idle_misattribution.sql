-- Move a folded PRE-RUN park out of idle_ms and into carried_idle_ms.
--
-- A step parked before its run began (GLOBAL_PAUSE hold, runtime-slot admission park) is reset to
-- `pending` with started_at NULL, idle_ms 0 and a waiting_started_at marker. When work resumes,
-- step-runner.ts folded `now - marker` into idle_ms and stamped a FRESH started_at in the same
-- breath. computeStepContribution reads work as `span - idle_ms`, so idle that predates the new
-- span is subtracted from it: the step's work contribution clamps to 0 for exactly as long as the
-- park lasted, and the task page's global Work timer sits frozen while a CLI is visibly running.
--
-- Observed 2026-08-19: two tasks held by the same 30m35s global pause resumed at 15:09:26.97 with
-- idle_ms 2,152,459 / 2,152,496 against a span of minutes. The live fix folds a pre-run park into
-- carried_idle_ms instead (carried_* is added on top of the span, idle_ms is subtracted from it);
-- this repairs the rows already written.
--
-- Amounts are per-row and evidence-derived, not guessed: park = idle_ms minus the idle this run
-- genuinely accrued (waiting_form -> form_submitted, waiting_cli -> fold), each read off that
-- task's own task_events, and each cross-checks against the worker's "pause: parked step" log
-- cadence to the millisecond. Totals are unchanged — the time only moves between two columns.
--
-- Data-only + idempotent: the started_at anchor pins the exact run, and once repaired idle_ms
-- falls below the threshold so a re-run matches nothing.

UPDATE "task_steps"
SET "idle_ms" = "idle_ms" - 1835630,
    "carried_idle_ms" = "carried_idle_ms" + 1835630,
    "updated_at" = now()
WHERE "task_id" = '977e1c5a-0c36-4962-ad30-b9e747bbbfe2'
  AND "step_id" = '09_5-skill-generation'
  AND "round" = 0
  AND "started_at" = '2026-08-19 15:09:26.970'
  AND "idle_ms" >= 1835630;

UPDATE "task_steps"
SET "idle_ms" = "idle_ms" - 1835600,
    "carried_idle_ms" = "carried_idle_ms" + 1835600,
    "updated_at" = now()
WHERE "task_id" = '75122651-2485-4a7a-8a54-298583bc17ed'
  AND "step_id" = '09_5-skill-generation'
  AND "round" = 0
  AND "started_at" = '2026-08-19 15:09:26.971'
  AND "idle_ms" >= 1835600;
