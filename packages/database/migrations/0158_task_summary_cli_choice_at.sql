-- When the summary-CLI choice on a task was last STATED, by the create form or by a later
-- edit on the task's CLIs tab. /tasks/last-cli orders remembered choices by this and falls
-- back to created_at where it is NULL, which is every existing row — so no backfill is
-- needed and they answer exactly as they did.
--
-- created_at is the wrong clock for an EDIT: repointing an older task's recap marked that row
-- recorded while any newer recorded task still won the ordering, so the New Task form restored
-- a stale value instead of the choice the user had just made.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS summary_cli_choice_at timestamp;
