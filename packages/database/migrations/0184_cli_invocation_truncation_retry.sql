ALTER TABLE cli_invocations ADD COLUMN IF NOT EXISTS truncation_retry boolean NOT NULL DEFAULT false;
