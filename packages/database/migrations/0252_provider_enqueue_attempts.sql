-- API compensation fences are independent for image builds and model provisioning.
-- Additive; older images can ignore these nullable columns on rollback.
ALTER TABLE "cli_providers" ADD COLUMN IF NOT EXISTS "sandbox_image_enqueue_id" uuid;
ALTER TABLE "cli_providers" ADD COLUMN IF NOT EXISTS "model_provision_enqueue_id" uuid;
