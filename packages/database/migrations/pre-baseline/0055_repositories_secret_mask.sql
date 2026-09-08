-- Secret-file masking (Tier 1, default on). The worker hides files matching the
-- secret deny-list (DEFAULT_SECRET_DENY_GLOBS plus secret_mask_deny_extend,
-- minus carve-outs and secret_mask_allow) from AI CLI agents by mounting empty
-- read-only files over them in the cli-exec sandbox. Untracked files only; the
-- running app (ddev/app-runner) still sees the real files. Idempotent + additive.
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "secret_mask_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "secret_mask_allow" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "secret_mask_deny_extend" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Rollback:
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "secret_mask_enabled";
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "secret_mask_allow";
-- ALTER TABLE "repositories" DROP COLUMN IF EXISTS "secret_mask_deny_extend";
