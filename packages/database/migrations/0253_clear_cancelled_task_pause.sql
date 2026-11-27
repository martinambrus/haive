-- Older cancellation paths could commit before clearing a pause, permanently retaining scratch.
-- Failed tasks may still be paused for recovery; repair cancelled tasks alone. Do not restamp
-- updated_at: it paces cancelled-teardown recovery. Idempotent and independent of finish events.
UPDATE tasks SET paused_at = NULL WHERE status = 'cancelled' AND paused_at IS NOT NULL;
