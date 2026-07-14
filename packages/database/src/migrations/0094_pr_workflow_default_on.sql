-- Make the per-repo PR close-out toggle default ON.
--
-- The global CONFIG_KEYS.PR_WORKFLOW_ENABLED switch is the real gate (staged
-- rollout, default off), so the per-repo flag is better as an opt-OUT: once an
-- admin enables the feature globally, every eligible repo (origin remote + a
-- credential with a forge provider) surfaces the create_pr action at step 12
-- without the user having to find the tooling-page toggle. 0093 shipped it
-- default false, which made the option undiscoverable.
--
-- Two parts:
--   1. Column default -> true (idempotent DDL; mirrors the authoritative Drizzle
--      schema, so `drizzle-kit push` stays a no-op after this).
--   2. One-time adoption backfill: enable it on repos created before the default
--      flipped. This is a deliberate one-time enablement, NOT re-run-idempotent
--      against later opt-outs — an operator who has repos intentionally turned
--      off should skip the UPDATE. On a fresh install the default alone suffices.

ALTER TABLE "repositories" ALTER COLUMN "pr_workflow_enabled" SET DEFAULT true;

UPDATE "repositories" SET "pr_workflow_enabled" = true WHERE "pr_workflow_enabled" = false;
