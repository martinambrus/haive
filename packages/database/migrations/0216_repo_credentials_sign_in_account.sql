-- The Git credential a provider sign-in made records the provider's id for that account, so a later
-- sign-in to the same account on the same host takes it back instead of adding a second one. NULL for
-- a credential typed by hand, which a sign-in never rewrites. The backfill marks the credentials that
-- back a signed-in connection today; one a disconnect left behind earlier cannot be told from a
-- hand-typed one and stays unmarked.
-- Additive and idempotent. Undo: ALTER TABLE repo_credentials DROP COLUMN IF EXISTS sign_in_account_id;
-- (a later sign-in to an account then adds a credential again, as it did before.)
ALTER TABLE repo_credentials ADD COLUMN IF NOT EXISTS sign_in_account_id text;
UPDATE repo_credentials AS credential
   SET sign_in_account_id = connection.external_account_id
  FROM integration_connections AS connection
 WHERE connection.repo_credential_id = credential.id
   AND connection.external_account_id IS NOT NULL
   AND credential.sign_in_account_id IS NULL;
