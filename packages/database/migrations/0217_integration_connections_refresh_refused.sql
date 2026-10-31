-- When the provider's OAuth client last refused a refresh. That refusal keeps the status `connected`
-- (fixing the client heals every connection), so this column, not the words in last_error, says
-- the words are current; the next refresh that succeeds and a sign-in clear it. NULL: nothing refused.
-- Additive and idempotent. Undo: ALTER TABLE integration_connections DROP COLUMN IF EXISTS refresh_refused_at;
-- (a connected row then shows no refusal, as it did before.)
ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS refresh_refused_at timestamp;
