-- Per-repo RTK version pin (bare semver, e.g. "0.42.4"). NULL = use the Haive
-- default version baked into the composed-image runtime-tools layer. A set
-- value pins that rtk release for the repo's environment images. Idempotent +
-- additive.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "rtk_version" text;

-- Rollback:
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "rtk_version";
