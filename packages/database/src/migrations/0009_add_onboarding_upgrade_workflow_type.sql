-- Add the 'onboarding_upgrade' variant to workflow_type so that
-- onboarding_upgrade tasks can be created. This value is used exclusively by
-- the onboarding-upgrade workflow introduced alongside the onboarding artifacts
-- registry (migration 0008). Existing onboarding tasks stay on type='onboarding'.

ALTER TYPE "workflow_type" ADD VALUE IF NOT EXISTS 'onboarding_upgrade';
