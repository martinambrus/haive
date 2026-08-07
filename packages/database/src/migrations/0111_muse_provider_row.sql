-- Re-point existing Meta Muse providers from the claude-code adapter onto the
-- new `muse` adapter added in 0110.
--
-- Why this is a migration and not a UI change: PATCH /cli-providers/:id rejects
-- name changes outright (`name_immutable`), so the row cannot be re-pointed from
-- the settings page without deleting and recreating it — which would drop its id,
-- its encrypted ANTHROPIC_AUTH_TOKEN secret and its env_vars.
--
-- Three columns move together:
--   name         claude-code -> muse    (so the muse effort scale applies)
--   effort_level *           -> xhigh   (claude-code's default `max` is rejected
--                                        by api.meta.ai with a 400; xhigh is the
--                                        highest level Muse accepts)
--   auth_mode    *           -> api_key (the muse catalog entry declares
--                                        defaultAuthMode 'api_key', and
--                                        assertAuthModeSupported() then rejects
--                                        'subscription', making the row
--                                        unsaveable from the UI otherwise)
--
-- MUST run in a separate transaction from 0110: Postgres refuses to use an enum
-- value that was added earlier in the same transaction ("unsafe use of new value
-- of enum type"), so combining the two files fails.
--
-- Idempotent: guarded on name = 'claude-code', which no longer matches once the
-- row has been migrated. Keyed on the base URL rather than a specific provider
-- id so it applies on every environment that hit this.
--
-- Rollback (restores the pre-migration adapter; note effort_level goes back to
-- 'xhigh', NOT 'max' — 'max' is the value that caused the original 400, and
-- claude-code's scale accepts 'xhigh' too, so the row keeps working):
--   UPDATE cli_providers
--      SET name = 'claude-code', auth_mode = 'subscription',
--          effort_level = 'xhigh', updated_at = now()
--    WHERE name = 'muse';
--   -- run this BEFORE 0110's enum rollback, which fails while any row uses 'muse'
UPDATE cli_providers
   SET name = 'muse',
       auth_mode = 'api_key',
       effort_level = 'xhigh',
       updated_at = now()
 WHERE name = 'claude-code'
   AND env_vars->>'ANTHROPIC_BASE_URL' LIKE '%api.meta.ai%';
