-- Structural interactive suspension state.
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS checkout_session_reason text;
