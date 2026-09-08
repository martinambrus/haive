-- Deterministic form login for browser testing. Holds only the SHAPE of the login --
-- where it is, which fields to fill, and how to recognise success -- so that
-- browser-login.js can perform it inside the runner with no model involved.
--
-- The username and password are NOT here: they live in user_secrets under
-- `app_auth:<repository_id>:username` / `:password`. This row is read into prompts and
-- step outputs across the codebase, so a credential stored in it would leak by a dozen
-- routes; keeping it out is what lets the login stay invisible to every CLI provider.
--
-- Nullable with no default: absent means no app login is configured, which is the
-- correct state for every existing repository. Idempotent + additive.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "app_auth" jsonb;

-- Rollback (safe: nothing reads this column when it is absent, and the credentials it
-- points at are separate rows that a repository delete already cascades):
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "app_auth";
