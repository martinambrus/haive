-- Provider-outage watch: generalise the rate-limit-only allowance watch (0086/0092) so it
-- also covers a provider SERVER ERROR, and so the recovery notification can name the CLI.
-- Two nullable task columns back it:
--   awaiting_provider_reason records which fatal class armed the watch ('rate_limit' |
--   'server_error'), because the two recover by different evidence — a rate limit resolves
--   off the provider's usage window, while a 5xx resolves off a cool-off plus (for
--   usage-readable CLIs) a fresh OK usage snapshot. NULL on rows armed before this column
--   existed; the poller reads NULL as 'rate_limit', which is what those rows are.
--   awaiting_provider_since records the arm moment, which the server-error path needs to
--   require a snapshot fetched AFTER the failure (a stale OK snapshot proves nothing), to
--   hold the minimum cool-off, and to give up on a provider that never comes back.
-- Both nullable with no default, so existing tasks/fixtures are unaffected and a legacy
-- armed row keeps resolving through the unchanged rate-limit path.
-- Idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "awaiting_provider_reason" varchar(16);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "awaiting_provider_since" timestamp;
