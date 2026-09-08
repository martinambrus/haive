-- Repo-level snapshot of the onboarding-derived ENVIRONMENT + TOOLING, so a
-- workflow task can resolve the repo's stack/tooling WITHOUT looking up the
-- onboarding task's step outputs — which don't exist after a fresh clone on
-- another machine (task rows + step outputs never leave the origin DB).
--
--   onboarding_environment: raw 01-env-detect `.data` + 02-detection-confirmation
--     confirmed values (shape @haive/shared OnboardingEnvironmentMirror). Written
--     by 02-detection-confirmation.apply. Consumed by loadRepoStackAnchors.
--   onboarding_tooling: the 04-tooling-infrastructure `output.tooling`
--     (ragMode, embeddingModel, ...; shape @haive/shared OnboardingToolingMirror).
--     Written by 04-tooling-infrastructure.apply. Consumed by resolveRagSyncPrefs.
--
-- Both are restored on clone from the committed `.haive-data/` mirror (tooling
-- minus machine-specific infra keys). NULL = fall back to the onboarding-task
-- lookup (repos onboarded before this column keep working, no backfill needed).
--
-- Additive + idempotent: safe to re-run on every environment via `drizzle-kit push`.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "onboarding_environment" jsonb;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "onboarding_tooling" jsonb;
