-- rollback: DROP TABLE IF EXISTS "integration_calls"; DROP TABLE IF EXISTS "integration_category_preferences"; DROP TABLE IF EXISTS "integration_user_settings"; DROP TABLE IF EXISTS "integration_grants"; DROP TABLE IF EXISTS "integration_connections"; DROP TABLE IF EXISTS "integration_provider_configs"; DROP TYPE IF EXISTS "integration_call_outcome"; DROP TYPE IF EXISTS "integration_surface"; DROP TYPE IF EXISTS "integration_access"; DROP TYPE IF EXISTS "integration_grant_target"; DROP TYPE IF EXISTS "integration_connection_status"; DROP TYPE IF EXISTS "integration_connection_scope";

DO $$ BEGIN
  CREATE TYPE "public"."integration_connection_scope" AS ENUM('user', 'shared');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."integration_connection_status" AS ENUM('connected', 'needs_reauth', 'revoked', 'provider_unavailable');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."integration_grant_target" AS ENUM('task', 'repository');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."integration_access" AS ENUM('read', 'write');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."integration_surface" AS ENUM('mcp', 'rest');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."integration_call_outcome" AS ENUM('ok', 'refused', 'error');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "integration_provider_configs" (
  "provider_id" varchar(256) PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "oauth_client_id" text,
  "oauth_client_secret_encrypted" text,
  "encrypted_dek" text,
  "api_base_url" text,
  "updated_by" uuid,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "integration_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" varchar(256) NOT NULL,
  "scope" "integration_connection_scope" NOT NULL,
  "owner_user_id" uuid NOT NULL,
  "account_label" text NOT NULL,
  "external_account_id" text,
  "auth_method" varchar(16) NOT NULL,
  "granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "access_token_encrypted" text,
  "refresh_token_encrypted" text,
  "encrypted_dek" text,
  "expires_at" timestamp,
  "repo_credential_id" uuid,
  "write_enabled" boolean DEFAULT false NOT NULL,
  "status" "integration_connection_status" DEFAULT 'connected' NOT NULL,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "integration_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL,
  "target_kind" "integration_grant_target" NOT NULL,
  "task_id" uuid,
  "repository_id" uuid,
  "category_id" varchar(256),
  "tool_allow_list" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "integration_grants_target_check" CHECK (("target_kind" = 'task' AND "task_id" IS NOT NULL AND "repository_id" IS NULL) OR ("target_kind" = 'repository' AND "repository_id" IS NOT NULL AND "task_id" IS NULL))
);

CREATE TABLE IF NOT EXISTS "integration_user_settings" (
  "user_id" uuid NOT NULL,
  "provider_id" varchar(256) NOT NULL,
  "write_enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "integration_user_settings_user_id_provider_id_pk" PRIMARY KEY("user_id","provider_id")
);

CREATE TABLE IF NOT EXISTS "integration_category_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "category_id" varchar(256) NOT NULL,
  "provider_id" varchar(256) NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "integration_category_preferences_user_category_unique" UNIQUE NULLS NOT DISTINCT("user_id","category_id")
);

CREATE TABLE IF NOT EXISTS "integration_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid,
  "provider_id" varchar(256) NOT NULL,
  "task_id" uuid,
  "task_step_id" uuid,
  "cli_invocation_id" uuid,
  "tool" text NOT NULL,
  "access" "integration_access" NOT NULL,
  "surface" "integration_surface" NOT NULL,
  "outcome" "integration_call_outcome" NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "integration_provider_configs" ADD CONSTRAINT "integration_provider_configs_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_owner_user_id_users_id_fk"
    FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_repo_credential_id_repo_credentials_id_fk"
    FOREIGN KEY ("repo_credential_id") REFERENCES "public"."repo_credentials"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_connection_id_integration_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_grants" ADD CONSTRAINT "integration_grants_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_user_settings" ADD CONSTRAINT "integration_user_settings_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_category_preferences" ADD CONSTRAINT "integration_category_preferences_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_connection_id_integration_connections_id_fk"
    FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_task_id_tasks_id_fk"
    FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_task_step_id_task_steps_id_fk"
    FOREIGN KEY ("task_step_id") REFERENCES "public"."task_steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_calls" ADD CONSTRAINT "integration_calls_cli_invocation_id_cli_invocations_id_fk"
    FOREIGN KEY ("cli_invocation_id") REFERENCES "public"."cli_invocations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "integration_connections_owner_user_id_idx" ON "integration_connections" USING btree ("owner_user_id");
CREATE INDEX IF NOT EXISTS "integration_connections_provider_id_idx" ON "integration_connections" USING btree ("provider_id");
CREATE INDEX IF NOT EXISTS "integration_grants_task_id_idx" ON "integration_grants" USING btree ("task_id");
CREATE INDEX IF NOT EXISTS "integration_grants_repository_id_idx" ON "integration_grants" USING btree ("repository_id");
CREATE INDEX IF NOT EXISTS "integration_grants_connection_id_idx" ON "integration_grants" USING btree ("connection_id");
CREATE INDEX IF NOT EXISTS "integration_calls_task_id_idx" ON "integration_calls" USING btree ("task_id");
