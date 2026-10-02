-- Which Haive build inserted the run: commit:<sha>, tree:<sha>, release:<version> or unknown.
ALTER TABLE cli_invocations ADD COLUMN IF NOT EXISTS haive_build text;
