-- One connection per account of a provider for an owner and scope, and one per Git credential;
-- a NULL account id or a NULL credential id is not constrained.
--
-- Additive and idempotent. Undo, which drops the two keys and no data:
--   DROP INDEX IF EXISTS "integration_connections_account_key_idx";
--   DROP INDEX IF EXISTS "integration_connections_repo_credential_key_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "integration_connections_account_key_idx" ON "integration_connections" USING btree ("scope","owner_user_id","provider_id","external_account_id") WHERE "integration_connections"."external_account_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connections_repo_credential_key_idx" ON "integration_connections" USING btree ("repo_credential_id") WHERE "integration_connections"."repo_credential_id" IS NOT NULL;
