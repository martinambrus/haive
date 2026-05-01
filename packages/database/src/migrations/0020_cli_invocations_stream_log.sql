-- Full terminal transcript for a CLI invocation: command header + every
-- stdout/stderr chunk + exit annotation. Captured live in the worker as
-- chunks are published to the Redis cli-stream so the persisted log matches
-- what the user saw in the live terminal viewer. Distinct from raw_output,
-- which holds the parsed CLI result text (e.g. claude-code stream-json's
-- final result event payload) and is consumed by the step engine. The
-- inline per-step terminal in the UI prefers stream_log when present and
-- falls back to raw_output for rows written before this column existed.

ALTER TABLE "cli_invocations" ADD COLUMN "stream_log" text;
