-- A rescan of a repository that already had a plan recorded "repository already has a plan" as an
-- import error. That is not an error and is no longer recorded; clear the copies already stored.
-- Data-only and idempotent: a second run matches nothing.
UPDATE plan_mirror_state
SET last_error = NULL
WHERE last_error = 'Plan snapshot not imported: repository already has a plan';
