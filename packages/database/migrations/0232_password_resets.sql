-- Rollback: revert the application commits; this unused table is harmless. Drop it only in a
-- later migration if recovery history is no longer needed.
CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "claim_email_encrypted" text,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_token_hash_unique" UNIQUE ("token_hash");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "password_resets_user_id_idx" ON "password_resets" ("user_id");
