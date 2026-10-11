-- Outbox for the cleanup a deleted repository leaves behind (RAG databases, runners, env images,
-- haive_repos files). The api wrote the repository delete and queued the two cleanup jobs after
-- the commit, so a crash or a Redis refusal in between lost them for good. The delete now records
-- each job here in its own transaction; the worker removes a row once its job has run and a sweep
-- re-queues the rest. No foreign key on repository_id: the repository row is already gone.
--
-- Additive and idempotent. Rollback: revert `schema/repos.ts` and
--   DROP TABLE IF EXISTS "repo_cleanups";
-- Cleanups queued but not yet run are then lost, as they were before this table existed.

CREATE TABLE IF NOT EXISTS "repo_cleanups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "repository_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_enqueued_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "repo_cleanups_kind_check" CHECK ("repo_cleanups"."kind" in ('rag', 'resources'))
);

CREATE INDEX IF NOT EXISTS "repo_cleanups_created_at_idx" ON "repo_cleanups" USING btree ("created_at");
