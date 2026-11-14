-- Undo: revert the application commits; the unused table is harmless.
-- Drop the table only in a later numbered migration.
CREATE TABLE IF NOT EXISTS "plan_active_time" (
  "repository_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "hour_start" timestamp without time zone NOT NULL,
  "active_ms" integer NOT NULL DEFAULT 0,
  CONSTRAINT "plan_active_time_repository_id_user_id_hour_start_pk"
    PRIMARY KEY ("repository_id", "user_id", "hour_start"),
  CONSTRAINT "plan_active_time_repository_id_repositories_id_fk"
    FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE,
  CONSTRAINT "plan_active_time_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
