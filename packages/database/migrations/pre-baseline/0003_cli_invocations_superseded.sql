-- Preserve forensic trail on step retry.
-- Retry used to hard-delete prior cli_invocations rows for the step, destroying raw_output/parsed_output.
-- Now retries stamp superseded_at instead; step-runner filters rows where superseded_at IS NULL for "latest".

ALTER TABLE cli_invocations ADD COLUMN superseded_at timestamp;
