-- One row per registered step, refreshed by the worker at boot; rollback: DROP TABLE IF EXISTS "step_catalog";
CREATE TABLE IF NOT EXISTS "step_catalog" (
  "step_id" varchar(256) PRIMARY KEY NOT NULL,
  "source" varchar(128) NOT NULL,
  "title" text NOT NULL,
  "workflow_type" varchar(128) NOT NULL,
  "dispatches_cli" boolean NOT NULL,
  "allow_skip" boolean NOT NULL,
  "provider_sensitive" boolean NOT NULL,
  "cli_roles" jsonb,
  "composable" boolean DEFAULT false NOT NULL,
  "entry" jsonb,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
