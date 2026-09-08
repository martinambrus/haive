-- Marks a CLI invocation as dispatched in steering mode (Claude-family,
-- stream-json input). The api/web read it to show the steer box and the steer
-- endpoint 409s when false. Additive + idempotent.
ALTER TABLE "cli_invocations" ADD COLUMN IF NOT EXISTS "steerable" boolean NOT NULL DEFAULT false;

-- Rollback:
-- ALTER TABLE "cli_invocations" DROP COLUMN IF EXISTS "steerable";
