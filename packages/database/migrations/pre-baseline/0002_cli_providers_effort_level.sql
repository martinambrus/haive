-- Per-provider reasoning/effort knob (e.g. claude-code's CLAUDE_CODE_EFFORT_LEVEL).
-- NULL means "use the adapter's default top-of-scale effort", which preserves the
-- pre-migration behaviour where the worker hard-coded max effort for onboarding.
-- Adapters with no effort knob ignore this column entirely.

ALTER TABLE cli_providers ADD COLUMN effort_level text;
