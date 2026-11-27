-- Tie rebuild notices to their preparation, so a later ordinary refresh clears the copy.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS checkout_aside_job_id text;
