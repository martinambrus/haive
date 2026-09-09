-- Invitations: how someone joins while registration is not open.
--
-- CONFIG_KEYS.REGISTRATION_MODE defaults to `closed`, which is the right default for a
-- self-hosted product and would otherwise leave an administrator no way to add anyone at all.
-- This table is the legitimate entry path: `invite` mode admits exactly the people holding an
-- unconsumed token, with the role the invite carries.
--
-- The token is stored HASHED, the same sha256 shape `refresh_tokens.token_hash` uses. The raw
-- value is returned to the admin once, at creation, and never persisted — so a database dump
-- hands out no working invite links. `token_hash` is UNIQUE, which is also what makes redeeming
-- a lookup rather than a scan.
--
-- `email_blind_index` is nullable because an invite is either bound to one address or a generic
-- link the admin passes on. It is a blind index rather than an address because that is the only
-- form this schema can compare: `users.email_encrypted` is encrypted, and the blind index is how
-- every other lookup in this database matches an email.
--
-- Three separate nullable timestamps rather than one status column, because they are three
-- different facts and a row can carry more than one: `revoked_at` is the admin cancelling it,
-- `consumed_at` is somebody using it, `expires_at` is time running out. A consumed invite is kept
-- rather than deleted — it is the evidence of how an account came to exist, which outlives any
-- value in reclaiming the row.
--
-- Both FKs are ON DELETE SET NULL, not CASCADE: deleting the admin who sent an invite must not
-- erase the record of the invite, and deleting a user must not erase how they joined.
--
-- Additive and idempotent. Rollback: revert `schema/auth.ts` and
--   DROP TABLE IF EXISTS "user_invites";
-- Nothing else references it, and registration falls back to the `open`/`closed` modes, which
-- never consult this table.

CREATE TABLE IF NOT EXISTS "user_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email_blind_index" varchar(64),
  "token_hash" text NOT NULL,
  "role" "user_role" DEFAULT 'user' NOT NULL,
  "created_by" uuid,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp,
  "consumed_at" timestamp,
  "consumed_by_user_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_token_hash_unique" UNIQUE ("token_hash");
EXCEPTION
  WHEN duplicate_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_invites" ADD CONSTRAINT "user_invites_consumed_by_user_id_users_id_fk"
    FOREIGN KEY ("consumed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "user_invites_email_blind_index_idx" ON "user_invites" ("email_blind_index");
CREATE INDEX IF NOT EXISTS "user_invites_created_at_idx" ON "user_invites" ("created_at");
